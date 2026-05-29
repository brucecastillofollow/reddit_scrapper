import { config } from '../config.js';
import { getGlobal, updateGlobal, updateScrapeStatus, recordPostScrapeRun } from '../db.js';
import { runScrapeOnEndpointWithCookieRetry } from './proxyPool.js';
import { runWithEnvRotating } from './proxyScrape.js';
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

function postNewJsonUrl() {
  const base = config.postRedditBaseUrl.replace(/\/+$/, '');
  return `${base}/r/all/new.json`;
}

function emptyDiagnostics() {
  return {
    reddit_children_total: 0,
    skipped_not_t3: 0,
    skipped_no_created_utc: 0,
    skipped_stickied: 0,
    pages_fetched: 0,
    pages_with_zero_children: 0,
    listing_shape_errors: 0,
  };
}

function mergeDiagnostics(into, page) {
  into.reddit_children_total += page.reddit_children_total;
  into.skipped_not_t3 += page.skipped_not_t3;
  into.skipped_no_created_utc += page.skipped_no_created_utc;
  into.skipped_stickied += page.skipped_stickied;
  into.pages_fetched += page.pages_fetched;
  into.pages_with_zero_children += page.pages_with_zero_children;
  into.listing_shape_errors += page.listing_shape_errors;
}

/** @returns {'ok' | 'empty_reddit_listing' | 'zero_processed' | 'bad_response_shape'} */
function classifyPostScrapeOutcome(stats, diag) {
  if (diag.listing_shape_errors > 0) return 'bad_response_shape';
  if (diag.reddit_children_total === 0) return 'empty_reddit_listing';
  if (stats.total === 0) return 'zero_processed';
  return 'ok';
}

function validateListingShape(listing) {
  if (!listing || typeof listing !== 'object') {
    throw new Error('Reddit response is not JSON object (blocked page or proxy HTML?)');
  }
  if (listing.error != null || listing.reason != null) {
    const msg = listing.message || listing.reason || String(listing.error);
    throw new Error(`Reddit API error: ${msg}`);
  }
  if (!listing.data || !Array.isArray(listing.data.children)) {
    throw new Error('Reddit response missing data.children — not a listing payload');
  }
}

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

