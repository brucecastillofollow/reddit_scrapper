import { config } from '../config.js';
import { runCommentScrapeForSubreddit } from '../services/commentScraper.js';
import { buildWebshareCommentTasks, markSubredditForbidden } from '../services/entityStore.js';
import { runWithWebshareSlot } from '../services/proxyScrape.js';
import { isWebshareConfigured, warnWebshareProxyProtocol } from '../services/webshareProxy.js';
import { errorMessageWithProxy, logScrapeFailureFromError } from '../services/scrapeLogger.js';
import { setWebshareBatchActive } from '../services/commentPoolGate.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let poolStarted = false;
let batchRunning = false;
let lastBatchStats = null;

async function scrapeOneSubreddit(subRow, slot) {
  return runCommentScrapeForSubreddit(subRow, {
    runWithProxy: (fn) => runWithWebshareSlot(fn, slot),
  });
}

async function runWebshareBatch() {
  const { tasks, counts } = await buildWebshareCommentTasks({
    batchSize: config.webshareCommentBatchSize,
    hotActivityMin: config.commentHotActivityMin,
  });

  if (tasks.length === 0) {
    lastBatchStats = {
      at: new Date().toISOString(),
      tasks: 0,
      counts,
      ok: 0,
      failed: 0,
      forbidden: 0,
      duration_ms: 0,
    };
    return lastBatchStats;
  }

  const startedAt = Date.now();
  let ok = 0;
  let failed = 0;
  let forbidden = 0;

  const results = await Promise.allSettled(
    tasks.map((sub, slot) =>
      scrapeOneSubreddit(sub, slot).catch((err) => {
        throw err;
      }),
    ),
  );

  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    const sub = tasks[i];

    if (result.status === 'fulfilled') {
      ok += 1;
      continue;
    }

    const err = result.reason;
    const status = err?.response?.status ?? err?.status ?? null;

    if (status === 403 || status === 404) {
      forbidden += 1;
      await markSubredditForbidden(sub.name);
      console.warn(`[webshare-comment] r/${sub.name}: marked forbidden after ${status}`);
      continue;
    }

    failed += 1;
    await logScrapeFailureFromError('comments', err, {
      target: `r/${sub.name}/comments.json`,
      subreddit: sub.name,
      worker: 'webshare-batch',
    });
    console.error(`[webshare-comment] r/${sub.name}:`, errorMessageWithProxy(err));
  }

  const durationMs = Date.now() - startedAt;
  lastBatchStats = {
    at: new Date().toISOString(),
    tasks: tasks.length,
    counts,
    ok,
    failed,
    forbidden,
    duration_ms: durationMs,
  };

  console.log(
    `[webshare-comment] batch done ${ok}/${tasks.length} ok, ` +
      `failed=${failed}, forbidden=${forbidden}, ` +
      `never=${counts.never}, semi_hot=${counts.semi_hot}, ${durationMs}ms`,
  );

  return lastBatchStats;
}

async function webshareCommentLoop() {
  const intervalMs = config.webshareCommentIntervalSeconds * 1000;

  while (true) {
    const attemptStart = Date.now();

    if (!isWebshareConfigured()) {
      console.warn('[webshare-comment] WEBSHARE_PROXY_URL not set — waiting');
      await sleep(intervalMs);
      continue;
    }

    if (batchRunning) {
      await sleep(1000);
      continue;
    }

    batchRunning = true;
    if (config.websharePauseDbComments) setWebshareBatchActive(true);
    try {
      await runWebshareBatch();
    } catch (err) {
      console.error('[webshare-comment] batch error:', err.message);
    } finally {
      batchRunning = false;
      if (config.websharePauseDbComments) setWebshareBatchActive(false);
    }

    const elapsed = Date.now() - attemptStart;
    const wait = Math.max(0, intervalMs - elapsed);
    if (wait > 0) await sleep(wait);
  }
}

export function startWebshareCommentWorkerPool() {
  if (poolStarted) return;
  if (!config.webshareCommentEnabled) {
    console.log('[webshare-comment] disabled (WEBSHARE_COMMENT_ENABLED=false)');
    return;
  }

  poolStarted = true;
  warnWebshareProxyProtocol();
  webshareCommentLoop().catch((err) => console.error('[webshare-comment] fatal', err));

  console.log(
    `[webshare-comment] started: every ${config.webshareCommentIntervalSeconds}s, ` +
      `batch=${config.webshareCommentBatchSize}, cookies=${config.webshareUseRedditCookies ? 'dedicated/shared file' : 'bootstrap-only'}, ` +
      `pause_db=${config.websharePauseDbComments}`,
  );
}

export function getWebshareCommentWorkerStats() {
  return {
    enabled: config.webshareCommentEnabled,
    configured: isWebshareConfigured(),
    interval_seconds: config.webshareCommentIntervalSeconds,
    batch_size: config.webshareCommentBatchSize,
    semi_hot_ratio: [0.3, 0.8],
    hot_activity_min: config.commentHotActivityMin,
    batch_running: batchRunning,
    last_batch: lastBatchStats,
  };
}
