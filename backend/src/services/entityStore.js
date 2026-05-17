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
    `INSERT INTO subreddit (name, last_timestamp, interval_seconds)
     VALUES ($1, NOW() - INTERVAL '10 minutes', $2)
     ON CONFLICT (name) DO NOTHING`,
    [name, 600],
  );
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

const DUE_SUBREDDIT_WHERE = `
  last_poll_at IS NULL
  OR last_poll_at + (interval_seconds || ' seconds')::interval <= NOW()
`;

export async function countSubredditsDueForComments() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM subreddit WHERE ${DUE_SUBREDDIT_WHERE}`,
  );
  return rows[0].c;
}

export async function getSubredditsDueForComments(limit) {
  const { rows } = await pool.query(
    `SELECT name, last_timestamp, interval_seconds, last_poll_at
     FROM subreddit
     WHERE ${DUE_SUBREDDIT_WHERE}
     ORDER BY last_poll_at NULLS FIRST
     LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function getAllSubredditsDueForComments() {
  const { rows } = await pool.query(
    `SELECT name, last_timestamp, interval_seconds, last_poll_at
     FROM subreddit
     WHERE ${DUE_SUBREDDIT_WHERE}
     ORDER BY last_poll_at NULLS FIRST`,
  );
  return rows;
}

export async function updateSubreddit(name, fields) {
  const keys = Object.keys(fields);
  const values = Object.values(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await pool.query(`UPDATE subreddit SET ${sets} WHERE name = $1`, [name, ...values]);
}
