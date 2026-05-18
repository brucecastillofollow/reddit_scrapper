import { config } from '../config.js';
import { updateScrapeStatus, recordCommentScrapeRun } from '../db.js';
import { fetchRedditJson } from './redditFetch.js';
import { logCommentScrapeTiming } from './scrapeLogger.js';
import { shortenInterval, lengthenInterval, shouldAdjustInterval } from './intervalAdjust.js';
import { toUtcDate, utcNow } from './scrapeBounds.js';
import { paginateWithAfter } from './listingPagination.js';
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

async function processCommentChild(child, stats) {
  if (child.kind !== 't1' || !child.data?.id) return null;

  const d = child.data;
  const type = 't1';
  const dataId = String(d.id);
  const fields = typedFieldsFromComment(d);
  const createdUtc = toUtcDate(fields.created_utc);

  if (!(await globalIdExists(type, dataId))) {
    await insertGlobalId(type, dataId, createdUtc);
  }

  if (await commentExists(dataId)) {
    await updateComment(fields);
    stats.existing += 1;
  } else {
    await insertComment(fields);
    stats.new += 1;
  }
  stats.total += 1;
  return createdUtc;
}

export async function runCommentScrapeForSubreddit(subRow, endpoint) {
  const { name, last_id, last_timestamp, interval_seconds: currentInterval } = subRow;
  const bootstrap = last_id == null;
  const startedAt = Date.now();
  const stats = { new: 0, existing: 0, total: 0 };
  let newestTs = last_timestamp ? toUtcDate(last_timestamp) : null;
  let pages = 0;

  try {
    const { savedLastId, pages: pageCount, lastPageCount } = await paginateWithAfter({
      bootstrap,
      startAfter: last_id,
      maxPages: bootstrap ? 1 : config.maxPaginationPages,
      fetchPage: async (params) => {
        const { data } = await fetchRedditJson(
          commentsUrl(name),
          params,
          fetchMeta(name),
          endpoint,
        );
        return { listing: data };
      },
      processPage: async (children) => {
        for (const child of children) {
          const createdUtc = await processCommentChild(child, stats);
          if (createdUtc && (!newestTs || createdUtc > newestTs)) {
            newestTs = createdUtc;
          }
        }
      },
    });

    pages = pageCount;

    let intervalSeconds = currentInterval;

    if (!bootstrap) {
      const { allNew, mostlyExisting } = shouldAdjustInterval(
        stats.existing,
        stats.new,
        stats.total,
      );

      if (allNew && lastPageCount >= 100) {
        intervalSeconds = shortenInterval(intervalSeconds);
      } else if (mostlyExisting) {
        intervalSeconds = lengthenInterval(intervalSeconds);
      }
    }

    const pollAt = utcNow();
    const subUpdate = {
      interval_seconds: intervalSeconds,
      last_poll_at: pollAt,
    };
    if (savedLastId) subUpdate.last_id = savedLastId;
    if (newestTs) subUpdate.last_timestamp = newestTs;
    else if (bootstrap) subUpdate.last_timestamp = pollAt;

    await updateSubreddit(name, subUpdate);

    const durationMs = Date.now() - startedAt;
    await logCommentScrapeTiming({
      subreddit: name,
      duration_ms: durationMs,
      success: true,
      bootstrap,
      comments_new: stats.new,
      comments_existing: stats.existing,
      comments_total: stats.total,
      pages,
      last_id: savedLastId,
      interval_seconds: intervalSeconds,
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
      bootstrap,
      lastId: savedLastId,
      endpoint,
    };
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
