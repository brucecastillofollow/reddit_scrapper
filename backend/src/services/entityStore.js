import { pool } from '../db.js';
import { rowFromRedditPost, rowFromRedditComment } from '../schema/redditFields.js';
import { insertRow, updateRow } from '../schema/persistRow.js';

export function typedFieldsFromPost(data) {
  return rowFromRedditPost(data);
}

export function typedFieldsFromComment(data) {
  return rowFromRedditComment(data);
}

export async function postExists(dataId) {
  const { rows } = await pool.query('SELECT 1 FROM posts WHERE data_id = $1', [dataId]);
  return rows.length > 0;
}

export async function commentExists(dataId) {
  const { rows } = await pool.query('SELECT 1 FROM comments WHERE data_id = $1', [dataId]);
  return rows.length > 0;
}

export async function globalIdExists(type, dataId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM global_ids WHERE type = $1 AND data_id = $2',
    [type, dataId],
  );
  return rows.length > 0;
}

export async function insertGlobalId(type, dataId, timestamp) {
  await pool.query(
    `INSERT INTO global_ids (type, data_id, timestamp) VALUES ($1, $2, $3)
     ON CONFLICT (type, data_id) DO NOTHING`,
    [type, dataId, timestamp],
  );
}

export async function ensureSubreddit(name) {
  await pool.query(
    `INSERT INTO subreddit (name, last_timestamp, interval_seconds, total_posts, new_posts)
     VALUES ($1, NULL, $2, 0, 0)
     ON CONFLICT (name) DO NOTHING`,
    [name, 600],
  );
}

export async function recordSubredditNewPost(name) {
  await pool.query(
    `UPDATE subreddit SET total_posts = total_posts + 1, new_posts = new_posts + 1 WHERE name = $1`,
    [name],
  );
}

const SUBREDDIT_TASK_COLUMNS = `
  name, last_timestamp, interval_seconds, last_poll_at, total_posts, new_posts
`;

/**
 * Coordinator batch (up to 200 tasks): top by new_posts (reset counters), due scraped, never scraped.
 */
export async function buildCommentCoordinatorTasks(limits) {
  const { hot, due, never } = limits;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: hotRows } = await client.query(
      `SELECT ${SUBREDDIT_TASK_COLUMNS}
       FROM subreddit
       ORDER BY new_posts DESC, name
       LIMIT $1
       FOR UPDATE`,
      [hot],
    );

    const hotNames = hotRows.map((r) => r.name);
    if (hotNames.length > 0) {
      await client.query(`UPDATE subreddit SET new_posts = 0 WHERE name = ANY($1::varchar[])`, [
        hotNames,
      ]);
    }

    const { rows: dueRows } = await client.query(
      `SELECT ${SUBREDDIT_TASK_COLUMNS}
       FROM subreddit
       WHERE last_poll_at IS NOT NULL
         AND last_poll_at + (interval_seconds || ' seconds')::interval <= NOW()
       ORDER BY (last_poll_at + (interval_seconds || ' seconds')::interval) ASC, name
       LIMIT $1`,
      [due],
    );

    const { rows: neverRows } = await client.query(
      `SELECT ${SUBREDDIT_TASK_COLUMNS}
       FROM subreddit
       WHERE last_poll_at IS NULL
       ORDER BY new_posts DESC, total_posts DESC, name
       LIMIT $1`,
      [never],
    );

    await client.query('COMMIT');

    const seen = new Set();
    const tasks = [];

    for (const row of [...hotRows, ...dueRows, ...neverRows]) {
      if (seen.has(row.name)) continue;
      seen.add(row.name);
      tasks.push(row);
    }

    return { tasks, counts: { hot: hotRows.length, due: dueRows.length, never: neverRows.length } };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function insertPost(row) {
  await insertRow('posts', row);
}

export async function updatePost(row) {
  await updateRow('posts', row);
}

export async function insertComment(row) {
  await insertRow('comments', row);
}

export async function updateComment(row) {
  await updateRow('comments', row);
}

export async function updateSubreddit(name, fields) {
  const keys = Object.keys(fields);
  const values = Object.values(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await pool.query(`UPDATE subreddit SET ${sets} WHERE name = $1`, [name, ...values]);
}
