import { pool } from '../db.js';
import { toTimestamp } from './redditFetch.js';

/** Map Reddit JSON values to typed columns (timestamp | text | number). */
export function typedFieldsFromPost(data) {
  return {
    data_id: String(data.id),
    fullname: data.name || `t3_${data.id}`,
    subreddit: data.subreddit || '',
    created_utc: toTimestamp(data),
    title: data.title ?? null,
    author: data.author ?? null,
    score: Number(data.score) || 0,
    num_comments: Number(data.num_comments) || 0,
    selftext: data.selftext ?? null,
    url: data.url ?? null,
    permalink: data.permalink ?? null,
    raw_data: data,
  };
}

export function typedFieldsFromComment(data) {
  return {
    data_id: String(data.id),
    fullname: data.name || `t1_${data.id}`,
    subreddit: data.subreddit || '',
    link_id: data.link_id ?? null,
    parent_id: data.parent_id ?? null,
    created_utc: toTimestamp(data),
    author: data.author ?? null,
    body: data.body ?? null,
    score: Number(data.score) || 0,
    raw_data: data,
  };
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
    `INSERT INTO subreddit (name, last_timestamp, interval_seconds)
     VALUES ($1, NOW() - INTERVAL '10 minutes', $2)
     ON CONFLICT (name) DO NOTHING`,
    [name, 600],
  );
}

export async function insertPost(fields) {
  await pool.query(
    `INSERT INTO posts (
      data_id, fullname, subreddit, created_utc, title, author, score,
      num_comments, selftext, url, permalink, raw_data
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      fields.data_id,
      fields.fullname,
      fields.subreddit,
      fields.created_utc,
      fields.title,
      fields.author,
      fields.score,
      fields.num_comments,
      fields.selftext,
      fields.url,
      fields.permalink,
      JSON.stringify(fields.raw_data),
    ],
  );
}

export async function updatePost(fields) {
  await pool.query(
    `UPDATE posts SET
      subreddit = $2, created_utc = $3, title = $4, author = $5, score = $6,
      num_comments = $7, selftext = $8, url = $9, permalink = $10,
      raw_data = $11, updated_at = NOW()
     WHERE data_id = $1`,
    [
      fields.data_id,
      fields.subreddit,
      fields.created_utc,
      fields.title,
      fields.author,
      fields.score,
      fields.num_comments,
      fields.selftext,
      fields.url,
      fields.permalink,
      JSON.stringify(fields.raw_data),
    ],
  );
}

export async function insertComment(fields) {
  await pool.query(
    `INSERT INTO comments (
      data_id, fullname, subreddit, link_id, parent_id, created_utc,
      author, body, score, raw_data
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      fields.data_id,
      fields.fullname,
      fields.subreddit,
      fields.link_id,
      fields.parent_id,
      fields.created_utc,
      fields.author,
      fields.body,
      fields.score,
      JSON.stringify(fields.raw_data),
    ],
  );
}

export async function updateComment(fields) {
  await pool.query(
    `UPDATE comments SET
      subreddit = $2, link_id = $3, parent_id = $4, created_utc = $5,
      author = $6, body = $7, score = $8, raw_data = $9, updated_at = NOW()
     WHERE data_id = $1`,
    [
      fields.data_id,
      fields.subreddit,
      fields.link_id,
      fields.parent_id,
      fields.created_utc,
      fields.author,
      fields.body,
      fields.score,
      JSON.stringify(fields.raw_data),
    ],
  );
}

export async function getSubredditsDueForComments(limit) {
  const { rows } = await pool.query(
    `SELECT name, last_timestamp, interval_seconds, last_poll_at
     FROM subreddit
     WHERE last_poll_at IS NULL
        OR last_poll_at + (interval_seconds || ' seconds')::interval <= NOW()
     ORDER BY last_poll_at NULLS FIRST
     LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function updateSubreddit(name, fields) {
  const keys = Object.keys(fields);
  const values = Object.values(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await pool.query(`UPDATE subreddit SET ${sets} WHERE name = $1`, [name, ...values]);
}
