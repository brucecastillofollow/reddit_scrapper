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
  recordProxyUsed,
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
  acquireRedditCookieAccount,
  applyRedditCookiesToJar,
  getRedditCookieAccountCount,
} from './redditCookiePool.js';
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
      last_used_at: row.last_used_at,
      interval_seconds: Number(row.interval_seconds ?? config.proxyDefaultIntervalSeconds),
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

/** Reddit rejection (403/404/401) — not counted as proxy failures. */
export function isRedditHttpError(err) {
  const status = err?.response?.status ?? err?.status ?? null;
  return status === 403 || status === 404 || status === 401;
}

export function isRedditRateLimitError(err) {
  const status = err?.response?.status ?? err?.status ?? null;
  return status === 429;
}

/** Proxy/connectivity failure or rate limit (counts toward proxy failed_request_count). */
export function isProxyInfrastructureError(err) {
  if (!err) return false;
  if (isRedditRateLimitError(err)) return true;
  if (isRedditHttpError(err)) return false;

  const status = err.response?.status ?? err.status ?? null;
  const code = err.code ?? '';
  const msg = String(err.message || '').toLowerCase();

  if (status === 407) return true;

  if (
    msg.includes('socks') ||
    msg.includes('proxy rejected') ||
    msg.includes('notallowed') ||
    (msg.includes('proxy') && (msg.includes('rejected') || msg.includes('tunnel')))
  ) {
    return true;
  }

  if (
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EPROTO'].includes(code)
  ) {
    return true;
  }

  if (!status && !err.response) {
    if (msg.includes('proxy') || msg.includes('tunnel') || msg.includes('socks')) return true;
    if (code) return true;
  }

  return false;
}

