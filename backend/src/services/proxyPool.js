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

export function createRedditClient(endpoint) {
  return axios.create({
    timeout: 30000,
    headers: { 
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7' ,
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Sec-Ch-Ua': '"Google Chrome";v="148", "Chromium";v="148", "Not=A?Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Ch-Ua-Platform-Version': '"10"',
      'Sec-Ch-Ua-Full-Version': '"148.0.0.0"',
      'Sec-Ch-Ua-Full-Version-List': '"Google Chrome";v="148.0.0.0", "Chromium";v="148.0.0.0", "Not=A?Brand";v="99.0.0.0"',
      'Sec-Ch-Ua-Model': '"Windows"',
      'Sec-Ch-Ua-Full-Version-List': '"Google Chrome";v="148.0.0.0", "Chromium";v="148.0.0.0", "Not=A?Brand";v="99.0.0.0"',
    },
    ...createAgents(endpoint),
  });
}

export async function checkEndpointHealth(endpoint) {
  try {
    const client = createRedditClient(endpoint);
    await client.get('https://www.reddit.com/new.json', { params: { limit: 1 } });
    return true;
  } catch {
    return false;
  }
}

export async function countHealthyProxies() {
  if (pool.length === 0) return 0;
  const results = await Promise.all(pool.map((ep) => checkEndpointHealth(ep)));
  return results.filter(Boolean).length;
}
