import { config } from '../config.js';
import { updateScrapeStatus } from '../db.js';
import { fetchRedditJson } from './redditFetch.js';
import { shortenInterval, lengthenInterval, shouldAdjustInterval } from './intervalAdjust.js';
import {
  typedFieldsFromComment,
  commentExists,
  globalIdExists,
  insertGlobalId,
  insertComment,
  updateComment,
  getSubredditsDueForComments,
  updateSubreddit,
} from './entityStore.js';

function commentsUrl(subreddit) {
  return `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/comments.json`;
}

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
    newestTs,
  };
}

export async function runCommentScrapeForSubreddit(subRow) {
  const { name, last_timestamp, interval_seconds: currentInterval } = subRow;
  const stats = { new: 0, existing: 0, total: 0 };
  let newestTs = last_timestamp ? new Date(last_timestamp) : null;
  let proxyIndex = 0;

  let { data: listing, proxyIndex: pi } = await fetchRedditJson(commentsUrl(name), {
    limit: 100,
  });
  proxyIndex = pi;

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
    let pages = 0;
    while (before && pages < config.maxPaginationPages) {
      ({ data: listing, proxyIndex: pi } = await fetchRedditJson(commentsUrl(name), {
        limit: 100,
        before,
      }));
      proxyIndex = pi;
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

  return { name, stats, intervalSeconds, proxyIndex };
}

export async function runCommentScrapeBatch() {
  const subs = await getSubredditsDueForComments(config.commentConcurrency);
  const results = await Promise.all(
    subs.map((sub) =>
      runCommentScrapeForSubreddit(sub).catch((err) => {
        console.error(`[comments] r/${sub.name}:`, err.message);
        return null;
      }),
    ),
  );

  const ok = results.filter(Boolean);
  if (ok.length > 0) {
    const last = ok[ok.length - 1];
    await updateScrapeStatus({
      active_proxy_index: last.proxyIndex,
      last_comment_finished_at: new Date(),
      last_comment_error: null,
    });
  }

  return results;
}
