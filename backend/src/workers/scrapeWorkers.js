import { getGlobal } from '../db.js';
import { updateScrapeStatus } from '../db.js';
import { countHealthyProxies } from '../services/proxyPool.js';
import { runPostScrape } from '../services/postScraper.js';
import { startCommentWorkerPool, getCommentWorkerStats } from './commentWorkerPool.js';
import { errorMessageWithProxy, logScrapeFailureFromError } from '../services/scrapeLogger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let postRunning = false;

export function isPostScrapeRunning() {
  return postRunning;
}

export function getCommentQueueStatus() {
  return getCommentWorkerStats();
}

/** Single post-scrape loop (dedicated async worker). */
async function postWorkerLoop() {
  while (true) {
    try {
      const global = await getGlobal();
      const intervalMs = (global?.interval_seconds ?? 300) * 1000;
      const lastPoll = global?.last_poll_at ? new Date(global.last_poll_at).getTime() : 0;
      const elapsed = Date.now() - lastPoll;

      if (elapsed < intervalMs) {
        await sleep(Math.min(intervalMs - elapsed, 5000));
        continue;
      }

      if (postRunning) {
        await sleep(1000);
        continue;
      }

      postRunning = true;
      await updateScrapeStatus({ posts_running: true, last_post_error: null });

      await runPostScrape();
    } catch (err) {
      await logScrapeFailureFromError('posts', err, { target: 'new.json' });
      const msg = errorMessageWithProxy(err);
      console.error('[post-worker]', msg);
      await updateScrapeStatus({
        last_post_error: msg,
        last_post_finished_at: new Date(),
      });
    } finally {
      postRunning = false;
      await updateScrapeStatus({ posts_running: false });
    }
  }
}

async function proxyHealthLoop() {
  while (true) {
    try {
      const healthy = await countHealthyProxies();
      await updateScrapeStatus({ proxies_healthy: healthy });
    } catch {
      /* ignore */
    }
    await sleep(60000);
  }
}

export function startScrapeWorkers() {
  postWorkerLoop().catch((err) => console.error('[post-worker] fatal', err));
  //startCommentWorkerPool();
  proxyHealthLoop().catch(() => {});
  console.log('Scrape workers started: 1 post loop + comment coordinator/worker pool');
}

export async function triggerPostScrape() {
  if (postRunning) return false;
  postRunning = true;
  try {
    await updateScrapeStatus({ posts_running: true });
    await runPostScrape();
    return true;
  } finally {
    postRunning = false;
    await updateScrapeStatus({ posts_running: false });
  }
}
