import { createRedditClient, getNextProxy } from './proxyPool.js';

export async function fetchRedditJson(url, params = {}) {
  const proxy = getNextProxy();
  const client = createRedditClient(proxy?.url ?? null);
  const { data } = await client.get(url, { params });
  return { data, proxyIndex: proxy?.index ?? 0 };
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
