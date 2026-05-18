import { config } from '../config.js';
import { updateScrapeStatus } from '../db.js';
import { fetchRedditJson } from './redditFetch.js';
import { sleepBeforeScrape } from './scrapeDelay.js';
import { logCommentScrapeTiming } from './scrapeLogger.js';
import { shortenInterval, lengthenInterval, shouldAdjustInterval } from './intervalAdjust.js';
import { toUtcDate, isAtOrBeforeUtc, utcCommentCutoff, utcNow } from './scrapeBounds.js';
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

function createCommentScrapeContext({ bootstrap = false } = {}) {
  return {
    bootstrap,
    cutoff: bootstrap ? null : utcCommentCutoff(),
    stopped: false,
    stopReason: bootstrap ? 'bootstrap' : null,
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

  if (!ctx.bootstrap && isAtOrBeforeUtc(createdUtc, ctx.cutoff)) {
    ctx.stopped = true;
    ctx.stopReason = 'cutoff';
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
    if (!ctx.bootstrap) {
      ctx.stopped = true;
      ctx.stopReason = 'existing';
    }
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

export async function runCommentScrapeForSubreddit(subRow, endpoint) {
  const { name, last_timestamp, interval_seconds: currentInterval } = subRow;
  const bootstrap = last_timestamp == null;
  const startedAt = Date.now();
  const stats = { new: 0, existing: 0, total: 0 };
  const ctx = createCommentScrapeContext({ bootstrap });
  let newestTs = last_timestamp ? toUtcDate(last_timestamp) : null;
  let pages = 0;

  try {
    await sleepBeforeScrape();

    let { data: listing } = await fetchRedditJson(
      commentsUrl(name),
      { limit: 100 },
      fetchMeta(name),
      endpoint,
    );

    pages = 1;
    let meta = await processListing(listing, stats, ctx);
    if (meta.newestTs && (!newestTs || meta.newestTs > newestTs)) {
      newestTs = meta.newestTs;
    }

    if (!bootstrap) {
      while (!ctx.stopped && meta.after && pages < config.maxPaginationPages) {
        ({ data: listing } = await fetchRedditJson(
          commentsUrl(name),
          { limit: 100, before: meta.after },
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

    let intervalSeconds = currentInterval;

    if (!bootstrap) {
      const { allNew, mostlyExisting } = shouldAdjustInterval(
        stats.existing,
        stats.new,
        stats.total,
      );

      if (allNew && meta.after && !ctx.stopped) {
        intervalSeconds = shortenInterval(intervalSeconds);
      } else if (mostlyExisting) {
        intervalSeconds = lengthenInterval(intervalSeconds);
      }
    }

    const pollAt = utcNow();
    const resolvedTimestamp = newestTs || (bootstrap ? pollAt : last_timestamp);
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
      bootstrap,
      comments_new: stats.new,
      comments_existing: stats.existing,
      comments_total: stats.total,
      reddit_dist: meta.reddit_dist,
      pages,
      stop_reason: ctx.stopReason,
      cutoff_utc: ctx.cutoff?.toISOString() ?? null,
      interval_seconds: intervalSeconds,
      proxy_id: endpoint.id,
      proxy_index: endpoint.index,
    });

    await updateScrapeStatus({
      active_proxy_index: endpoint.index,
      last_comment_finished_at: pollAt,
      last_comment_error: null,
    });

    return { name, stats, intervalSeconds, durationMs, pages, endpoint, stopReason: ctx.stopReason };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    await logCommentScrapeTiming({
      subreddit: name,
      duration_ms: durationMs,
      success: false,
      error: err.message,
      pages,
      proxy_id: endpoint.id,
      proxy: err.proxy ?? null,
    });
    throw err;
  }
}
