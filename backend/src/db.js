import pg from 'pg';
import { config } from './config.js';
import { buildPostsSchemaSql, buildCommentsSchemaSql } from './schema/redditFields.js';

const { Pool } = pg;

export const pool = new Pool({ connectionString: config.databaseUrl });

const SCHEMA = `
DROP TABLE IF EXISTS reddit_posts, scrape_runs, archive_records CASCADE;

${buildPostsSchemaSql()}

${buildCommentsSchemaSql()}

CREATE TABLE IF NOT EXISTS subreddit (
  name VARCHAR(128) PRIMARY KEY,
  last_timestamp TIMESTAMPTZ NOT NULL,
  interval_seconds INTEGER NOT NULL DEFAULT 600,
  last_poll_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS global (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_timestamp TIMESTAMPTZ NOT NULL DEFAULT (NOW() - INTERVAL '1 hour'),
  interval_seconds INTEGER NOT NULL DEFAULT 300,
  last_poll_at TIMESTAMPTZ
);

INSERT INTO global (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS global_ids (
  type VARCHAR(8) NOT NULL,
  data_id VARCHAR(20) NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (type, data_id)
);

CREATE INDEX IF NOT EXISTS ix_global_ids_timestamp ON global_ids (timestamp);

DROP TABLE IF EXISTS scrape_status CASCADE;

CREATE TABLE scrape_status (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  posts_running BOOLEAN DEFAULT FALSE,
  comments_running BOOLEAN DEFAULT FALSE,
  last_post_error TEXT,
  last_comment_error TEXT,
  last_post_finished_at TIMESTAMPTZ,
  last_comment_finished_at TIMESTAMPTZ,
  active_proxy_index INTEGER DEFAULT 0,
  proxies_healthy INTEGER DEFAULT 0
);

INSERT INTO scrape_status (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
`;

export async function initDb() {
  await pool.query(SCHEMA);
}

export async function getScrapeStatus() {
  const { rows } = await pool.query('SELECT * FROM scrape_status WHERE id = 1');
  return rows[0];
}

export async function updateScrapeStatus(fields) {
  const keys = Object.keys(fields);
  const values = Object.values(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  await pool.query(`UPDATE scrape_status SET ${sets} WHERE id = 1`, values);
}

export async function getGlobal() {
  const { rows } = await pool.query('SELECT * FROM global WHERE id = 1');
  return rows[0];
}

export async function updateGlobal(fields) {
  const keys = Object.keys(fields);
  const values = Object.values(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  await pool.query(`UPDATE global SET ${sets} WHERE id = 1`, values);
}
