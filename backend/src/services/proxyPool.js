import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { config } from '../config.js';
import { maskProxyUrl } from './scrapeLogger.js';

const SUPPORTED_PROTOCOLS = new Set(['socks5', 'socks4', 'http', 'https']);

let pool = buildPool();
let index = 0;

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
    headers: { 'User-Agent': config.redditUserAgent },
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
