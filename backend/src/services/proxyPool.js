import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { config } from '../config.js';
import { maskProxyUrl } from './scrapeLogger.js';

const SUPPORTED_PROTOCOLS = new Set(['socks5', 'socks4', 'http', 'https']);

let pool = buildPool();
let index = 0;

/** @type {Map<string, { total: number, success: number, failed: number }>} */
const requestCounts = new Map();

/** @type {Map<string, number>} */
const lastUsedAt = new Map();

/** Tail of per-proxy FIFO chain (next job starts when this promise settles). */
const proxyTails = new Map();

/** @type {Map<string, boolean>} */
const proxyInFlight = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function randomCooldownMs() {
  const minSec = config.proxyCooldownMinSeconds;
  const maxSec = Math.max(minSec, config.proxyCooldownMaxSeconds);
  if (maxSec <= 0) return 0;
  if (minSec <= 0) return 0;
  if (maxSec === minSec) return minSec * 1000;
  const seconds = minSec + Math.random() * (maxSec - minSec);
  return Math.floor(seconds * 1000);
}

export async function enforceProxyCooldown(endpoint) {
  const cooldownMs = randomCooldownMs();
  if (cooldownMs <= 0) return;

  const id = endpoint?.id ?? 'unknown';
  const last = lastUsedAt.get(id) ?? 0;
  const wait = cooldownMs - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  lastUsedAt.set(id, Date.now());
}

/**
 * Exactly one in-flight task per proxy ID (FIFO queue).
 * Fixes races when multiple callers enqueue at the same time.
 */
export async function runOnProxy(endpoint, fn) {
  const id = endpoint?.id ?? 'unknown';
  const prev = proxyTails.get(id) ?? Promise.resolve();

  let releaseTail;
  const tail = new Promise((resolve) => {
    releaseTail = resolve;
  });

  const run = prev.finally(async () => {
    proxyInFlight.set(id, true);
    try {
      return await fn();
    } finally {
      proxyInFlight.set(id, false);
      releaseTail();
    }
  });

  proxyTails.set(id, tail);
  return run;
}

/** True while a task holds this proxy (scrape run or single fetch). */
export function isProxyInFlight(endpoint) {
  const id = endpoint?.id ?? 'unknown';
  return proxyInFlight.get(id) === true;
}

/**
 * Hold one proxy for a full scrape: all Reddit pages run sequentially on one client,
 * with cooldown between requests — no other worker interleaves on this proxy.
 */
export async function runScrapeOnEndpoint(endpoint, fn) {
  return runOnProxy(endpoint, async () => {
    const client = createRedditClient(endpoint);
    return fn(client);
  });
}

function emptyCounts() {
  return { total: 0, success: 0, failed: 0 };
}

export function recordProxyRequest(endpoint, { success }) {
  const id = endpoint?.id ?? 'unknown';
  const counts = requestCounts.get(id) ?? emptyCounts();
  counts.total += 1;
  if (success) counts.success += 1;
  else counts.failed += 1;
  requestCounts.set(id, counts);
}

export function getProxyRequestCounts(id) {
  return requestCounts.get(id) ?? emptyCounts();
}

function parseProtocol(url) {
  try {
    const protocol = new URL(url).protocol.replace(':', '').toLowerCase();
    if (SUPPORTED_PROTOCOLS.has(protocol)) return protocol;
    throw new Error(`unsupported protocol: ${protocol}`);
  } catch (err) {
    if (err.message?.startsWith('unsupported')) throw err;
    throw new Error(`invalid proxy URL: ${url}`);
  }
}

function buildPool() {
  const endpoints = [];

  if (config.useDirect) {
    endpoints.push({
      id: 'direct',
      mode: 'direct',
      protocol: 'direct',
      url: null,
      index: 0,
    });
  }

  config.proxyUrls.forEach((url, i) => {
    endpoints.push({
      id: `PROXY_${i + 1}`,
      mode: 'proxy',
      protocol: parseProtocol(url),
      url,
      index: endpoints.length,
    });
  });

  return endpoints.map((ep, i) => ({ ...ep, index: i }));
}

export function rebuildPool() {
  pool = buildPool();
  index = 0;
  requestCounts.clear();
  lastUsedAt.clear();
  proxyTails.clear();
  proxyInFlight.clear();
}

export function getPool() {
  return pool;
}

export function getProxyCount() {
  return pool.length;
}

export function getPoolSummary() {
  return pool.map((ep) => ({
    id: ep.id,
    mode: ep.mode,
    protocol: ep.protocol,
    url_masked: ep.url ? maskProxyUrl(ep.url) : 'local-ip',
  }));
}

export function getPoolStats() {
  return pool.map((ep) => {
    const counts = getProxyRequestCounts(ep.id);
    return {
      id: ep.id,
      index: ep.index,
      mode: ep.mode,
      protocol: ep.protocol,
      url_masked: ep.url ? maskProxyUrl(ep.url) : 'local-ip',
      requests_total: counts.total,
      requests_success: counts.success,
      requests_failed: counts.failed,
    };
  });
}

/** Round-robin: pick one proxy for an entire scrape run (all pages share it). */
export function getNextEndpoint() {
  if (pool.length === 0) {
    return {
      id: 'direct',
      mode: 'direct',
      protocol: 'direct',
      url: null,
      index: 0,
    };
  }
  const endpoint = pool[index % pool.length];
  index += 1;
  return endpoint;
}

/** @deprecated alias — use getNextEndpoint */
export function acquireScrapeEndpoint() {
  return getNextEndpoint();
}

/** @deprecated use getNextEndpoint */
export function getNextProxy() {
  return getNextEndpoint();
}

export function createAgents(endpoint) {
  if (!endpoint?.url || endpoint.mode === 'direct') {
    return {};
  }

  const { url, protocol } = endpoint;

  switch (protocol) {
    case 'socks5':
    case 'socks4': {
      const agent = new SocksProxyAgent(url);
      return { httpAgent: agent, httpsAgent: agent };
    }
    case 'http': {
      const agent = new HttpProxyAgent(url);
      return { httpAgent: agent, httpsAgent: agent };
    }
    case 'https': {
      const agent = new HttpsProxyAgent(url);
      return { httpAgent: agent, httpsAgent: agent };
    }
    default:
      throw new Error(`Unsupported proxy protocol: ${protocol}`);
  }
}

/** Headers for Reddit public .json listings (not browser HTML navigation). */
export function redditRequestHeaders(url = '') {
  const headers = {
    'User-Agent': config.redditUserAgent,
    Accept: 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };

  const subMatch = String(url).match(/\/r\/([^/?]+)/i);
  headers.Referer = subMatch
    ? `https://www.reddit.com/r/${subMatch[1]}/`
    : 'https://www.reddit.com/';

  return headers;
}

export function createRedditClient(endpoint) {
  return axios.create({
    timeout: 30000,
    headers: redditRequestHeaders(),
    ...createAgents(endpoint),
  });
}

export async function checkEndpointHealth(endpoint) {
  return runOnProxy(endpoint, async () => {
    try {
      const client = createRedditClient(endpoint);
      await enforceProxyCooldown(endpoint);
      await client.get('https://www.reddit.com/new.json', {
        params: { limit: 1 },
        headers: redditRequestHeaders('https://www.reddit.com/new.json'),
      });
      return true;
    } catch {
      return false;
    }
  });
}

export async function countHealthyProxies() {
  if (pool.length === 0) return 0;
  const results = await Promise.all(pool.map((ep) => checkEndpointHealth(ep)));
  return results.filter(Boolean).length;
}
