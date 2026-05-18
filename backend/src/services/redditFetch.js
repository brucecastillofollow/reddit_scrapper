import { createRedditClient, getNextEndpoint, recordProxyRequest } from './proxyPool.js';
import { describeEndpoint, enrichError, logScrapeFailure } from './scrapeLogger.js';

export async function fetchRedditJson(url, params = {}, meta = {}, endpoint = null) {
  const ep = endpoint ?? getNextEndpoint();
  const client = createRedditClient(ep);

  try {
    const { data } = await client.get(url, { params });
    recordProxyRequest(ep, { success: true });
    return { data, proxyIndex: ep.index, endpoint: ep };
  } catch (err) {
    recordProxyRequest(ep, { success: false });
    const proxyInfo = describeEndpoint(ep);
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
    throw enrichError(err, ep);
  }
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