export function isProxyRequestError(err) {
  return isProxyInfrastructureError(err) || isRedditHttpError(err) || isRedditRateLimitError(err);
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

export async function runScrapeOnEndpoint(endpoint, fn, { clearJarFirst = false } = {}) {
  return runOnProxy(endpoint, async () => {
    if (clearJarFirst) await clearCookieJar(endpoint);

    const jar = await getCookieJar(endpoint);
    const redditAccount = acquireRedditCookieAccount();
    if (redditAccount) {
      await applyRedditCookiesToJar(jar, redditAccount);
    }

    const client = await createRedditClient(endpoint);
    await ensureRedditSession(client, endpoint);
    try {
      return await fn(client);
    } finally {
      await persistCookieJar(endpoint);
    }
  });
}

/** On Reddit 403/404/etc., clear session and retry once with the next cookie account. */
export async function runScrapeOnEndpointWithCookieRetry(endpoint, fn) {
  try {
    return await runScrapeOnEndpoint(endpoint, fn);
  } catch (err) {
    if (
      (!isRedditHttpError(err) && !isRedditRateLimitError(err)) ||
      getRedditCookieAccountCount() === 0
    ) {
      throw err;
    }

    const status = err.response?.status ?? err.status ?? '?';
    console.warn(
      `[scrape] ${endpoint.id} reddit ${status === 429 ? 'rate limit' : 'rejection'} (${status}) — retry once with next cookie`,
    );
    return runScrapeOnEndpoint(endpoint, fn, { clearJarFirst: true });
  }
}

function emptyCounts() {
  return { total: 0, success: 0, failed: 0 };
}

export function recordProxyRequest(endpoint, { success, err = null }) {
  const id = endpoint?.id ?? 'unknown';
  const proxyFault = !success && isProxyInfrastructureError(err);
  const counts = requestCounts.get(id) ?? emptyCounts();
  counts.total += 1;
  if (success) counts.success += 1;
  else if (proxyFault) counts.failed += 1;
  requestCounts.set(id, counts);

  if (endpoint?.source === 'db' && endpoint.proxyDbId) {
    if (endpoint.dbStats) {
      if (success) {
        endpoint.dbStats.total_success_request_count += 1;
        endpoint.dbStats.last_success_at = new Date();
      } else if (proxyFault) {
        endpoint.dbStats.total_failed_request_count += 1;
      }
    }
    recordProxyRequestResult(endpoint.proxyDbId, { success, proxyFault }).catch(() => {});
  }
}

function failureCount(endpoint) {
  return endpoint?.dbStats?.total_failed_request_count ?? 0;
}

function proxyIntervalSeconds(endpoint) {
  const n = endpoint?.dbStats?.interval_seconds;
  return Number.isFinite(n) && n >= 0 ? n : config.proxyDefaultIntervalSeconds;
}

/** When this proxy becomes eligible again (ms since epoch). Never used → 0. */
function proxyNextDueMs(endpoint) {
  const used = endpoint?.dbStats?.last_used_at;
  if (!used) return 0;
  return new Date(used).getTime() + proxyIntervalSeconds(endpoint) * 1000;
}

function isProxyIntervalDue(endpoint) {
  if (!endpoint?.dbStats?.last_used_at) return true;
  return Date.now() >= proxyNextDueMs(endpoint);
}

/** Enabled DB proxy that is past interval and not quarantined. */
function getEligibleDbEndpoints() {
  if (!dbPool.length) return [];
  return dbPool.filter((ep) => isProxyIntervalDue(ep) && !isProxyQuarantined(ep));
}

/** Older last_used_at first; null = never used (preferred). */
function lastUsedTime(endpoint) {
  const at = endpoint?.dbStats?.last_used_at;
  if (!at) return 0;
  return new Date(at).getTime();
}

function compareDbEndpoints(a, b) {
  const failDiff = failureCount(a) - failureCount(b);
  if (failDiff !== 0) return failDiff;

  const timeDiff = lastUsedTime(a) - lastUsedTime(b);
  if (timeDiff !== 0) return timeDiff;

  return (a.proxyDbId ?? 0) - (b.proxyDbId ?? 0);
}

/** Lowest failed count → oldest last_used_at (eligible DB proxies only). */
function sortedDbEndpoints() {
  return getEligibleDbEndpoints().sort(compareDbEndpoints);
}

export function getEligibleDbProxyCount() {
  return getEligibleDbEndpoints().length;
}

function pickFromSortedDbList(list) {
  if (!list.length) return null;
  const healthy = list.filter((ep) => !isProxyQuarantined(ep));
  const sorted = (healthy.length > 0 ? healthy : list).sort(compareDbEndpoints);
  const minFail = failureCount(sorted[0]);
  const tier = sorted.filter((ep) => failureCount(ep) === minFail);
  const minUsed = Math.min(...tier.map(lastUsedTime));
  const pickPool = tier.filter((ep) => lastUsedTime(ep) === minUsed);

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
      last_used_at: db?.last_used_at ?? null,
      interval_seconds: db?.interval_seconds ?? null,
      next_due_at:
        ep.source === 'db' && db?.last_used_at
          ? new Date(proxyNextDueMs(ep)).toISOString()
          : null,
      interval_due: ep.source === 'db' ? isProxyIntervalDue(ep) : true,
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
    return sorted;
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

/** DB proxy for comment scrapes. Updates last_used_at. */
export async function getNextDbEndpoint() {
  const endpoint = getNextEndpoint({ source: 'db' });
  if (endpoint?.proxyDbId) {
    const now = new Date();
    endpoint.dbStats.last_used_at = now;
    await recordProxyUsed(endpoint.proxyDbId);
  }
  return endpoint;
}

/** Env proxy for post scrapes (round-robin). Does not touch proxies table. */
export function getNextEnvEndpoint() {
  return getNextEndpoint({ source: 'env' });
}

export async function acquireScrapeEndpoint() {
  return (await getNextDbEndpoint()) ?? getNextEndpoint({ source: 'env' });
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
    } catch (err) {
      recordProxyRequest(endpoint, { success: false, err });
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
