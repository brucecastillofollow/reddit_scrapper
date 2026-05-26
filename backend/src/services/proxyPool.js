import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { config } from '../config.js';
import { maskProxyUrl } from './scrapeLogger.js';
import {
  buildProxyUrl,
  listEnabledProxiesForPool,
  recordProxyRequestResult,
} from './proxyRepository.js';
import {
  clearAllCookieJars,
  clearCookieJar,
  getCookieJar,
  hasRedditSession,
  persistCookieJar,
  schedulePersistCookieJar,
} from './proxyCookieJar.js';
import {
  clearAllProxyHealth,
  getProxyHealthSnapshot,
  isProxyQuarantined,
} from './proxyHealth.js';

const SUPPORTED_PROTOCOLS = new Set(['socks5', 'socks4', 'http', 'https']);

let dbPool = [];
let envPool = [];
let pool = [];
let index = 0;

/** @type {Map<string, { total: number, success: number, failed: number }>} */
const requestCounts = new Map();

/** @type {Map<string, number>} */
const lastUsedAt = new Map();

const proxyTails = new Map();
const proxyInFlight = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function rowToEndpoint(row, idx) {
  const url = buildProxyUrl(row);
  return {
    id: `db_${row.id}`,
    source: 'db',
    proxyDbId: row.id,
    mode: 'proxy',
    protocol: row.protocol,
    url,
    host: row.host,
    port: row.port,
    index: idx,
    dbStats: {
      last_success_at: row.last_success_at,
      total_success_request_count: Number(row.total_success_request_count ?? 0),
      total_failed_request_count: Number(row.total_failed_request_count ?? 0),
    },
  };
}

function buildEnvEndpoints(startIndex) {
  const endpoints = [];
  let idx = startIndex;

  if (config.useDirect) {
    endpoints.push({
      id: 'direct',
      source: 'env',
      proxyDbId: null,
      mode: 'direct',
      protocol: 'direct',
      url: null,
      index: idx,
    });
    idx += 1;
  }

  config.proxyUrls.forEach((url, i) => {
    endpoints.push({
      id: `env_${i + 1}`,
      source: 'env',
      proxyDbId: null,
      mode: 'proxy',
      protocol: parseProtocol(url),
      url,
      index: idx,
    });
    idx += 1;
  });

  return endpoints;
}

export async function refreshProxyPool() {
  const rows = await listEnabledProxiesForPool();
  dbPool = rows.map((row, i) => rowToEndpoint(row, i));
  envPool = buildEnvEndpoints(dbPool.length);
  pool = [...dbPool, ...envPool];
  index = 0;
  console.log(
    `[proxy-pool] loaded ${dbPool.length} db + ${envPool.length} env/fallback (${pool.length} total)`,
  );
}

function rebuildPoolSync() {
  envPool = buildEnvEndpoints(dbPool.length);
  pool = [...dbPool, ...envPool];
  index = 0;
}

export function rebuildPool() {
  rebuildPoolSync();
  requestCounts.clear();
  lastUsedAt.clear();
  proxyTails.clear();
  proxyInFlight.clear();
  clearAllCookieJars();
  clearAllProxyHealth();
}

