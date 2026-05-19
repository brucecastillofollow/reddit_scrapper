import { config } from '../config.js';
import { updateScrapeStatus } from '../db.js';
import { getPool, isProxyQuarantined, getProxyQuarantineRemainingMs } from '../services/proxyPool.js';
import { buildCommentCoordinatorTasks } from '../services/entityStore.js';
import { runCommentScrapeForSubreddit } from '../services/commentScraper.js';
import {
  pushCommentTask,
  popCommentTask,
  releaseCommentTask,
  requeueCommentTask,
  getCommentQueueStats,
  getCommentTaskCapacity,
} from '../services/commentTaskQueue.js';
import { errorMessageWithProxy, logScrapeFailureFromError } from '../services/scrapeLogger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let workersStarted = false;
let activeCommentWorkers = 0;

async function setCommentsRunning(active) {
  await updateScrapeStatus({ comments_running: active });
}

async function beginCommentWork() {
  activeCommentWorkers += 1;
  if (activeCommentWorkers === 1) {
    await setCommentsRunning(true);
  }
}

async function endCommentWork() {
  activeCommentWorkers = Math.max(0, activeCommentWorkers - 1);
  if (activeCommentWorkers === 0) {
    await setCommentsRunning(false);
  }
}

/** Each tick: enqueue up to COMMENT_SCRAPES_PER_MINUTE subs (hot new_posts / due / never). */
async function commentCoordinatorLoop() {
  const startupDelayMs = config.commentCoordinatorStartupDelaySeconds * 1000;
  if (startupDelayMs > 0) {
    console.log(`[comment-coordinator] waiting ${config.commentCoordinatorStartupDelaySeconds}s before first enqueue`);
    await sleep(startupDelayMs);
  }

  const tickMs = config.commentCoordinatorIntervalSeconds * 1000;

  while (true) {
    try {
      const capacity = getCommentTaskCapacity();
      if (capacity > 0) {
        const { tasks, counts } = await buildCommentCoordinatorTasks({
          batchSize: Math.min(config.commentScrapesPerMinute, capacity),
          hotNewPostsMin: config.commentHotNewPostsMin,
        });

        let added = 0;
        for (const sub of tasks) {
          if (getCommentTaskCapacity() <= 0) break;
          if (pushCommentTask(sub)) added += 1;
        }

        if (added > 0) {
          const stats = getCommentQueueStats();
          console.log(
            `[comment-coordinator] enqueued ${added}/${tasks.length} ` +
              `(hot=${counts.hot} due=${counts.due} never=${counts.never}, ` +
              `hot_candidates>${config.commentHotNewPostsMin}=${counts.hot_candidates}), ` +
              `active=${stats.active}/${stats.max_tasks}`,
          );
        }
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
    const staggerMs = endpoint.index * config.workerStartupStaggerSeconds * 1000;
    if (staggerMs > 0) {
      console.log(`[comment-worker:${label}] startup stagger ${staggerMs / 1000}s`);
      await sleep(staggerMs);
    }

    while (true) {
      if (isProxyQuarantined(endpoint)) {
        const waitMs = Math.max(idleSleepMs, getProxyQuarantineRemainingMs(endpoint));
        console.log(
          `[comment-worker:${label}] quarantined — idle ${Math.ceil(waitMs / 1000)}s`,
        );
        await sleep(waitMs);
        continue;
      }

      const task = popCommentTask();

      if (!task) {
        await sleep(idleSleepMs);
        continue;
      }

      await beginCommentWork();
      try {
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
      } finally {
        await endCommentWork();
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
    `Comment pool: 1 coordinator (${config.commentCoordinatorIntervalSeconds}s, ` +
      `max ${config.commentScrapesPerMinute} tasks) + ` +
      `${workerCount} worker(s) (stagger ${config.workerStartupStaggerSeconds}s/index)`,
  );
}

export function getCommentWorkerStats() {
  return {
    workers: getPool().length || 1,
    coordinator_interval_seconds: config.commentCoordinatorIntervalSeconds,
    coordinator_startup_delay_seconds: config.commentCoordinatorStartupDelaySeconds,
    worker_startup_stagger_seconds: config.workerStartupStaggerSeconds,
    max_tasks: config.commentScrapesPerMinute,
    ...getCommentQueueStats(),
  };
}
