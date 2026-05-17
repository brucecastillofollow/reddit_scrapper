import fs from 'fs/promises';
import path from 'path';
import { createWriteStream } from 'fs';
import archiver from 'archiver';
import { pool } from '../db.js';
import { config } from '../config.js';

function dateKey(d) {
  return d.toISOString().slice(0, 10);
}

async function zipDirectory(sourceDir, zipPath) {
  await fs.mkdir(path.dirname(zipPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

export async function archiveOldPosts() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - config.retentionDays);

  const { rows: dates } = await pool.query(
    `SELECT DISTINCT (created_utc AT TIME ZONE 'UTC')::date AS day
     FROM reddit_posts WHERE created_utc < $1 ORDER BY day`,
    [cutoff],
  );

  const archived = [];

  for (const { day } of dates) {
    const dayStr = dateKey(new Date(day));
    const { rows: existing } = await pool.query(
      'SELECT id FROM archive_records WHERE archive_date = $1',
      [day],
    );
    if (existing.length > 0) continue;

    const dayStart = new Date(`${dayStr}T00:00:00.000Z`);
    const dayEnd = new Date(`${dayStr}T23:59:59.999Z`);

    const { rows: posts } = await pool.query(
      `SELECT reddit_id, title, subreddit, author, permalink, url, score, num_comments,
              created_utc, search_query, raw_data, scraped_at
       FROM reddit_posts
       WHERE created_utc >= $1 AND created_utc <= $2
       ORDER BY created_utc`,
      [dayStart, dayEnd],
    );

    if (posts.length === 0) continue;

    const workDir = path.join(config.archiveDir, 'tmp', dayStr);
    const jsonPath = path.join(workDir, `${dayStr}.json`);
    const zipPath = path.join(config.archiveDir, `${dayStr}.zip`);

    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(jsonPath, JSON.stringify(posts, null, 2), 'utf8');
    await zipDirectory(workDir, zipPath);
    await fs.rm(workDir, { recursive: true, force: true });

    await pool.query(
      `INSERT INTO archive_records (archive_date, file_path, post_count)
       VALUES ($1, $2, $3) ON CONFLICT (archive_date) DO NOTHING`,
      [day, zipPath, posts.length],
    );

    await pool.query(
      'DELETE FROM reddit_posts WHERE created_utc >= $1 AND created_utc <= $2',
      [dayStart, dayEnd],
    );

    archived.push({ day: dayStr, count: posts.length, zipPath });
  }

  return archived;
}
