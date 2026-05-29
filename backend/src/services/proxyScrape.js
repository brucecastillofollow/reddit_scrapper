import {
  getEligibleDbProxyCount,
  getEndpointsForFailover,
  getNextDbEndpoint,
  getNextEnvEndpoint,
  getDbProxyCount,
  runScrapeOnEndpoint,
} from './proxyPool.js';
import { getWebshareEndpoint } from './webshareProxy.js';

/**
 * Post scraper: env proxies only (PROXY_1…, PROXY_LIST, direct). Rotates on each scrape.
 * Tries next env proxy on failure within the same run.
 */
export async function runWithEnvRotating(runOnEndpoint) {
  const envEndpoints = getEndpointsForFailover(null, { source: 'env' });
  if (!envEndpoints.length) {
    throw new Error(
      'Post scrape failed: no env proxies (set PROXY_1, PROXY_LIST, or USE_DIRECT=true)',
    );
  }

  const first = getNextEnvEndpoint();
  const startIndex = Math.max(
    0,
    envEndpoints.findIndex((e) => e.id === first?.id),
  );

  let lastErr;
  for (let i = 0; i < envEndpoints.length; i += 1) {
    const endpoint = envEndpoints[(startIndex + i) % envEndpoints.length];
    try {
      if (i === 0) {
        console.log(`[post-scrape] env ${endpoint.id}`);
      } else {
        console.log(`[post-scrape] env rotate ${endpoint.id}`);
      }
      return await runOnEndpoint(endpoint);
    } catch (err) {
      lastErr = err;
      const status = err.response?.status ?? err.status ?? null;
      const hasNext = i < envEndpoints.length - 1;
      console.warn(
        `[post-scrape] env ${endpoint.id} failed` +
          (status ? ` (${status})` : ` (${err.message})`) +
          (hasNext ? ' — next env proxy' : ''),
      );
    }
  }

  throw lastErr ?? new Error('Post scrape failed: all env proxies failed');
}

/**
 * Comment scraper: DB proxies table only (no .env fallback).
 */
export async function runWithDbOnly(runOnEndpoint) {
  const endpoint = await getNextDbEndpoint();
  if (!endpoint) {
    const msg =
      getDbProxyCount() > 0
        ? `Comment scrape failed: no eligible db proxy (${getEligibleDbProxyCount()}/${getDbProxyCount()} ready)`
        : 'Comment scrape failed: no proxies in database';
    throw new Error(msg);
  }

  return runOnEndpoint(endpoint);
}

/** Webshare rotating proxy — one endpoint slot per concurrent task (parallel-safe). */
export async function runWithWebshareSlot(runOnEndpoint, slot) {
  const endpoint = getWebshareEndpoint(slot);
  if (!endpoint) {
    throw new Error('Webshare comment scrape failed: WEBSHARE_PROXY_URL not configured');
  }
  return runOnEndpoint(endpoint);
}

/** @deprecated use runWithEnvRotating (posts) or runWithDbOnly (comments) */
export async function runWithDbThenEnvFailover(runOnEndpoint) {
  let lastErr;
  const dbEndpoint = await getNextDbEndpoint();

  if (dbEndpoint) {
    try {
      return await runOnEndpoint(dbEndpoint);
    } catch (err) {
      lastErr = err;
      const status = err.response?.status ?? err.status ?? null;
      console.warn(
        `[scrape] db ${dbEndpoint.id} failed` +
          (status ? ` (${status})` : ` (${err.message})`) +
          ` — env fallback`,
      );
    }
  } else if (getDbProxyCount() > 0) {
    console.log(
      `[scrape] no eligible db proxy (${getEligibleDbProxyCount()}/${getDbProxyCount()} ready) — using env`,
    );
  }

  const envEndpoints = getEndpointsForFailover(null, { source: 'env' });
  for (let i = 0; i < envEndpoints.length; i += 1) {
    const endpoint = envEndpoints[i];
    try {
      if (i === 0 && !dbEndpoint) {
        console.log(`[scrape] env ${endpoint.id}`);
      } else {
        console.log(`[scrape] env fallback ${endpoint.id}`);
      }
      return await runOnEndpoint(endpoint);
    } catch (err) {
      lastErr = err;
      const status = err.response?.status ?? err.status ?? null;
      const hasNext = i < envEndpoints.length - 1;
      console.warn(
        `[scrape] env ${endpoint.id} failed` +
          (status ? ` (${status})` : ` (${err.message})`) +
          (hasNext ? ' — next env proxy' : ''),
      );
    }
  }

  throw lastErr ?? new Error('Scrape failed: no proxies available');
}

export async function runScrapeWithDbThenEnvFailover(fn) {
  return runWithDbThenEnvFailover((endpoint) => runScrapeOnEndpoint(endpoint, fn));
}
