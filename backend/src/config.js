const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: num(process.env.PORT, 3001),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://reddit:reddit@localhost:5432/reddit_scraper',
  archiveDir: process.env.ARCHIVE_DIR || './data/archives',
  retentionDays: num(process.env.RETENTION_DAYS, 30),
  redditUserAgent: process.env.REDDIT_USER_AGENT || 'reddit-scraper/1.0 (research project)',
  intervalMinSeconds: num(process.env.INTERVAL_MIN_SECONDS, 60),
  intervalMaxSeconds: num(process.env.INTERVAL_MAX_SECONDS, 3600),
  intervalShrinkFactor: Number(process.env.INTERVAL_SHRINK_FACTOR) || 0.7,
  intervalGrowFactor: Number(process.env.INTERVAL_GROW_FACTOR) || 1.5,
  existingThreshold: num(process.env.EXISTING_THRESHOLD, 50),
  maxPaginationPages: num(process.env.MAX_PAGINATION_PAGES, 20),
  commentConcurrency: num(process.env.COMMENT_CONCURRENCY, 4),
  proxies: [
    process.env.PROXY_1,
    process.env.PROXY_2,
    process.env.PROXY_3,
    process.env.PROXY_4,
  ].filter((p) => p && p.trim()),
};
