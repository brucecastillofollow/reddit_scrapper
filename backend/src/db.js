import pg from 'pg';
import { config } from './config.js';
import { buildPostsSchemaSql, buildCommentsSchemaSql } from './schema/redditFields.js';

const { Pool } = pg;

export const pool = new Pool({ connectionString: config.databaseUrl });

function buildInitSql(resetData) {
  return `
DROP TABLE IF EXISTS reddit_posts, scrape_runs, archive_records CASCADE;

${buildPostsSchemaSql({ reset: resetData })}

${buildCommentsSchemaSql({ reset: resetData })}

CREATE TABLE IF NOT EXISTS subreddit (
  name VARCHAR(128) PRIMARY KEY,
  last_timestamp TIMESTAMPTZ,
  interval_seconds INTEGER NOT NULL DEFAULT 600,
  last_poll_at TIMESTAMPTZ,
  total_posts INTEGER NOT NULL DEFAULT 0,
  new_posts INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE subreddit ALTER COLUMN last_timestamp DROP NOT NULL;
ALTER TABLE subreddit ADD COLUMN IF NOT EXISTS total_posts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subreddit ADD COLUMN IF NOT EXISTS new_posts INTEGER NOT NULL DEFAULT 0;
UPDATE subreddit SET last_timestamp = NULL WHERE last_poll_at IS NULL;

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

CREATE TABLE IF NOT EXISTS scrape_status (
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

ALTER TABLE scrape_status ADD COLUMN IF NOT EXISTS last_post_new INTEGER DEFAULT 0;
ALTER TABLE scrape_status ADD COLUMN IF NOT EXISTS last_post_existing INTEGER DEFAULT 0;
ALTER TABLE scrape_status ADD COLUMN IF NOT EXISTS last_post_total INTEGER DEFAULT 0;
ALTER TABLE scrape_status ADD COLUMN IF NOT EXISTS last_comment_subreddit VARCHAR(128);
ALTER TABLE scrape_status ADD COLUMN IF NOT EXISTS last_comment_new INTEGER DEFAULT 0;
ALTER TABLE scrape_status ADD COLUMN IF NOT EXISTS last_comment_existing INTEGER DEFAULT 0;
ALTER TABLE scrape_status ADD COLUMN IF NOT EXISTS last_comment_total INTEGER DEFAULT 0;
ALTER TABLE scrape_status ADD COLUMN IF NOT EXISTS session_posts_new BIGINT DEFAULT 0;
ALTER TABLE scrape_status ADD COLUMN IF NOT EXISTS session_comments_new BIGINT DEFAULT 0;
`;
}

export async function recordPostScrapeRun(stats) {
  const { new: added, existing, total } = stats;
  await pool.query(
    `UPDATE scrape_status SET
      last_post_new = $1,
      last_post_existing = $2,
      last_post_total = $3,
      session_posts_new = COALESCE(session_posts_new, 0) + $4::bigint
     WHERE id = 1`,
    [added, existing, total, added],
  );
}

export async function recordCommentScrapeRun(subreddit, stats) {
  const { new: added, existing, total } = stats;
  await pool.query(
    `UPDATE scrape_status SET
      last_comment_subreddit = $1,
      last_comment_new = $2,
      last_comment_existing = $3,
      last_comment_total = $4,
      session_comments_new = COALESCE(session_comments_new, 0) + $5::bigint
     WHERE id = 1`,
    [subreddit, added, existing, total, added],
  );
}

export async function initDb() {
  if (config.dbResetOnStart) {
    console.warn('[db] DB_RESET_ON_START=true — wiping posts and comments tables');
  }
  await pool.query(buildInitSql(config.dbResetOnStart));
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
