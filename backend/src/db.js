import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const pool = new Pool({ connectionString: config.databaseUrl });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reddit_posts (
  id SERIAL PRIMARY KEY,
  reddit_id VARCHAR(20) UNIQUE NOT NULL,
  title TEXT NOT NULL,
  subreddit VARCHAR(128) NOT NULL,
  author VARCHAR(128) NOT NULL,
  permalink TEXT NOT NULL,
  url TEXT NOT NULL,
  score INTEGER DEFAULT 0,
  num_comments INTEGER DEFAULT 0,
  created_utc TIMESTAMPTZ NOT NULL,
  search_query VARCHAR(256) NOT NULL,
  raw_data JSONB NOT NULL,
  scraped_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_reddit_posts_created ON reddit_posts (created_utc);
CREATE INDEX IF NOT EXISTS ix_reddit_posts_query ON reddit_posts (search_query);
CREATE INDEX IF NOT EXISTS ix_reddit_posts_query_created ON reddit_posts (search_query, created_utc);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id SERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status VARCHAR(32) DEFAULT 'running',
  query VARCHAR(256) NOT NULL,
  proxy_used VARCHAR(512),
  posts_fetched INTEGER DEFAULT 0,
  posts_inserted INTEGER DEFAULT 0,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS scrape_status (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  is_running BOOLEAN DEFAULT FALSE,
  last_started_at TIMESTAMPTZ,
  last_finished_at TIMESTAMPTZ,
  last_error TEXT,
  total_posts_in_db BIGINT DEFAULT 0,
  active_proxy_index INTEGER DEFAULT 0,
  proxies_healthy INTEGER DEFAULT 0
);

INSERT INTO scrape_status (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS archive_records (
  id SERIAL PRIMARY KEY,
  archive_date DATE UNIQUE NOT NULL,
  file_path TEXT NOT NULL,
  post_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
`;

export async function initDb() {
  await pool.query(SCHEMA);
}

export async function getStatusRow() {
  const { rows } = await pool.query('SELECT * FROM scrape_status WHERE id = 1');
  return rows[0];
}

export async function updateStatus(fields) {
  const keys = Object.keys(fields);
  const values = Object.values(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  await pool.query(`UPDATE scrape_status SET ${sets} WHERE id = 1`, values);
}

export async function refreshPostCount() {
  const { rows } = await pool.query('SELECT COUNT(*)::bigint AS c FROM reddit_posts');
  await updateStatus({ total_posts_in_db: rows[0].c });
}
