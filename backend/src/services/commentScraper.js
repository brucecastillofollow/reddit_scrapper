import { config } from '../config.js';
import { updateScrapeStatus, recordCommentScrapeRun } from '../db.js';
import { runScrapeOnEndpoint } from './proxyPool.js';
import { fetchRedditJsonWithClient } from './redditFetch.js';
import { logCommentScrapeTiming, logCommentIntervalUpdate } from './scrapeLogger.js';
import { computeCommentInterval } from './commentInterval.js';
import { getSubredditWeightedActivity } from './commentActivity.js';
import { toUtcDate, isAtOrBeforeUtc, utcNow } from './scrapeBounds.js';
import {
  typedFieldsFromComment,
  commentExists,
  globalIdExists,
  insertGlobalId,
  insertComment,
  updateComment,
  updateSubreddit,
  recordSubredditCommentScrape,
  resetSubredditNewPosts,
} from './entityStore.js';

function commentsUrl(subreddit) {
  return `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/comments.json`;
}

const fetchMeta = (name) => ({
  kind: 'comments',
  target: `r/${name}/comments.json`,
  subreddit: name,
});

function isNeverScraped(subRow) {
  return subRow.last_poll_at == null;
}

function isHotSubreddit(subRow) {
  return (subRow.new_posts ?? 0) > 0;
}

function createCommentScrapeContext({ neverScraped, watermark }) {
  return {
    neverScraped,
    watermark: neverScraped ? null : watermark,
    stopped: false,
    stopReason: null,
  };
}

function mergeBounds(bounds, createdUtc) {
  if (!createdUtc) return bounds;
  let { oldestTs, newestTs } = bounds;
  if (!oldestTs || createdUtc < oldestTs) oldestTs = createdUtc;
  if (!newestTs || createdUtc > newestTs) newestTs = createdUtc;
  return { oldestTs, newestTs };
}

async function processCommentChild(child, stats, bounds, ctx) {
  if (child.kind !== 't1' || !child.data?.id) return bounds;
  if (ctx.stopped) return bounds;

  const d = child.data;
  const type = 't1';
  const dataId = String(d.id);
  const fields = typedFieldsFromComment(d);
  const createdUtc = toUtcDate(fields.created_utc);

  if (ctx.watermark && isAtOrBeforeUtc(createdUtc, ctx.watermark)) {
    ctx.stopped = true;
    ctx.stopReason = 'watermark';
    return bounds;
  }

  const nextBounds = mergeBounds(bounds, createdUtc);

  if (!(await globalIdExists(type, dataId))) {
    await insertGlobalId(type, dataId, createdUtc);
  }

  const exists = await commentExists(dataId);

  if (exists) {
    await updateComment(fields);
    stats.existing += 1;
    stats.total += 1;
    return nextBounds;
  }

  await insertComment(fields);
  stats.new += 1;
  stats.total += 1;
  return nextBounds;
}

async function processListing(listing, stats, bounds, ctx) {
  const children = listing?.data?.children ?? [];
  let nextBounds = bounds;

  for (const child of children) {
    if (ctx.stopped) break;
    nextBounds = await processCommentChild(child, stats, nextBounds, ctx);
  }

  return {
    after: listing?.data?.after ?? null,
    reddit_dist: listing?.data?.dist ?? children.length,
    bounds: nextBounds,
  };
}

async function resolveInterval(subreddit, stats, bounds, pollAt, lastTimestamp, currentInterval) {
  const { oldestTs, newestTs } = bounds;

  let commentSpanSec = 1;
  if (oldestTs && newestTs) {
    commentSpanSec = Math.max(1, Math.floor((newestTs.getTime() - oldestTs.getTime()) / 1000));
  }

  const watermark = lastTimestamp ? toUtcDate(lastTimestamp) : null;
  const wallDeltaSec = watermark
    ? Math.max(1, Math.floor((pollAt.getTime() - watermark.getTime()) / 1000))
    : commentSpanSec;

  let weightedRatePerMin = null;
  try {
    const activity = await getSubredditWeightedActivity(subreddit);
    weightedRatePerMin = activity.summary.weighted_rate_per_min;
  } catch {
    /* use scrape-only fallback */
  }

  const { intervalSeconds, detail } = computeCommentInterval({
    scrapedCount: stats.new,
    commentSpanSec,
    wallDeltaSec,
    weightedRatePerMin,
  });

  return {
    intervalSeconds: intervalSeconds ?? currentInterval,
    intervalDetail: {
      ...detail,
      interval_before_sec: currentInterval,
      interval_after_sec: intervalSeconds ?? currentInterval,
      last_timestamp_utc: lastTimestamp ? toUtcDate(lastTimestamp).toISOString() : null,
      oldest_processed_utc: oldestTs?.toISOString() ?? null,
      newest_processed_utc: newestTs?.toISOString() ?? null,
    },
    commentSpanSec,
    wallDeltaSec,
    weightedRatePerMin,
  };
}

