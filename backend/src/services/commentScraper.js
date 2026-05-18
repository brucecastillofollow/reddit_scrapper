import { config } from '../config.js';
import { updateScrapeStatus, recordCommentScrapeRun } from '../db.js';
import { fetchRedditJson } from './redditFetch.js';
import { logCommentScrapeTiming } from './scrapeLogger.js';
import {
  intervalFromNeverScrapedDelta,
  intervalFromCommentVolume,
} from './commentInterval.js';
import { toUtcDate, isAtOrBeforeUtc, utcNow } from './scrapeBounds.js';
import {
  typedFieldsFromComment,
  commentExists,
  globalIdExists,
  insertGlobalId,
  insertComment,
  updateComment,
  updateSubreddit,
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

function createCommentScrapeContext({ neverScraped, watermark }) {
  return {
    neverScraped,
    watermark: neverScraped ? null : watermark,
    stopped: false,
    stopReason: null,
  };
}

async function processCommentChild(child, stats, newestTs, ctx) {
  if (child.kind !== 't1' || !child.data?.id) return newestTs;
  if (ctx.stopped) return newestTs;

  const d = child.data;
  const type = 't1';
  const dataId = String(d.id);
  const fields = typedFieldsFromComment(d);
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

  if (!(await globalIdExists(type, dataId))) {
    await insertGlobalId(type, dataId, createdUtc);
  }

  const exists = await commentExists(dataId);

  if (exists) {
    await updateComment(fields);
    stats.existing += 1;
    stats.total += 1;
    return latest;
  }

  await insertComment(fields);
  stats.new += 1;
  stats.total += 1;
  return latest;
}

async function processListing(listing, stats, ctx) {
  const children = listing?.data?.children ?? [];
  let newestTs = null;

  for (const child of children) {
    if (ctx.stopped) break;
    newestTs = await processCommentChild(child, stats, newestTs, ctx);
  }

  return {
    after: listing?.data?.after ?? null,
    reddit_dist: listing?.data?.dist ?? children.length,
    newestTs,
  };
}

/** Oldest comment timestamp on a listing page (Reddit returns newest first). */
function oldestCommentTimestamp(listing) {
  const children = listing?.data?.children ?? [];
  let oldest = null;

  for (const child of children) {
    if (child.kind !== 't1' || !child.data) continue;
    const fields = typedFieldsFromComment(child.data);
    const ts = toUtcDate(fields.created_utc);
    if (!ts) continue;
    if (!oldest || ts < oldest) oldest = ts;
  }

  return oldest;
}

function resolveInterval(neverScraped, currentInterval, stats, oldestTs, pollAt) {
  if (neverScraped) {
    if (!oldestTs) return currentInterval;
    const deltaSeconds = (pollAt.getTime() - oldestTs.getTime()) / 1000;
    return intervalFromNeverScrapedDelta(currentInterval, deltaSeconds);
  }

  return intervalFromCommentVolume(currentInterval, stats.total);
}

export async function runCommentScrapeForSubreddit(subRow, endpoint) {
  const { name, last_timestamp, interval_seconds: currentInterval } = subRow;
  const neverScraped = isNeverScraped(subRow);
  const watermark = last_timestamp ? toUtcDate(last_timestamp) : null;
  const startedAt = Date.now();
  const stats = { new: 0, existing: 0, total: 0 };
  const ctx = createCommentScrapeContext({ neverScraped, watermark });
  let newestTs = watermark;
  let pages = 0;
  let oldestTs = null;

  try {
    let { data: listing } = await fetchRedditJson(
      commentsUrl(name),
      { limit: 100 },
      fetchMeta(name),
      endpoint,
    );

    pages = 1;
    if (neverScraped) {
      oldestTs = oldestCommentTimestamp(listing);
    }

    let meta = await processListing(listing, stats, ctx);
    if (meta.newestTs && (!newestTs || meta.newestTs > newestTs)) {
      newestTs = meta.newestTs;
    }

    if (!neverScraped) {
      while (!ctx.stopped && meta.after && pages < config.maxPaginationPages) {
        ({ data: listing } = await fetchRedditJson(
          commentsUrl(name),
          { limit: 100, after: meta.after },
          fetchMeta(name),
          endpoint,
        ));
        pages += 1;
        meta = await processListing(listing, stats, ctx);
        if (meta.newestTs && (!newestTs || meta.newestTs > newestTs)) {
          newestTs = meta.newestTs;
        }
      }
    }

    const pollAt = utcNow();
    const intervalSeconds = resolveInterval(
      neverScraped,
      currentInterval,
      stats,
      oldestTs,
      pollAt,
    );
    const resolvedTimestamp = newestTs || pollAt;

    await updateSubreddit(name, {
      last_timestamp: resolvedTimestamp,
      interval_seconds: intervalSeconds,
      last_poll_at: pollAt,
    });

    const durationMs = Date.now() - startedAt;
    await logCommentScrapeTiming({
      subreddit: name,
      duration_ms: durationMs,
      success: true,
      never_scraped: neverScraped,
      comments_new: stats.new,
      comments_existing: stats.existing,
      comments_total: stats.total,
      reddit_dist: meta.reddit_dist,
      pages,
      stop_reason: ctx.stopReason,
      interval_seconds: intervalSeconds,
      oldest_comment_utc: oldestTs?.toISOString() ?? null,
      proxy_id: endpoint.id,
      proxy_index: endpoint.index,
    });

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
      stopReason: ctx.stopReason,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    await logCommentScrapeTiming({
      subreddit: name,
      duration_ms: durationMs,
      success: false,
      never_scraped: neverScraped,
      error: err.message,
      pages,
      proxy_id: endpoint.id,
      proxy: err.proxy ?? null,
    });
    throw err;
  }
}
