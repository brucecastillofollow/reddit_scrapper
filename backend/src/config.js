import './loadEnv.js';

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (v, fallback) => {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

export const config = {
  port: num(process.env.PORT, 3001),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://reddit:reddit@localhost:5432/reddit_scraper',
  archiveDir: process.env.ARCHIVE_DIR || './data/archives',
  scrapeFailureLog: process.env.SCRAPE_FAILURE_LOG || './data/logs/scrape-failures.log',
  scrapeCommentTimingLog:
    process.env.SCRAPE_COMMENT_TIMING_LOG || './data/logs/comment-scrape-timing.log',
  retentionDays: num(process.env.RETENTION_DAYS, 30),
  redditUserAgent: process.env.REDDIT_USER_AGENT || 'reddit-scraper/1.0 (research project)',
  intervalMinSeconds: num(process.env.INTERVAL_MIN_SECONDS, 60),
  intervalMaxSeconds: num(process.env.INTERVAL_MAX_SECONDS, 3600),
  intervalShrinkFactor: Number(process.env.INTERVAL_SHRINK_FACTOR) || 0.7,
  intervalGrowFactor: Number(process.env.INTERVAL_GROW_FACTOR) || 1.5,
  existingThreshold: num(process.env.EXISTING_THRESHOLD, 50),
  maxPaginationPages: num(process.env.MAX_PAGINATION_PAGES, 20),
  commentLookbackDays: num(process.env.COMMENT_LOOKBACK_DAYS, 30),
  commentConcurrency: num(process.env.COMMENT_CONCURRENCY, 4),
  commentIdleSleepSeconds: num(process.env.COMMENT_IDLE_SLEEP_SECONDS, 10),
  scrapeSleepSeconds: num(process.env.SCRAPE_SLEEP_SECONDS, 2),
  useDirect: bool(process.env.USE_DIRECT, true),
  dbResetOnStart: bool(process.env.DB_RESET_ON_START, false),
  proxyUrls: loadProxyUrls(),
};

function loadProxyUrls() {
  const list = (process.env.PROXY_LIST || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (list.length > 0) return list;

  return Object.keys(process.env)
    .filter((k) => /^PROXY_\d+$/i.test(k))
    .sort((a, b) => Number(a.split('_')[1]) - Number(b.split('_')[1]))
    .map((k) => process.env[k]?.trim())
    .filter(Boolean);
}
