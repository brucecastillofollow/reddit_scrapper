import { config } from '../config.js';
import { getGlobal, updateGlobal, updateScrapeStatus, recordPostScrapeRun } from '../db.js';
import { fetchRedditJson } from './redditFetch.js';
import { shortenInterval, lengthenInterval, shouldAdjustInterval } from './intervalAdjust.js';
import { toUtcDate } from './scrapeBounds.js';
import { paginateWithAfter } from './listingPagination.js';
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

async function processPostChild(child, stats) {
  if (child.kind !== 't3' || !child.data?.id) return null;

  const d = child.data;
  const type = 't3';
  const dataId = String(d.id);
  const fields = typedFieldsFromPost(d);
  const createdUtc = toUtcDate(fields.created_utc);

  await ensureSubreddit(fields.subreddit);

  if (!(await globalIdExists(type, dataId))) {
    await insertGlobalId(type, dataId, createdUtc);
  }

  if (await postExists(dataId)) {
    await updatePost(fields);
    stats.existing += 1;
  } else {
    await insertPost(fields);
    stats.new += 1;
  }
  stats.total += 1;
  return createdUtc;
}

async function fetchNewPage(params) {
  return fetchRedditJson(NEW_URL, params, { kind: 'posts', target: 'new.json' });
}

export async function runPostScrape() {
  const global = await getGlobal();
  const stats = { new: 0, existing: 0, total: 0 };
  const bootstrap = global.last_id == null;
  let newestTs = global.last_timestamp ? toUtcDate(global.last_timestamp) : null;

  const { savedLastId, pages, lastPageCount, proxyIndex } = await paginateWithAfter({
    bootstrap,
    startAfter: global.last_id,
    maxPages: bootstrap ? 1 : config.maxPaginationPages,
    fetchPage: async (params) => {
      const { data, proxyIndex: pi } = await fetchNewPage(params);
      return { listing: data, proxyIndex: pi };
    },
    processPage: async (children) => {
      for (const child of children) {
        const createdUtc = await processPostChild(child, stats);
        if (createdUtc && (!newestTs || createdUtc > newestTs)) {
          newestTs = createdUtc;
        }
      }
    },
  });

  const { allNew, mostlyExisting } = shouldAdjustInterval(
    stats.existing,
    stats.new,
    stats.total,
  );

  let intervalSeconds = global.interval_seconds;

  if (allNew && !bootstrap && lastPageCount >= 100) {
    intervalSeconds = shortenInterval(intervalSeconds);
  } else if (mostlyExisting) {
    intervalSeconds = lengthenInterval(intervalSeconds);
  }

  const pollAt = new Date();
  const globalUpdate = {
    interval_seconds: intervalSeconds,
    last_poll_at: pollAt,
  };
  if (savedLastId) globalUpdate.last_id = savedLastId;
  if (newestTs) globalUpdate.last_timestamp = newestTs;
  await updateGlobal(globalUpdate);

  await recordPostScrapeRun(stats);
  await updateScrapeStatus({
    active_proxy_index: proxyIndex ?? 0,
    last_post_finished_at: pollAt,
    last_post_error: null,
  });

  return {
    stats,
    intervalSeconds,
    allNew,
    mostlyExisting,
    pages,
    bootstrap,
    lastId: savedLastId,
  };
}