export async function runCommentScrapeForSubreddit(subRow, endpoint) {
  const { name, last_timestamp, interval_seconds: currentInterval } = subRow;
  const neverScraped = isNeverScraped(subRow);
  const hot = isHotSubreddit(subRow);
  const watermark = last_timestamp ? toUtcDate(last_timestamp) : null;
  const startedAt = Date.now();
  const stats = { new: 0, existing: 0, total: 0 };
  const ctx = createCommentScrapeContext({ neverScraped, watermark });
  let bounds = { oldestTs: null, newestTs: watermark };
  let pages = 0;

  try {
    return await runScrapeOnEndpoint(endpoint, async (client) => {
    let { data: listing } = await fetchRedditJsonWithClient(
      client,
      commentsUrl(name),
      { limit: 100 },
      fetchMeta(name),
      endpoint,
    );

    pages = 1;
    let meta = await processListing(listing, stats, bounds, ctx);
    bounds = meta.bounds;

    if (!neverScraped) {
      while (!ctx.stopped && meta.after && pages < config.maxPaginationPages) {
        ({ data: listing } = await fetchRedditJsonWithClient(
          client,
          commentsUrl(name),
          { limit: 100, after: meta.after },
          fetchMeta(name),
          endpoint,
        ));
        pages += 1;
        meta = await processListing(listing, stats, bounds, ctx);
        bounds = meta.bounds;
      }
    }

    const pollAt = utcNow();
    const { intervalSeconds, intervalDetail, commentSpanSec, wallDeltaSec, weightedRatePerMin } =
      await resolveInterval(name, stats, bounds, pollAt, last_timestamp, currentInterval);
    const resolvedTimestamp = bounds.newestTs || pollAt;

    // await logCommentIntervalUpdate({
    //   subreddit: name,
    //   hot,
    //   never_scraped: neverScraped,
    //   stop_reason: ctx.stopReason,
    //   interval_before_sec: currentInterval,
    //   interval_after_sec: intervalSeconds,
    //   interval_detail: intervalDetail,
    // });

    if (stats.total > 0) {
      await recordSubredditCommentScrape(name, {
        added: stats.new,
        oldestTs: bounds.oldestTs,
        newestTs: bounds.newestTs,
      });
    }

    await updateSubreddit(name, {
      last_timestamp: resolvedTimestamp,
      interval_seconds: intervalSeconds,
      last_poll_at: pollAt,
      last_scrape_new: stats.new,
    });
    await resetSubredditNewPosts(name);

    const durationMs = Date.now() - startedAt;
    // await logCommentScrapeTiming({
    //   subreddit: name,
    //   duration_ms: durationMs,
    //   success: true,
    //   never_scraped: neverScraped,
    //   hot,
    //   comments_new: stats.new,
    //   comments_existing: stats.existing,
    //   comments_total: stats.total,
    //   reddit_dist: meta.reddit_dist,
    //   pages,
    //   stop_reason: ctx.stopReason,
    //   interval_seconds: intervalSeconds,
    //   interval_before_sec: currentInterval,
    //   comment_span_sec: commentSpanSec,
    //   wall_delta_sec: wallDeltaSec,
    //   interval_detail: intervalDetail,
    //   weighted_rate_per_min: weightedRatePerMin,
    //   oldest_comment_utc: bounds.oldestTs?.toISOString() ?? null,
    //   proxy_id: endpoint.id,
    //   proxy_index: endpoint.index,
    // });

    await recordCommentScrapeRun(name, stats);
    await updateScrapeStatus({
      active_proxy_index: endpoint.index,
      last_comment_finished_at: pollAt,
      last_comment_error: null,
    });

    return {
      name,
      stats,
      intervalSeconds,
      durationMs,
      pages,
      endpoint,
      neverScraped,
      hot,
      stopReason: ctx.stopReason,
    };
    });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    // await logCommentScrapeTiming({
    //   subreddit: name,
    //   duration_ms: durationMs,
    //   success: false,
    //   never_scraped: neverScraped,
    //   hot,
    //   error: err.message,
    //   pages,
    //   proxy_id: endpoint.id,
    //   proxy: err.proxy ?? null,
    // });
    throw err;
  }
}
