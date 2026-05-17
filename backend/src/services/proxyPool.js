import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { config } from '../config.js';

let index = 0;

export function getProxyCount() {
  return config.proxies.length;
}

export function getNextProxy() {
  if (config.proxies.length === 0) return null;
  const proxy = config.proxies[index % config.proxies.length];
  index += 1;
  return { url: proxy, index: (index - 1) % config.proxies.length };
}

export function createRedditClient(proxyUrl) {
  const opts = {
    timeout: 30000,
    headers: { 'User-Agent': config.redditUserAgent },
  };
  if (proxyUrl) {
    const agent = new SocksProxyAgent(proxyUrl);
    opts.httpAgent = agent;
    opts.httpsAgent = agent;
  }
  return axios.create(opts);
}

export async function checkProxyHealth(proxyUrl) {
  try {
    const client = createRedditClient(proxyUrl);
    await client.get('https://www.reddit.com/search.json', {
      params: { q: 'test', limit: 1 },
    });
    return true;
  } catch {
    return false;
  }
}

export async function countHealthyProxies() {
  if (config.proxies.length === 0) return 0;
  const results = await Promise.all(config.proxies.map((p) => checkProxyHealth(p)));
  return results.filter(Boolean).length;
}
