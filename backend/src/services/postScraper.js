import { config } from '../config.js';
import { getGlobal, updateGlobal, updateScrapeStatus, recordPostScrapeRun } from '../db.js';
import { runScrapeOnEndpoint } from './proxyPool.js';
import { runWithDbThenEnvFailover } from './proxyScrape.js';
import { fetchRedditJsonWithClient } from './redditFetch.js';
import { toUtcDate, isAtOrBeforeUtc } from './scrapeBounds.js';
import { logPostScrape } from './scrapeLogger.js';
import {
  typedFieldsFromPost,
  postExists,
  globalIdExists,
  insertGlobalId,
  ensureSubreddit,
  recordSubredditNewPost,
  insertPost,
  updatePost,
} from './entityStore.js';

const NEW_URL = 'https://www.reddit.com/new.json';

function createPostScrapeContext(global) {
  const watermark = global.last_timestamp ? toUtcDate(global.last_timestamp) : null;
  return { watermark, stopped: false, stopReason: null };
}

function mergeBounds(bounds, createdUtc) {
  if (!createdUtc) return bounds;
  let { oldestTs, newestTs } = bounds;
  if (!oldestTs || createdUtc < oldestTs) oldestTs = createdUtc;
  if (!newestTs || createdUtc > newestTs) newestTs = createdUtc;
  return { oldestTs, newestTs };
}

async function processPostChild(child, stats, bounds, ctx) {
  if (child.kind !== 't3' || !child.data?.id) return bounds;
  if (ctx.stopped) return bounds;

  const d = child.data;
  const type = 't3';
  const dataId = String(d.id);
  const fields = typedFieldsFromPost(d);
  const createdUtc = toUtcDate(fields.created_utc);

  if (ctx.watermark && isAtOrBeforeUtc(createdUtc, ctx.watermark)) {
    ctx.stopped = true;
    ctx.stopReason = 'watermark';
    return bounds;
  }

  const nextBounds = mergeBounds(bounds, createdUtc);

  await ensureSubreddit(fields.subreddit);

  const exists = await postExists(dataId);

  if (!(await globalIdExists(type, dataId))) {
    await insertGlobalId(type, dataId, createdUtc);
  }

  if (exists) {
    await updatePost(fields);
    stats.existing += 1;
    stats.total += 1;
    return nextBounds;
  }

  await insertPost(fields);
  await recordSubredditNewPost(fields.subreddit);
  stats.new += 1;
  stats.total += 1;
  return nextBounds;
}

async function processListing(listing, stats, bounds, ctx) {
  const children = listing?.data?.children ?? [];
  let nextBounds = bounds;

  for (const child of children) {
    if (ctx.stopped) break;
    nextBounds = await processPostChild(child, stats, nextBounds, ctx);
  }

  return {
    after: listing?.data?.after ?? null,
    reddit_dist: listing?.data?.dist ?? children.length,
    bounds: nextBounds,
  };
}

async function fetchNewPage(client, endpoint, params = {}) {
  return fetchRedditJsonWithClient(
    client,
    NEW_URL,
    { limit: 100, ...params },
    { kind: 'posts', target: 'new.json' },
    endpoint,
  );
}