export function isProxyRequestError(err) {
  if (!err) return false;
  const status = err.response?.status ?? err.status ?? null;
  if (status === 403 || status === 407 || status === 502 || status === 503) return true;
  const code = err.code ?? '';
  const msg = String(err.message || '').toLowerCase();
  return (
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EPROTO'].includes(code) ||
    msg.includes('proxy') ||
    msg.includes('tunnel') ||
    msg.includes('socket') ||
    msg.includes('timeout')
  );
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

function randomCooldownMs() {
  const minSec = config.proxyCooldownMinSeconds;
  const maxSec = Math.max(minSec, config.proxyCooldownMaxSeconds);
  if (maxSec <= 0 || minSec <= 0) return 0;
  if (maxSec === minSec) return minSec * 1000;
  const seconds = minSec + Math.random() * (maxSec - minSec);
  return Math.floor(seconds * 1000);
}

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

export function isProxyInFlight(endpoint) {
  const id = endpoint?.id ?? 'unknown';
  return proxyInFlight.get(id) === true;
}

export async function runScrapeOnEndpoint(endpoint, fn) {
  return runOnProxy(endpoint, async () => {
    const client = await createRedditClient(endpoint);
    await ensureRedditSession(client, endpoint);
    try {
      return await fn(client);
    } finally {
      await persistCookieJar(endpoint);
    }
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

  if (endpoint?.source === 'db' && endpoint.proxyDbId) {
    if (endpoint.dbStats) {
      if (success) {
        endpoint.dbStats.total_success_request_count += 1;
        endpoint.dbStats.last_success_at = new Date();
      } else {
        endpoint.dbStats.total_failed_request_count += 1;
      }
    }
    recordProxyRequestResult(endpoint.proxyDbId, success).catch(() => {});
  }
}

function failureCount(endpoint) {
  return endpoint?.dbStats?.total_failed_request_count ?? 0;
}

/** No requests recorded in DB yet. */
function isNeverUsed(endpoint) {
  const s = endpoint?.dbStats;
  return (s?.total_success_request_count ?? 0) === 0 && (s?.total_failed_request_count ?? 0) === 0;
}

/** Older last_success_at first; null = never succeeded (oldest). */
function lastSuccessTime(endpoint) {
  const at = endpoint?.dbStats?.last_success_at;
  if (!at) return 0;
  return new Date(at).getTime();
}

function compareDbEndpoints(a, b) {
  const failDiff = failureCount(a) - failureCount(b);
  if (failDiff !== 0) return failDiff;

  const neverA = isNeverUsed(a);
  const neverB = isNeverUsed(b);
  if (neverA !== neverB) return neverA ? -1 : 1;

  const timeDiff = lastSuccessTime(a) - lastSuccessTime(b);
  if (timeDiff !== 0) return timeDiff;

  return (a.proxyDbId ?? 0) - (b.proxyDbId ?? 0);
}

/** Lowest failures → never used → oldest last_success_at. */
function sortedDbEndpoints() {
  return [...dbPool].sort(compareDbEndpoints);
}

function pickFromSortedDbList(list) {
  if (!list.length) return null;
  const healthy = list.filter((ep) => !isProxyQuarantined(ep));
  const sorted = (healthy.length > 0 ? healthy : list).sort(compareDbEndpoints);
  const minFail = failureCount(sorted[0]);
  const tier = sorted.filter((ep) => failureCount(ep) === minFail);

  const neverUsed = tier.filter(isNeverUsed);
  const pickPool = neverUsed.length > 0 ? neverUsed : tier;

  const endpoint = pickPool[index % pickPool.length];
  index = (index + 1) % Math.max(pickPool.length, 1);
  return endpoint;
}

export function getProxyRequestCounts(id) {
  return requestCounts.get(id) ?? emptyCounts();
}

export {
  isProxyQuarantined,
  getProxyHealthSnapshot,
  getProxyQuarantineRemainingMs,
} from './proxyHealth.js';

export function getPool() {
  return pool;
}

export function getDbPool() {
  return dbPool;
}

export function getEnvPool() {
  return envPool;
}

export function getProxyCount() {
  return pool.length;
}

export function getDbProxyCount() {
  return dbPool.length;
}

export function getPoolSummary() {
  return pool.map((ep) => ({
    id: ep.id,
    source: ep.source,
    mode: ep.mode,
    protocol: ep.protocol,
    url_masked: ep.url ? maskProxyUrl(ep.url) : ep.mode === 'direct' ? 'local-ip' : '—',
  }));
}

export function getPoolStats() {
  const healthById = new Map(getProxyHealthSnapshot().map((h) => [h.id, h]));
  return pool.map((ep) => {
    const counts = getProxyRequestCounts(ep.id);
    const health = healthById.get(ep.id);
    const db = ep.dbStats;
    return {
      id: ep.id,
      source: ep.source,
      proxy_db_id: ep.proxyDbId,
      index: ep.index,
      mode: ep.mode,
      protocol: ep.protocol,
      host: ep.host ?? null,
      url_masked: ep.url ? maskProxyUrl(ep.url) : 'local-ip',
      requests_total: counts.total,
      requests_success: counts.success,
      requests_failed: counts.failed,
      last_success_at: db?.last_success_at ?? null,
      total_success_request_count: db?.total_success_request_count ?? null,
      total_failed_request_count: db?.total_failed_request_count ?? null,
      quarantined: health?.quarantined ?? false,
      quarantine_remaining_sec: health?.quarantine_remaining_sec ?? 0,
      consecutive_403: health?.consecutive_403 ?? 0,
    };
  });
}

function filterPool({ source } = {}) {
  if (source === 'db') return dbPool.length ? dbPool : [];
  if (source === 'env') return envPool.length ? envPool : [];
  return pool;
}

export function getEndpointsForFailover(_firstEndpoint = null, { source } = {}) {
  if (source === 'db') {
    const sorted = sortedDbEndpoints();
    if (!sorted.length) return [];
    const healthy = sorted.filter((ep) => !isProxyQuarantined(ep));
    const quarantined = sorted.filter((ep) => isProxyQuarantined(ep));
    return healthy.length > 0 ? healthy : quarantined;
  }

  const list = filterPool({ source });
  if (list.length === 0) {
    return envPool.length
      ? envPool
      : [
          {
            id: 'direct',
            source: 'env',
            mode: 'direct',
            protocol: 'direct',
            url: null,
            index: 0,
          },
        ];
  }

  const healthy = list.filter((ep) => !isProxyQuarantined(ep));
  const quarantined = list.filter((ep) => isProxyQuarantined(ep));
  return healthy.length > 0 ? healthy : quarantined;
}

export function getNextEndpoint({ source } = {}) {
  if (source === 'db') {
    const sorted = sortedDbEndpoints();
    if (!sorted.length) return null;
    return pickFromSortedDbList(sorted);
  }

  const list = filterPool({ source });
  if (list.length === 0) {
    return getNextEndpoint({ source: 'env' });
  }

  const n = list.length;
  for (let i = 0; i < n; i += 1) {
    const endpoint = list[(index + i) % n];
    if (!isProxyQuarantined(endpoint)) {
      index = (index + i + 1) % Math.max(pool.length, 1);
      return endpoint;
    }
  }

  const endpoint = list[index % n];
  index += 1;
  return endpoint;
}

/** Prefer DB proxies; returns null only when db pool empty. */
export function getNextDbEndpoint() {
  return getNextEndpoint({ source: 'db' });
}

export function acquireScrapeEndpoint() {
  return getNextDbEndpoint() ?? getNextEndpoint({ source: 'env' });
}

export function getNextProxy() {
  return acquireScrapeEndpoint();
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

export function redditBootstrapHeaders() {
  return {
    'User-Agent': config.redditUserAgent,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
  };
}

function attachCookieJar(client, jar) {
  client.interceptors.request.use(async (reqConfig) => {
    const url = axios.getUri(reqConfig);
    const cookieHeader = await jar.getCookieString(url);
    if (cookieHeader) {
      reqConfig.headers = reqConfig.headers ?? {};
      reqConfig.headers.Cookie = cookieHeader;
    }
    return reqConfig;
  });

  client.interceptors.response.use(async (response) => {
    const url = axios.getUri(response.config);
    const setCookie = response.headers['set-cookie'];
    if (setCookie) {
      const list = Array.isArray(setCookie) ? setCookie : [setCookie];
      for (const raw of list) {
        await jar.setCookie(raw, url, { ignoreError: true });
      }
    }
    return response;
  });
}

export async function createRedditClient(endpoint) {
  const jar = await getCookieJar(endpoint);
  const client = axios.create({
    timeout: 30000,
    ...createAgents(endpoint),
  });
  attachCookieJar(client, jar);
  return client;
}

export async function ensureRedditSession(client, endpoint) {
  if (!config.redditCookieBootstrap) return;
  if (await hasRedditSession(endpoint)) return;

  await enforceProxyCooldown(endpoint);
  try {
    await client.get('https://www.reddit.com/', {
      headers: redditBootstrapHeaders(),
      maxRedirects: 5,
      validateStatus: (status) => status < 500,
    });
    schedulePersistCookieJar(endpoint);
  } catch {
    /* bootstrap failed */
  }
}

export async function invalidateRedditSession(endpoint) {
  await clearCookieJar(endpoint);
}

export async function checkEndpointHealth(endpoint) {
  return runOnProxy(endpoint, async () => {
    try {
      const client = await createRedditClient(endpoint);
      await ensureRedditSession(client, endpoint);
      await enforceProxyCooldown(endpoint);
      await client.get('https://www.reddit.com/new.json', {
        params: { limit: 1 },
        headers: redditRequestHeaders('https://www.reddit.com/new.json'),
      });
      schedulePersistCookieJar(endpoint);
      recordProxyRequest(endpoint, { success: true });
      return true;
    } catch {
      recordProxyRequest(endpoint, { success: false });
      return false;
    }
  });
}

/** Sample up to maxChecks endpoints (avoids probing 500+ proxies every minute). */
export async function countHealthyProxies(maxChecks = 20) {
  const dbSample = dbPool.slice(0, maxChecks);
  const envSample = envPool.filter((e) => e.mode === 'proxy').slice(0, 5);
  const sample = [...dbSample, ...envSample];
  if (sample.length === 0) return 0;

  let healthy = 0;
  for (const ep of sample) {
    if (await checkEndpointHealth(ep)) healthy += 1;
  }
  return healthy;
}
