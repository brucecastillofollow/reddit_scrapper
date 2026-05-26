import {
  getEndpointsForFailover,
  getNextDbEndpoint,
  runScrapeOnEndpoint,
} from './proxyPool.js';

/**
 * One DB proxy per scrape (best pick). Any failure → env proxies only.
 */
export async function runWithDbThenEnvFailover(runOnEndpoint) {
  let lastErr;
  const dbEndpoint = getNextDbEndpoint();

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
  }

  const envEndpoints = getEndpointsForFailover(null, { source: 'env' });
  for (let i = 0; i < envEndpoints.length; i += 1) {
    const endpoint = envEndpoints[i];
    try {
      console.log(`[scrape] env fallback ${endpoint.id}`);
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
