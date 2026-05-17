import { config } from '../config.js';
import { updateScrapeStatus } from '../db.js';
import { fetchRedditJson } from './redditFetch.js';
import { logCommentScrapeTiming } from './scrapeLogger.js';
import { shortenInterval, lengthenInterval, shouldAdjustInterval } from './intervalAdjust.js';
import {
  typedFieldsFromComment,
  commentExists,
  globalIdExists,
  insertGlobalId,
  insertComment,
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

async function processCommentChild(child, stats, newestTs) {
  if (child.kind !== 't1' || !child.data?.id) return newestTs;

  const d = child.data;
  const type = 't1';
  const dataId = String(d.id);
  const fields = typedFieldsFromComment(d);
  let latest = newestTs;

  if (!newestTs || fields.created_utc > newestTs) {
    latest = fields.created_utc;
  }

  if (!(await globalIdExists(type, dataId))) {
    await insertGlobalId(type, dataId, fields.created_utc);
  }

  if (await commentExists(dataId)) {
    await updateComment(fields);
    stats.existing += 1;
  } else {
    await insertComment(fields);
    stats.new += 1;
  }

  return latest;
}

async function processListing(listing, stats) {
  const children = listing?.data?.children ?? [];
  let newestTs = null;

  for (const child of children) {
    newestTs = await processCommentChild(child, stats, newestTs);
  }

  stats.total += children.filter((c) => c.kind === 't1').length;
  return {
    after: listing?.data?.after ?? null,
    reddit_dist: listing?.data?.dist ?? children.length,
    newestTs,
  };
}

export async function runCommentScrapeForSubreddit(subRow, endpoint) {
  const { name, last_timestamp, interval_seconds: currentInterval } = subRow;
  const startedAt = Date.now();
  const stats = { new: 0, existing: 0, total: 0 };
  let newestTs = last_timestamp ? new Date(last_timestamp) : null;
  let pages = 1;

  try {
    let { data: listing } = await fetchRedditJson(
      commentsUrl(name),
      { limit: 100 },
      fetchMeta(name),
      endpoint,
    );

    let meta = await processListing(listing, stats);
    if (meta.newestTs && (!newestTs || meta.newestTs > newestTs)) {
      newestTs = meta.newestTs;
    }

    const { allNew, mostlyExisting } = shouldAdjustInterval(
      stats.existing,
      stats.new,
      stats.total,
    );

    let intervalSeconds = currentInterval;

    if (allNew && meta.after) {
      let before = meta.after;
      let extraPages = 0;
      while (before && extraPages < config.maxPaginationPages) {
        ({ data: listing } = await fetchRedditJson(
          commentsUrl(name),
          { limit: 100, before },
          fetchMeta(name),
          endpoint,
        ));
        const pageStats = { new: 0, existing: 0, total: 0 };
        meta = await processListing(listing, pageStats);
        stats.new += pageStats.new;
        stats.existing += pageStats.existing;
        stats.total += pageStats.total;

        if (meta.newestTs && (!newestTs || meta.newestTs > newestTs)) {
          newestTs = meta.newestTs;
        }

        if (pageStats.existing > 0) break;
        before = meta.after;
        extraPages += 1;
        pages += 1;
      }
      intervalSeconds = shortenInterval(intervalSeconds);
    } else if (mostlyExisting) {
      intervalSeconds = lengthenInterval(intervalSeconds);
    }

    await updateSubreddit(name, {
      last_timestamp: newestTs || last_timestamp,
      interval_seconds: intervalSeconds,
      last_poll_at: new Date(),
    });

    const durationMs = Date.now() - startedAt;
    await logCommentScrapeTiming({
      subreddit: name,
      duration_ms: durationMs,
      success: true,
      comments_new: stats.new,
      comments_existing: stats.existing,
      comments_total: stats.total,
      reddit_dist: meta.reddit_dist,
      pages,
      interval_seconds: intervalSeconds,
      proxy_id: endpoint.id,
      proxy_index: endpoint.index,
    });

    await updateScrapeStatus({
      active_proxy_index: endpoint.index,
      last_comment_finished_at: new Date(),
      last_comment_error: null,
    });

    return { name, stats, intervalSeconds, durationMs, pages, endpoint };
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
