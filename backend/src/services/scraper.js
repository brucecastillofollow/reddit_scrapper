import { pool, refreshPostCount, updateStatus } from '../db.js';
import { config } from '../config.js';
import { createRedditClient, getNextProxy, countHealthyProxies } from './proxyPool.js';

const REDDIT_SEARCH = 'https://www.reddit.com/search.json';
const MAX_PAGES = 3;

function parsePost(child, searchQuery) {
  const d = child.data;
  return {
    reddit_id: d.name,
    title: d.title || '',
    subreddit: d.subreddit || '',
    author: d.author || '[deleted]',
    permalink: d.permalink ? `https://www.reddit.com${d.permalink}` : '',
    url: d.url || '',
    score: d.score ?? 0,
    num_comments: d.num_comments ?? 0,
    created_utc: new Date((d.created_utc || 0) * 1000),
    search_query: searchQuery,
    raw_data: d,
  };
}

async function upsertPost(post) {
  const { rows } = await pool.query(
    `INSERT INTO reddit_posts
      (reddit_id, title, subreddit, author, permalink, url, score, num_comments, created_utc, search_query, raw_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (reddit_id) DO UPDATE SET
       score = EXCLUDED.score,
       num_comments = EXCLUDED.num_comments,
       scraped_at = NOW()
     RETURNING (xmax = 0) AS inserted`,
    [
      post.reddit_id,
      post.title,
      post.subreddit,
      post.author,
      post.permalink,
      post.url,
      post.score,
      post.num_comments,
      post.created_utc,
      post.search_query,
      JSON.stringify(post.raw_data),
    ],
  );
  return rows[0]?.inserted ? 1 : 0;
}

async function fetchQuery(query, proxyUrl) {
  const client = createRedditClient(proxyUrl);
  let after = null;
  let fetched = 0;
  let inserted = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = { q: query, sort: 'new', limit: 100, restrict_sr: false };
    if (after) params.after = after;

    const { data } = await client.get(REDDIT_SEARCH, { params });
    const children = data?.data?.children ?? [];
    if (children.length === 0) break;

    for (const child of children) {
      if (child.kind !== 't3') continue;
      fetched += 1;
      inserted += await upsertPost(parsePost(child, query));
    }

    after = data?.data?.after;
    if (!after) break;
  }

  return { fetched, inserted };
}

async function runQueryScrape(query) {
  const proxy = getNextProxy();
  const proxyUsed = proxy?.url ?? 'direct';
  const { rows: runRows } = await pool.query(
    `INSERT INTO scrape_runs (query, proxy_used, status) VALUES ($1, $2, 'running') RETURNING id`,
    [query, proxyUsed],
  );
  const runId = runRows[0].id;

  try {
    const { fetched, inserted } = await fetchQuery(query, proxy?.url ?? null);
    await pool.query(
      `UPDATE scrape_runs SET status = 'success', finished_at = NOW(),
       posts_fetched = $1, posts_inserted = $2 WHERE id = $3`,
      [fetched, inserted, runId],
    );
    if (proxy) await updateStatus({ active_proxy_index: proxy.index });
    return { fetched, inserted };
  } catch (err) {
    await pool.query(
      `UPDATE scrape_runs SET status = 'error', finished_at = NOW(), error_message = $1 WHERE id = $2`,
      [err.message, runId],
    );
    throw err;
  }
}

let scrapeLock = false;

export async function runScrapeCycle() {
  if (scrapeLock) return { skipped: true };
  scrapeLock = true;

  await updateStatus({
    is_running: true,
    last_started_at: new Date(),
    last_error: null,
  });

  try {
    const healthy = await countHealthyProxies();
    await updateStatus({ proxies_healthy: healthy });

    for (const query of config.searchQueries) {
      await runQueryScrape(query);
    }

    await refreshPostCount();
    await updateStatus({
      is_running: false,
      last_finished_at: new Date(),
    });
    return { skipped: false };
  } catch (err) {
    await updateStatus({
      is_running: false,
      last_finished_at: new Date(),
      last_error: err.message,
    });
    throw err;
  } finally {
    scrapeLock = false;
  }
}

export function isScrapeRunning() {
  return scrapeLock;
}
