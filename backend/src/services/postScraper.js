import { config } from '../config.js';
import { getGlobal, updateGlobal, updateScrapeStatus, recordPostScrapeRun } from '../db.js';
import { fetchRedditJson } from './redditFetch.js';
import { shortenInterval, lengthenInterval, shouldAdjustInterval } from './intervalAdjust.js';
import { toUtcDate, isAtOrBeforeUtc } from './scrapeBounds.js';
import {
  typedFieldsFromPost,
  postExists,
  globalIdExists,
  insertGlobalId,
  ensureSubreddit,
  insertPost,
  updatePost,
} from './entityStore.js';

const NEW_URL = 'https://www.reddit.com/new.json';

function createPostScrapeContext(global) {
  const watermark = global.last_timestamp ? toUtcDate(global.last_timestamp) : null;
  return { watermark, stopped: false, stopReason: null };
}

async function processPostChild(child, stats, newestTs, ctx) {
  if (child.kind !== 't3' || !child.data?.id) return newestTs;
  if (ctx.stopped) return newestTs;

  const d = child.data;
  const type = 't3';
  const dataId = String(d.id);
  const fields = typedFieldsFromPost(d);
  const createdUtc = toUtcDate(fields.created_utc);

  if (ctx.watermark && isAtOrBeforeUtc(createdUtc, ctx.watermark)) {
    ctx.stopped = true;
    ctx.stopReason = 'watermark';
    return newestTs;
  }

  let latest = newestTs;
  if (!newestTs || createdUtc > newestTs) {
    latest = createdUtc;
  }

  await ensureSubreddit(fields.subreddit);

  const exists = await postExists(dataId);

  if (!(await globalIdExists(type, dataId))) {
    await insertGlobalId(type, dataId, createdUtc);
  }

  if (exists) {
    await updatePost(fields);
    stats.existing += 1;
    stats.total += 1;
    ctx.stopped = true;
    ctx.stopReason = 'existing';
    return latest;
  }

  await insertPost(fields);
  stats.new += 1;
  stats.total += 1;
  return latest;
}

async function processListing(listing, stats, ctx) {
  const children = listing?.data?.children ?? [];
  let newestTs = null;

  for (const child of children) {
    if (ctx.stopped) break;
    newestTs = await processPostChild(child, stats, newestTs, ctx);
  }

  return {
    after: listing?.data?.after ?? null,
    dist: listing?.data?.dist ?? children.length,
    newestTs,
  };
}

async function fetchNewPage(params) {
  return fetchRedditJson(
    NEW_URL,
    { limit: 100, ...params },
    { kind: 'posts', target: 'new.json' },
  );
}

export async function runPostScrape() {
  const global = await getGlobal();
  const stats = { new: 0, existing: 0, total: 0 };
  const ctx = createPostScrapeContext(global);
  let newestTs = global.last_timestamp ? toUtcDate(global.last_timestamp) : null;
  let proxyIndex = 0;
  let pages = 0;

  let { data: listing, proxyIndex: pi } = await fetchNewPage();
  proxyIndex = pi;
  pages = 1;

  let meta = await processListing(listing, stats, ctx);
  if (meta.newestTs && (!newestTs || meta.newestTs > newestTs)) {
    newestTs = meta.newestTs;
  }

  while (!ctx.stopped && meta.after && pages < config.maxPaginationPages) {
    ({ data: listing, proxyIndex: pi } = await fetchNewPage({ after: meta.after }));
    proxyIndex = pi;
    pages += 1;
    meta = await processListing(listing, stats, ctx);
    if (meta.newestTs && (!newestTs || meta.newestTs > newestTs)) {
      newestTs = meta.newestTs;
    }
  }

  const { allNew, mostlyExisting } = shouldAdjustInterval(
    stats.existing,
    stats.new,
    stats.total,
  );

  let intervalSeconds = global.interval_seconds;

  if (allNew && meta.after && !ctx.stopped) {
    intervalSeconds = shortenInterval(intervalSeconds);
  } else if (mostlyExisting) {
    intervalSeconds = lengthenInterval(intervalSeconds);
  }

  const pollAt = new Date();
  if (newestTs) {
    await updateGlobal({
      last_timestamp: newestTs,
      interval_seconds: intervalSeconds,
      last_poll_at: pollAt,
    });
  } else {
    await updateGlobal({
      interval_seconds: intervalSeconds,
      last_poll_at: pollAt,
    });
  }

  await recordPostScrapeRun(stats);
  await updateScrapeStatus({
    active_proxy_index: proxyIndex,
    last_post_finished_at: pollAt,
    last_post_error: null,
  });

  return { stats, intervalSeconds, allNew, mostlyExisting, pages, stopReason: ctx.stopReason };
}
