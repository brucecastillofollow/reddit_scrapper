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

  bodyLimit: process.env.BODY_LIMIT || '10mb',

  databaseUrl: process.env.DATABASE_URL || 'postgresql://reddit:reddit@localhost:5432/reddit_scraper',

  scrapeFailureLog: process.env.SCRAPE_FAILURE_LOG || './data/logs/scrape-failures.log',

  scrapePostLog: process.env.SCRAPE_POST_LOG || './data/logs/post-scrape.log',

  retentionDays: num(process.env.RETENTION_DAYS, 30),

  redditUserAgent: process.env.REDDIT_USER_AGENT || 'reddit-scraper/1.0 (research project)',

  redditCookieDir: process.env.REDDIT_COOKIE_DIR || './data/cookies',

  redditCookiesFile: process.env.REDDIT_COOKIES_FILE || './data/reddit-cookies.json',

  redditCookieBootstrap: bool(process.env.REDDIT_COOKIE_BOOTSTRAP, true),
  redditCookieRequired: bool(process.env.REDDIT_COOKIE_REQUIRED, true),

  intervalMinSeconds: num(process.env.INTERVAL_MIN_SECONDS, 60),

  intervalMaxSeconds: num(process.env.INTERVAL_MAX_SECONDS, 3600),

  postScrapeIntervalSeconds: num(process.env.POST_SCRAPE_INTERVAL_SECONDS, 30),

  maxPaginationPages: num(process.env.MAX_PAGINATION_PAGES, 20),

  commentLookbackDays: num(process.env.COMMENT_LOOKBACK_DAYS, 30),

  commentWorkerCount: num(process.env.COMMENT_WORKER_COUNT, 32),

  commentIdleSleepSeconds: num(process.env.COMMENT_IDLE_SLEEP_SECONDS, 10),

  commentCoordinatorIntervalSeconds: num(process.env.COMMENT_COORDINATOR_INTERVAL_SECONDS, 60),

  commentScrapesPerMinute: num(process.env.COMMENT_SCRAPES_PER_MINUTE, 20),

  commentHotNewPostsMin: num(process.env.COMMENT_HOT_NEW_POSTS_MIN, 10),

  commentHotActivityMin: num(process.env.COMMENT_HOT_ACTIVITY_MIN, 100),

  commentTargetBatchSize: num(process.env.COMMENT_TARGET_BATCH_SIZE, 100),

  commentEfficiencyDays: num(process.env.COMMENT_EFFICIENCY_DAYS, 7),

  commentWeightHalfLifeMinutes: num(process.env.COMMENT_WEIGHT_HALF_LIFE_MINUTES, 360),

  proxyCooldownMinSeconds: num(process.env.PROXY_COOLDOWN_MIN_SECONDS, 2),

  proxyCooldownMaxSeconds: num(process.env.PROXY_COOLDOWN_MAX_SECONDS, 10),

  proxyDefaultIntervalSeconds: num(process.env.PROXY_DEFAULT_INTERVAL_SECONDS, 10),

  workerStartupStaggerSeconds: num(process.env.WORKER_STARTUP_STAGGER_SECONDS, 5),

  commentCoordinatorStartupDelaySeconds: num(

    process.env.COMMENT_COORDINATOR_STARTUP_DELAY_SECONDS,

    30,

  ),

  proxySkipAfterConsecutive403: num(process.env.PROXY_SKIP_AFTER_CONSECUTIVE_403, 3),

  proxyQuarantineMinutes: num(process.env.PROXY_QUARANTINE_MINUTES, 30),

  proxyCookieInvalidateAfter403: num(process.env.PROXY_COOKIE_INVALIDATE_AFTER_403, 3),

  proxyCookieKeepAfterSuccessMinutes: num(

    process.env.PROXY_COOKIE_KEEP_AFTER_SUCCESS_MINUTES,

    15,

  ),

  useDirect: bool(process.env.USE_DIRECT, true),

  dbResetOnStart: bool(process.env.DB_RESET_ON_START, false),

  proxyUrls: loadProxyUrls(),

  webshareProxyUrl: (process.env.WEBSHARE_PROXY_URL || '').trim(),

  webshareCommentEnabled: bool(process.env.WEBSHARE_COMMENT_ENABLED, true),

  webshareCommentIntervalSeconds: num(process.env.WEBSHARE_COMMENT_INTERVAL_SECONDS, 30),

  webshareCommentBatchSize: num(process.env.WEBSHARE_COMMENT_BATCH_SIZE, 250),

  webshareProxyCooldownMinSeconds: num(process.env.WEBSHARE_PROXY_COOLDOWN_MIN_SECONDS, 0),

  webshareProxyCooldownMaxSeconds: num(process.env.WEBSHARE_PROXY_COOLDOWN_MAX_SECONDS, 0),

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


