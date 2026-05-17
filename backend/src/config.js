const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: num(process.env.PORT, 3001),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://reddit:reddit@localhost:5432/reddit_scraper',
  archiveDir: process.env.ARCHIVE_DIR || './data/archives',
  retentionDays: num(process.env.RETENTION_DAYS, 30),
  scrapeIntervalMinutes: num(process.env.SCRAPE_INTERVAL_MINUTES, 15),
  redditUserAgent: process.env.REDDIT_USER_AGENT || 'reddit-scraper/1.0 (research project)',
  searchQueries: (process.env.DEFAULT_SEARCH_QUERIES || 'python,technology,news')
    .split(',')
    .map((q) => q.trim())
    .filter(Boolean),
  proxies: [
    process.env.PROXY_1,
    process.env.PROXY_2,
    process.env.PROXY_3,
    process.env.PROXY_4,
  ].filter((p) => p && p.trim()),
};
