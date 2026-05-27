import {
  createRedditClient,
  ensureRedditSession,
  enforceProxyCooldown,
  getNextEndpoint,
  invalidateRedditSession,
  isProxyInfrastructureError,
  recordProxyRequest,
  redditRequestHeaders,
  runOnProxy,
} from './proxyPool.js';
import { persistCookieJar, schedulePersistCookieJar } from './proxyCookieJar.js';
import { recordProxyHttpError, recordProxySuccess } from './proxyHealth.js';
import { describeEndpoint, enrichError, logScrapeFailure } from './scrapeLogger.js';

/**
 * Single Reddit GET using an existing client (inside runScrapeOnEndpoint).
 * Enforces cooldown between paginated pages on the same proxy.
 */
export async function fetchRedditJsonWithClient(client, url, params, meta, endpoint) {
  await enforceProxyCooldown(endpoint);

  try {
    const { data } = await client.get(url, {
      params,
      headers: redditRequestHeaders(url),
    });
    recordProxyRequest(endpoint, { success: true });
    recordProxySuccess(endpoint);
    schedulePersistCookieJar(endpoint);
    return { data, proxyIndex: endpoint.index, endpoint };
  } catch (err) {
    recordProxyRequest(endpoint, { success: false, err });
    const status = err.response?.status ?? null;
    if (isProxyInfrastructureError(err) && recordProxyHttpError(endpoint, status)) {
      await invalidateRedditSession(endpoint);
    }
    const proxyInfo = describeEndpoint(endpoint);
    await logScrapeFailure({
      kind: meta.kind || 'fetch',
      target: meta.target || url,
      subreddit: meta.subreddit ?? null,
      url,
      params,
      proxy: proxyInfo,
      error: err.message,
      status: err.response?.status ?? null,
    });
    throw enrichError(err, endpoint);
  }
}

/**
 * Fetch Reddit JSON. Pass `endpoint` to pin a proxy; uses one queue slot per call.
 * For multi-page scrapes prefer runScrapeOnEndpoint + fetchRedditJsonWithClient.
 */
export async function fetchRedditJson(url, params = {}, meta = {}, endpoint = null) {
  const ep = endpoint ?? getNextEndpoint();

  return runOnProxy(ep, async () => {
    const client = await createRedditClient(ep);
    await ensureRedditSession(client, ep);
    try {
      return await fetchRedditJsonWithClient(client, url, params, meta, ep);
    } finally {
      await persistCookieJar(ep);
    }
  });
}

export function parseFullname(name) {
  if (!name || typeof name !== 'string') return { type: null, dataId: null };
  const idx = name.indexOf('_');
  if (idx === -1) return { type: null, dataId: name };
  return { type: name.slice(0, idx), dataId: name.slice(idx + 1) };
}

export function toTimestamp(data) {
  const sec = data.created_utc ?? data.created;
  return sec ? new Date(sec * 1000) : new Date();
}
