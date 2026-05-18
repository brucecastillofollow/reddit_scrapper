import { config } from '../config.js';
import { updateScrapeStatus } from '../db.js';
import { getPool } from '../services/proxyPool.js';
import { buildCommentCoordinatorTasks } from '../services/entityStore.js';
import { runCommentScrapeForSubreddit } from '../services/commentScraper.js';
import {
  pushCommentTask,
  popCommentTask,
  releaseCommentTask,
  requeueCommentTask,
  getCommentQueueStats,
} from '../services/commentTaskQueue.js';
import { errorMessageWithProxy, logScrapeFailureFromError } from '../services/scrapeLogger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let workersStarted = false;

/** Every 60s: enqueue up to 200 subreddits (hot / due / never scraped). */
async function commentCoordinatorLoop() {
  const tickMs = config.commentCoordinatorIntervalSeconds * 1000;

  while (true) {
    try {
      const { tasks, counts } = await buildCommentCoordinatorTasks({
        hot: config.commentCoordinatorHotLimit,
        due: config.commentCoordinatorDueLimit,
        never: config.commentCoordinatorNeverLimit,
      });

      let added = 0;
      for (const sub of tasks) {
        if (pushCommentTask(sub)) added += 1;
      }

      if (added > 0) {
        console.log(
          `[comment-coordinator] enqueued ${added}/${tasks.length} ` +
            `(hot=${counts.hot} due=${counts.due} never=${counts.never}), ` +
            `queue=${getCommentQueueStats().queued}`,
        );
      }
    } catch (err) {
      console.error('[comment-coordinator]', err.message);
    }

    await sleep(tickMs);
  }
}

/** One async worker bound to a single proxy endpoint (or direct). */
function commentProxyWorkerLoop(endpoint) {
  const idleSleepMs = config.commentIdleSleepSeconds * 1000;
  const label = endpoint.id;

  return (async () => {
    while (true) {
      const task = popCommentTask();

      if (!task) {
        await sleep(idleSleepMs);
        continue;
      }

      try {
        await updateScrapeStatus({ comments_running: true });
        await runCommentScrapeForSubreddit(task, endpoint);
        releaseCommentTask(task.name);
      } catch (err) {
        await logScrapeFailureFromError('comments', err, {
          target: `r/${task.name}/comments.json`,
          subreddit: task.name,
          worker: label,
        });
        console.error(`[comment-worker:${label}] r/${task.name}:`, errorMessageWithProxy(err));
        requeueCommentTask(task);
        await updateScrapeStatus({
          last_comment_error: `[${label}] r/${task.name}: ${err.message}`,
          last_comment_finished_at: new Date(),
        });
        await sleep(idleSleepMs);
      }
    }
  })();
}

export function startCommentWorkerPool() {
  if (workersStarted) return;
  workersStarted = true;

  const pool = getPool();
  const workerCount = pool.length || 1;

  commentCoordinatorLoop().catch((err) => console.error('[comment-coordinator] fatal', err));

  if (pool.length === 0) {
    const direct = { id: 'direct', mode: 'direct', protocol: 'direct', url: null, index: 0 };
    commentProxyWorkerLoop(direct).catch((err) =>
      console.error('[comment-worker:direct] fatal', err),
    );
  } else {
    for (const endpoint of pool) {
      commentProxyWorkerLoop(endpoint).catch((err) =>
        console.error(`[comment-worker:${endpoint.id}] fatal`, err),
      );
    }
  }

  console.log(
    `Comment pool: 1 coordinator (${config.commentCoordinatorIntervalSeconds}s) + ` +
      `${workerCount} worker(s) (${pool.map((p) => p.id).join(', ')})`,
  );
}

export function getCommentWorkerStats() {
  return {
    workers: getPool().length || 1,
    coordinator_interval_seconds: config.commentCoordinatorIntervalSeconds,
    ...getCommentQueueStats(),
  };
}