async function processPostChild(child, stats, bounds, ctx, pageDiag) {
  if (child.kind !== 't3' || !child.data?.id) {
    pageDiag.skipped_not_t3 += 1;
    return bounds;
  }
  if (ctx.stopped) return bounds;

  const d = child.data;
  const type = 't3';
  const dataId = String(d.id);
  const fields = typedFieldsFromPost(d);
  const createdUtc = toUtcDate(fields.created_utc);

  if (!createdUtc) {
    pageDiag.skipped_no_created_utc += 1;
    return bounds;
  }

  // Old stickied posts can sit above newer items — skip without ending the run.
  if (d.stickied && ctx.watermark && isAtOrBeforeUtc(createdUtc, ctx.watermark)) {
    pageDiag.skipped_stickied += 1;
    return bounds;
  }

  // At/below watermark and already ingested — skip this post only (do NOT stop the page).
  // Reddit /new is not strictly chronological; an old post at the top must not block newer posts below.
  if (ctx.watermark && isAtOrBeforeUtc(createdUtc, ctx.watermark)) {
    if (await globalIdExists(type, dataId)) {
      stats.existing += 1;
      stats.total += 1;
      return bounds;
    }
    // Below watermark but missing from registry — process (recovery).
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
  validateListingShape(listing);

  const pageDiag = {
    reddit_children_total: 0,
    skipped_not_t3: 0,
    skipped_no_created_utc: 0,
    skipped_stickied: 0,
    pages_fetched: 1,
    pages_with_zero_children: 0,
    listing_shape_errors: 0,
  };

  const children = listing.data.children;
  pageDiag.reddit_children_total = children.length;
  if (children.length === 0) pageDiag.pages_with_zero_children = 1;

  let nextBounds = bounds;

  for (const child of children) {
    if (ctx.stopped) break;
    nextBounds = await processPostChild(child, stats, nextBounds, ctx, pageDiag);
  }

  // Stop pagination only when the oldest post on this page is at/below the watermark.
  if (ctx.watermark && children.length > 0 && !ctx.stopped) {
    const last = children[children.length - 1];
    if (last?.data?.id) {
      const lastCreated = toUtcDate(typedFieldsFromPost(last.data).created_utc);
      if (lastCreated && isAtOrBeforeUtc(lastCreated, ctx.watermark)) {
        ctx.stopped = true;
        ctx.stopReason = 'watermark';
      }
    }
  }

  return {
    after: listing?.data?.after ?? null,
    reddit_dist: listing?.data?.dist ?? children.length,
    bounds: nextBounds,
    pageDiag,
  };
}

async function fetchNewPage(client, endpoint, params = {}) {
  return fetchRedditJsonWithClient(
    client,
    postNewJsonUrl(),
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
  diagnostics,
  outcome,
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
    outcome,
    reddit_children_total: diagnostics?.reddit_children_total ?? 0,
    skipped_not_t3: diagnostics?.skipped_not_t3 ?? 0,
    skipped_no_created_utc: diagnostics?.skipped_no_created_utc ?? 0,
    skipped_stickied: diagnostics?.skipped_stickied ?? 0,
    pages_with_zero_children: diagnostics?.pages_with_zero_children ?? 0,
  };
}

/** One full new.json run on a single proxy (same session for all pages). */
async function runPostScrapeOnEndpoint(endpoint) {
  const startedAt = Date.now();
  const global = await getGlobal();

  try {
    return await runScrapeOnEndpointWithCookieRetry(endpoint, async (client) => {
      const stats = { new: 0, existing: 0, total: 0 };
      const diagnostics = emptyDiagnostics();
      const ctx = createPostScrapeContext(global);
      let bounds = { oldestTs: null, newestTs: null };
      let newestTs = global.last_timestamp ? toUtcDate(global.last_timestamp) : null;
      let pages = 0;

      let { data: listing } = await fetchNewPage(client, endpoint);
      pages = 1;
      let meta = await processListing(listing, stats, bounds, ctx);
      bounds = meta.bounds;
      mergeDiagnostics(diagnostics, meta.pageDiag);

      while (!ctx.stopped && meta.after && pages < config.maxPaginationPages) {
        ({ data: listing } = await fetchNewPage(client, endpoint, { after: meta.after }));
        pages += 1;
        meta = await processListing(listing, stats, bounds, ctx);
        bounds = meta.bounds;
        mergeDiagnostics(diagnostics, meta.pageDiag);
      }

      const outcome = classifyPostScrapeOutcome(stats, diagnostics);
      if (stats.total === 0) {
        console.warn(
          `[post-scrape] ZERO processed (new=0 existing=0) outcome=${outcome} ` +
            `reddit_items=${diagnostics.reddit_children_total} ` +
            `skipped(stickied=${diagnostics.skipped_stickied} no_date=${diagnostics.skipped_no_created_utc} not_t3=${diagnostics.skipped_not_t3}) ` +
            `pages=${pages} zero_child_pages=${diagnostics.pages_with_zero_children}`,
        );
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
          diagnostics,
          outcome,
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
    await logPostScrape({
      success: false,
      duration_ms: durationMs,
      error: err.message,
      status: err.response?.status ?? err.status ?? null,
      proxy_id: endpoint.id,
      proxy: err.proxy ?? null,
      watermark_before_utc: global.last_timestamp
        ? toUtcDate(global.last_timestamp)?.toISOString()
        : null,
    });
    throw err;
  }
}

/** Env proxies only (.env), rotated each run. */
export async function runPostScrape() {
  return runWithEnvRotating((endpoint) => runPostScrapeOnEndpoint(endpoint));
}
