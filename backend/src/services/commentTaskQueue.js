/** In-memory queue of subreddit comment scrape tasks (one row per subreddit). */

const queue = [];
const queuedNames = new Set();
const inFlight = new Set();

export function pushCommentTask(task) {
  const name = task?.name;
  if (!name || queuedNames.has(name) || inFlight.has(name)) {
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

export function requeueCommentTask(task) {
  if (!task?.name) return false;
  inFlight.delete(task.name);
  return pushCommentTask(task);
}

export function getCommentQueueStats() {
  return {
    queued: queue.length,
    in_flight: inFlight.size,
    queued_names: [...queuedNames],
    in_flight_names: [...inFlight],
  };
}
