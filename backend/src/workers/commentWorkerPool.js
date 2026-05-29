import { config } from '../config.js';
import { updateScrapeStatus } from '../db.js';
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
import { markSubredditForbidden } from '../services/entityStore.js';
import { errorMessageWithProxy, logScrapeFailureFromError } from '../services/scrapeLogger.js';
import { isWebshareBatchActive } from '../services/commentPoolGate.js';

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

async function commentCoordinatorLoop() {
  const startupDelayMs = config.commentCoordinatorStartupDelaySeconds * 1000;
  if (startupDelayMs > 0) {
    console.log(
      `[comment-coordinator] waiting ${config.commentCoordinatorStartupDelaySeconds}s before first enqueue`,
    );
    await sleep(startupDelayMs);
  }

  const tickMs = config.commentCoordinatorIntervalSeconds * 1000;

  while (true) {
    try {
      if (config.websharePauseDbComments && isWebshareBatchActive()) {
        await sleep(tickMs);
        continue;
      }

      const capacity = getCommentTaskCapacity();
      if (capacity > 0) {
        const { tasks, counts } = await buildCommentCoordinatorTasks({
          batchSize: Math.min(config.commentScrapesPerMinute, capacity),
          hotNewPostsMin: config.commentHotNewPostsMin,
          hotActivityMin: config.commentHotActivityMin,
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
              `(hot=${counts.hot} due=${counts.due} never=${counts.never}, hot_candidates=${counts.hot_candidates}), ` +
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

/** Shared workers — pick DB proxy per task (env fallback inside scraper). */
function commentWorkerLoop(workerIndex) {
  const idleSleepMs = config.commentIdleSleepSeconds * 1000;
  const label = `worker-${workerIndex + 1}`;

  return (async () => {
    const staggerMs = workerIndex * config.workerStartupStaggerSeconds * 1000;
    if (staggerMs > 0) {
      console.log(`[comment-${label}] startup stagger ${staggerMs / 1000}s`);
      await sleep(staggerMs);
    }

    while (true) {
      if (config.websharePauseDbComments && isWebshareBatchActive()) {
        await sleep(500);
        continue;
      }

      const task = popCommentTask();
      if (!task) {
        await sleep(idleSleepMs);
        continue;
      }

      await beginCommentWork();
      try {
        await runCommentScrapeForSubreddit(task);
        releaseCommentTask(task.name);
      } catch (err) {
        const status = err?.response?.status ?? err?.status ?? null;
        if (status === 403 || status === 404) {
          await markSubredditForbidden(task.name);
          releaseCommentTask(task.name);
          await updateScrapeStatus({
            last_comment_error: `[${label}] r/${task.name}: forbidden (${status}) - subreddit disabled`,
            last_comment_finished_at: new Date(),
          });
          console.warn(`[comment-${label}] r/${task.name}: marked forbidden after ${status}`);
          continue;
        }
        await logScrapeFailureFromError('comments', err, {
          target: `r/${task.name}/comments.json`,
          subreddit: task.name,
          worker: label,
        });
        console.error(`[comment-${label}] r/${task.name}:`, errorMessageWithProxy(err));
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

  const workerCount = config.commentWorkerCount;

  commentCoordinatorLoop().catch((err) => console.error('[comment-coordinator] fatal', err));

  for (let i = 0; i < workerCount; i += 1) {
    commentWorkerLoop(i).catch((err) => console.error(`[comment-worker-${i + 1}] fatal`, err));
  }

  console.log(
    `Comment pool: 1 coordinator (${config.commentCoordinatorIntervalSeconds}s, ` +
      `max ${config.commentScrapesPerMinute} tasks) + ${workerCount} shared worker(s)`,
  );
}

export function getCommentWorkerStats() {
  return {
    workers: config.commentWorkerCount,
    coordinator_interval_seconds: config.commentCoordinatorIntervalSeconds,
    coordinator_startup_delay_seconds: config.commentCoordinatorStartupDelaySeconds,
    worker_startup_stagger_seconds: config.workerStartupStaggerSeconds,
    max_tasks: config.commentScrapesPerMinute,
    ...getCommentQueueStats(),
  };
}