function buildPostScrapeLogFields({
  startedAt,
  global,
  stats,
  ctx,
  pages,
  meta,
  bounds,
  newestTs,
  intervalSeconds,
  endpoint,
  pollAt,
}) {
  const watermarkBefore = global.last_timestamp ? toUtcDate(global.last_timestamp) : null;
  const lastPollBefore = global.last_poll_at ? toUtcDate(global.last_poll_at) : null;
  const downtimeSec = lastPollBefore
    ? Math.max(0, Math.floor((pollAt.getTime() - lastPollBefore.getTime()) / 1000))
    : null;
  const backlogSpanSec =
    watermarkBefore && bounds.newestTs
      ? Math.max(0, Math.floor((bounds.newestTs.getTime() - watermarkBefore.getTime()) / 1000))
      : null;

  return {
    target: 'new.json',
    posts_new: stats.new,
    posts_existing: stats.existing,
    posts_total: stats.total,
    pages,
    reddit_dist_last_page: meta.reddit_dist,
    stop_reason: ctx.stopReason,
    pagination_exhausted: !ctx.stopped && !meta.after,
    hit_max_pages: pages >= config.maxPaginationPages && Boolean(meta.after),
    had_after_on_stop: Boolean(meta.after),
    watermark_before_utc: watermarkBefore?.toISOString() ?? null,
    watermark_after_utc: newestTs?.toISOString() ?? null,
    oldest_processed_utc: bounds.oldestTs?.toISOString() ?? null,
    newest_processed_utc: bounds.newestTs?.toISOString() ?? null,
    downtime_sec: downtimeSec,
    backlog_span_sec: backlogSpanSec,
    interval_sec: intervalSeconds,
    proxy_id: endpoint.id,
    proxy_index: endpoint.index,
  };
}

/** One full new.json run on a single proxy (same session for all pages). */
async function runPostScrapeOnEndpoint(endpoint) {
  const startedAt = Date.now();
  const global = await getGlobal();
  const stats = { new: 0, existing: 0, total: 0 };
  const ctx = createPostScrapeContext(global);
  let bounds = { oldestTs: null, newestTs: null };
  let newestTs = global.last_timestamp ? toUtcDate(global.last_timestamp) : null;
  let pages = 0;
  let meta = { after: null, reddit_dist: 0 };

  try {
    return await runScrapeOnEndpoint(endpoint, async (client) => {
    let { data: listing } = await fetchNewPage(client, endpoint);
    pages = 1;
    meta = await processListing(listing, stats, bounds, ctx);
    bounds = meta.bounds;

    while (!ctx.stopped && meta.after && pages < config.maxPaginationPages) {
      ({ data: listing } = await fetchNewPage(client, endpoint, { after: meta.after }));
      pages += 1;
      meta = await processListing(listing, stats, bounds, ctx);
      bounds = meta.bounds;
    }

    if (bounds.newestTs && (!newestTs || bounds.newestTs > newestTs)) {
      newestTs = bounds.newestTs;
    }

    const pollAt = new Date();
    if (newestTs) {
      await updateGlobal({
        last_timestamp: newestTs,
        last_poll_at: pollAt,
      });
    } else {
      await updateGlobal({
        last_poll_at: pollAt,
      });
    }

    await recordPostScrapeRun(stats);
    await updateScrapeStatus({
      active_proxy_index: endpoint.index,
      last_post_finished_at: pollAt,
      last_post_error: null,
    });

    const durationMs = Date.now() - startedAt;
    await logPostScrape({
      success: true,
      duration_ms: durationMs,
      ...buildPostScrapeLogFields({
        startedAt,
        global,
        stats,
        ctx,
        pages,
        meta,
        bounds,
        newestTs,
        intervalSeconds: global.interval_seconds,
        endpoint,
        pollAt,
      }),
    });

    return {
      stats,
      pages,
      stopReason: ctx.stopReason,
      endpoint,
    };
    });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const pollAt = new Date();
    await logPostScrape({
      success: false,
      duration_ms: durationMs,
      error: err.message,
      status: err.response?.status ?? err.status ?? null,
      pages,
      posts_new: stats.new,
      posts_existing: stats.existing,
      posts_total: stats.total,
      stop_reason: ctx.stopReason,
      proxy_id: endpoint.id,
      proxy: err.proxy ?? null,
      watermark_before_utc: global.last_timestamp
        ? toUtcDate(global.last_timestamp)?.toISOString()
        : null,
    });
    throw err;
  }
}

/** DB proxies first; env fallbacks if all DB proxies fail (same session per proxy for pagination). */
export async function runPostScrape() {
  return runWithDbThenEnvFailover((endpoint) => runPostScrapeOnEndpoint(endpoint));
}
