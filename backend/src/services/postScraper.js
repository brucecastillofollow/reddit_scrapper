import { config } from '../config.js';
import { getGlobal, updateGlobal, updateScrapeStatus } from '../db.js';
import { fetchRedditJson } from './redditFetch.js';
import { shortenInterval, lengthenInterval, shouldAdjustInterval } from './intervalAdjust.js';
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

async function processPostChild(child, stats, newestTs) {
  if (child.kind !== 't3' || !child.data?.id) return newestTs;

  const d = child.data;
  const type = 't3';
  const dataId = String(d.id);
  const fields = typedFieldsFromPost(d);
  let latest = newestTs;

  if (!newestTs || fields.created_utc > newestTs) {
    latest = fields.created_utc;
  }

  await ensureSubreddit(fields.subreddit);

  if (!(await globalIdExists(type, dataId))) {
    await insertGlobalId(type, dataId, fields.created_utc);
  }

  if (await postExists(dataId)) {
    await updatePost(fields);
    stats.existing += 1;
  } else {
    await insertPost(fields);
    stats.new += 1;
  }

  return latest;
}

async function processListing(listing, stats) {
  const children = listing?.data?.children ?? [];
  let newestTs = null;

  for (const child of children) {
    newestTs = await processPostChild(child, stats, newestTs);
  }

  stats.total += children.filter((c) => c.kind === 't3').length;
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
  let newestTs = global.last_timestamp ? new Date(global.last_timestamp) : null;
  let proxyIndex = 0;

  let { data: listing, proxyIndex: pi } = await fetchNewPage();
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

  let intervalSeconds = global.interval_seconds;

  if (allNew && meta.after) {
    let before = meta.after;
    let pages = 0;
    while (before && pages < config.maxPaginationPages) {
      ({ data: listing, proxyIndex: pi } = await fetchNewPage({ before }));
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

  if (newestTs) {
    await updateGlobal({
      last_timestamp: newestTs,
      interval_seconds: intervalSeconds,
      last_poll_at: new Date(),
    });
  } else {
    await updateGlobal({
      interval_seconds: intervalSeconds,
      last_poll_at: new Date(),
    });
  }

  await updateScrapeStatus({
    active_proxy_index: proxyIndex,
    last_post_finished_at: new Date(),
    last_post_error: null,
  });

  return { stats, intervalSeconds, allNew, mostlyExisting };
}
