import { getGlobal } from '../db.js';
import { updateScrapeStatus } from '../db.js';
import { countHealthyProxies } from '../services/proxyPool.js';
import { runPostScrape } from '../services/postScraper.js';
import { runCommentScrapeBatch } from '../services/commentScraper.js';
import { errorMessageWithProxy, logScrapeFailureFromError } from '../services/scrapeLogger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let postRunning = false;
let commentRunning = false;

export function isPostScrapeRunning() {
  return postRunning;
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

/** Comment-scrape pool: processes due subreddits concurrently. */
async function commentWorkerLoop() {
  while (true) {
    try {
      if (commentRunning) {
        await sleep(20);
        continue;
      }

      commentRunning = true;
      await updateScrapeStatus({ comments_running: true, last_comment_error: null });
      await runCommentScrapeBatch();
    } catch (err) {
      await logScrapeFailureFromError('comments', err, { target: 'comment-batch' });
      const msg = errorMessageWithProxy(err);
      console.error('[comment-worker]', msg);
      await updateScrapeStatus({
        last_comment_error: msg,
        last_comment_finished_at: new Date(),
      });
    } finally {
      commentRunning = false;
      await updateScrapeStatus({ comments_running: false });
      await sleep(3000);
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
  commentWorkerLoop().catch((err) => console.error('[comment-worker] fatal', err));
  proxyHealthLoop().catch(() => {});
  console.log('Scrape workers started: 1 post loop + 1 comment pool loop');
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
