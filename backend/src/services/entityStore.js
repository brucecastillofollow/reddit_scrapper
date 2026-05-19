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

const SUBREDDIT_TASK_COLUMNS = `
  name, last_timestamp, interval_seconds, last_poll_at, total_posts, new_posts
`;

async function fetchDueAndNever(client, { dueLimit, neverLimit, exclude }) {
  let dueRows = [];
  let neverRows = [];

  if (dueLimit > 0) {
    const dueParams = exclude.length > 0 ? [dueLimit, exclude] : [dueLimit];
    const dueExclude = exclude.length > 0 ? `AND name <> ALL($2::varchar[])` : '';
    ({ rows: dueRows } = await client.query(
      `SELECT ${SUBREDDIT_TASK_COLUMNS}
       FROM subreddit
       WHERE last_poll_at IS NOT NULL
         AND last_poll_at + (interval_seconds || ' seconds')::interval <= NOW()
         ${dueExclude}
       ORDER BY (last_poll_at + (interval_seconds || ' seconds')::interval) ASC, name
       LIMIT $1`,
      dueParams,
    ));
  }

  if (neverLimit > 0) {
    const neverParams = exclude.length > 0 ? [neverLimit, exclude] : [neverLimit];
    const neverExclude = exclude.length > 0 ? `AND name <> ALL($2::varchar[])` : '';
    ({ rows: neverRows } = await client.query(
      `SELECT ${SUBREDDIT_TASK_COLUMNS}
       FROM subreddit
       WHERE last_poll_at IS NULL
         ${neverExclude}
       ORDER BY new_posts DESC, total_posts DESC, name
       LIMIT $1`,
      neverParams,
    ));
  }

  return { dueRows, neverRows };
}

function fillRemainderDueNever(client, batchSize, priorityRows) {
  const remainder = batchSize - priorityRows.length;
  if (remainder <= 0) {
    return { dueRows: [], neverRows: [] };
  }
  const dueLimit = Math.floor(remainder / 2);
  const neverLimit = remainder - dueLimit;
  return fetchDueAndNever(client, {
    dueLimit,
    neverLimit,
    exclude: priorityRows.map((r) => r.name),
  });
}

/**
 * Coordinator batch: up to batchSize subs per tick (default 20/min at 60s interval).
 * 1) Subs with new_posts > hotMin; if more than batchSize → top batchSize only.
 * 2) If none > hotMin → up to warmLimit subs with new_posts > warmMin.
 * 3) Fill remainder equally from due + never scraped.
 */
export async function buildCommentCoordinatorTasks({
  batchSize = 20,
  hotNewPostsMin = 10,
  warmNewPostsMin = 5,
  warmNewPostsLimit = 10,
} = {}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: hotCandidates } = await client.query(
      `SELECT ${SUBREDDIT_TASK_COLUMNS}
       FROM subreddit
       WHERE new_posts > $1
       ORDER BY new_posts DESC, name
       FOR UPDATE`,
      [hotNewPostsMin],
    );

    let hotRows = [];
    let warmRows = [];
    let dueRows = [];
    let neverRows = [];
    let warmCandidates = 0;

    if (hotCandidates.length > batchSize) {
      hotRows = hotCandidates.slice(0, batchSize);
    } else if (hotCandidates.length > 0) {
      hotRows = hotCandidates;
      ({ dueRows, neverRows } = await fillRemainderDueNever(client, batchSize, hotRows));
    } else {
      const { rows: warmCandidatesRows } = await client.query(
        `SELECT ${SUBREDDIT_TASK_COLUMNS}
         FROM subreddit
         WHERE new_posts > $1
         ORDER BY new_posts DESC, name
         FOR UPDATE`,
        [warmNewPostsMin],
      );
      warmCandidates = warmCandidatesRows.length;
      warmRows = warmCandidatesRows.slice(0, warmNewPostsLimit);
      ({ dueRows, neverRows } = await fillRemainderDueNever(client, batchSize, warmRows));
    }

    const resetNames = [...hotRows, ...warmRows].map((r) => r.name);
    if (resetNames.length > 0) {
      await client.query(`UPDATE subreddit SET new_posts = 0 WHERE name = ANY($1::varchar[])`, [
        resetNames,
      ]);
    }

    await client.query('COMMIT');

    const seen = new Set();
    const tasks = [];

    for (const row of [...hotRows, ...warmRows, ...dueRows, ...neverRows]) {
      if (seen.has(row.name)) continue;
      seen.add(row.name);
      tasks.push(row);
    }

    return {
      tasks,
      counts: {
        hot: hotRows.length,
        warm: warmRows.length,
        due: dueRows.length,
        never: neverRows.length,
        hot_candidates: hotCandidates.length,
        warm_candidates: warmCandidates,
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
