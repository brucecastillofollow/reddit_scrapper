/** In-memory queue of subreddit comment scrape tasks (one row per subreddit). */

import { config } from '../config.js';

const queue = [];
const queuedNames = new Set();
const inFlight = new Set();

function maxTasks() {
  return config.commentScrapesPerMinute;
}

export function getActiveTaskCount() {
  return queue.length + inFlight.size;
}

/** Slots left before hitting COMMENT_SCRAPES_PER_MINUTE (queued + in-flight). */
export function getCommentTaskCapacity() {
  return Math.max(0, maxTasks() - getActiveTaskCount());
}

export function pushCommentTask(task) {
  const name = task?.name;
  if (!name || queuedNames.has(name) || inFlight.has(name)) {
    return false;
  }
  if (getActiveTaskCount() >= maxTasks()) {
    return false;
  }
  queue.push(task);
  queuedNames.add(name);
  return true;
}

export function popCommentTask() {
  const task = queue.shift();
  if (!task) return null;
  queuedNames.delete(task.name);
  inFlight.add(task.name);
  return task;
}

export function releaseCommentTask(name) {
  inFlight.delete(name);
}

/** Failed in-flight task — requeue at front without counting against capacity. */
export function requeueCommentTask(task) {
  if (!task?.name) return false;
  inFlight.delete(task.name);
  if (queuedNames.has(task.name)) return false;
  queue.unshift(task);
  queuedNames.add(task.name);
  return true;
}

export function getCommentQueueStats() {
  return {
    queued: queue.length,
    in_flight: inFlight.size,
    active: getActiveTaskCount(),
    max_tasks: maxTasks(),
    capacity: getCommentTaskCapacity(),
    queued_names: [...queuedNames],
    in_flight_names: [...inFlight],
  };
}
