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
    `INSERT INTO subreddit (name, last_timestamp, interval_seconds, total_posts, new_posts, total_comment, total_time)
     VALUES ($1, NULL, $2, 0, 0, 0, 0)
     ON CONFLICT (name) DO NOTHING`,
    [name, 600],
  );
}

/** After comment scrape: bump total_comment; widen first/last scraped; recompute total_time. */
export async function recordSubredditCommentScrape(name, { added, oldestTs, newestTs }) {
  const oldest = oldestTs instanceof Date ? oldestTs : oldestTs ? new Date(oldestTs) : null;
  const newest = newestTs instanceof Date ? newestTs : newestTs ? new Date(newestTs) : null;

  if (added <= 0 && !oldest && !newest) return;

  const { rows } = await pool.query(
    `SELECT first_scraped_at, last_scraped_at FROM subreddit WHERE name = $1`,
    [name],
  );
  const row = rows[0];
  if (!row) return;

  let first = row.first_scraped_at ? new Date(row.first_scraped_at) : null;
  let last = row.last_scraped_at ? new Date(row.last_scraped_at) : null;

  if (oldest && (!first || oldest < first)) first = oldest;
  if (newest && (!last || newest > last)) last = newest;

  let totalTime = 0;
  if (first && last) {
    totalTime = Math.max(0, Math.floor((last.getTime() - first.getTime()) / 1000));
  }

  await pool.query(
    `UPDATE subreddit SET
      total_comment = total_comment + $2,
      first_scraped_at = $3,
      last_scraped_at = $4,
      total_time = $5
     WHERE name = $1`,
    [name, added, first, last, totalTime],
  );
}

export async function recordSubredditNewPost(name) {
  await pool.query(
    `UPDATE subreddit SET total_posts = total_posts + 1, new_posts = new_posts + 1 WHERE name = $1`,
    [name],
  );
}

/** After a successful comment scrape — clears post backlog counter for this subreddit. */
export async function resetSubredditNewPosts(name) {
  await pool.query(`UPDATE subreddit SET new_posts = 0 WHERE name = $1`, [name]);
}

const SUBREDDIT_TASK_COLUMNS = `
  name, last_timestamp, interval_seconds, last_poll_at, total_posts, new_posts, total_comment
`;

async function fetchDueRows(client, { limit, exclude }) {
  if (limit <= 0) return [];
  const params = exclude.length > 0 ? [limit, exclude] : [limit];
  const excludeClause = exclude.length > 0 ? `AND name <> ALL($2::varchar[])` : '';
  const { rows } = await client.query(
    `SELECT ${SUBREDDIT_TASK_COLUMNS}
     FROM subreddit
     WHERE last_poll_at IS NOT NULL
       AND last_poll_at + (interval_seconds || ' seconds')::interval <= NOW()
       ${excludeClause}
     ORDER BY (last_poll_at + (interval_seconds || ' seconds')::interval) ASC,
              last_timestamp ASC NULLS FIRST,
              name
     LIMIT $1`,
    params,
  );
  return rows;
}

async function fetchNeverRows(client, { limit, exclude }) {
  if (limit <= 0) return [];
  const params = exclude.length > 0 ? [limit, exclude] : [limit];
  const excludeClause = exclude.length > 0 ? `AND name <> ALL($2::varchar[])` : '';
  const { rows } = await client.query(
    `SELECT ${SUBREDDIT_TASK_COLUMNS}
     FROM subreddit
     WHERE last_poll_at IS NULL
       ${excludeClause}
     ORDER BY name ASC
     LIMIT $1`,
    params,
  );
  return rows;
}

/**
 * Coordinator batch (up to batchSize per tick):
 * 1) Hot: new_posts > hotMin OR new_posts * total_comment / total_posts > activityMin
 * 2) Due: interval elapsed (last_poll_at + interval_seconds)
 * 3) Never scraped (oldest name first)
 * new_posts resets after successful comment scrape only.
 */
export async function buildCommentCoordinatorTasks({
  batchSize = 20,
  hotNewPostsMin = 10,
  hotActivityMin = 100,
} = {}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: hotCandidates } = await client.query(
      `SELECT ${SUBREDDIT_TASK_COLUMNS}
       FROM subreddit
       WHERE new_posts > $1
          OR (
            total_posts > 0
            AND (new_posts::float * total_comment::float / total_posts::float) > $2
          )
       ORDER BY
         GREATEST(
           new_posts::float,
           CASE
             WHEN total_posts > 0 THEN new_posts::float * total_comment::float / total_posts::float
             ELSE 0
           END
         ) DESC,
         new_posts DESC,
         name
       FOR UPDATE`,
      [hotNewPostsMin, hotActivityMin],
    );

    const hotRows =
      hotCandidates.length > batchSize ? hotCandidates.slice(0, batchSize) : hotCandidates;

    const exclude = hotRows.map((r) => r.name);
    let dueRows = [];
    let neverRows = [];

    const afterHot = batchSize - hotRows.length;
    if (afterHot > 0) {
      dueRows = await fetchDueRows(client, { limit: afterHot, exclude });
      exclude.push(...dueRows.map((r) => r.name));

      const afterDue = batchSize - hotRows.length - dueRows.length;
      if (afterDue > 0) {
        neverRows = await fetchNeverRows(client, { limit: afterDue, exclude });
      }
    }

    await client.query('COMMIT');

    const seen = new Set();
    const tasks = [];
    for (const row of [...hotRows, ...dueRows, ...neverRows]) {
      if (seen.has(row.name)) continue;
      seen.add(row.name);
      tasks.push(row);
    }

    return {
      tasks,
      counts: {
        hot: hotRows.length,
        due: dueRows.length,
        never: neverRows.length,
        hot_candidates: hotCandidates.length,
        batch_size: batchSize,
      },
    };
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
