import { config } from '../config.js';

const SUPPORTED_PROTOCOLS = new Set(['socks5', 'socks4', 'http', 'https']);

function parseProtocol(url) {
  try {
    const protocol = new URL(url).protocol.replace(':', '').toLowerCase();
    if (SUPPORTED_PROTOCOLS.has(protocol)) return protocol;
    throw new Error(`unsupported protocol: ${protocol}`);
  } catch (err) {
    if (err.message?.startsWith('unsupported')) throw err;
    throw new Error(`invalid webshare proxy URL: ${url}`);
  }
}

/** One logical slot per concurrent scrape (rotating gateway — new IP per request). */
export function getWebshareEndpoint(slot) {
  const url = config.webshareProxyUrl?.trim();
  if (!url) return null;

  const n = Number(slot);
  const index = Number.isFinite(n) ? n : 0;

  return {
    id: `webshare_${index}`,
    source: 'webshare',
    proxyDbId: null,
    mode: 'proxy',
    protocol: parseProtocol(url),
    url,
    index,
  };
}

export function isWebshareConfigured() {
  return Boolean(config.webshareProxyUrl?.trim());
}

export function warnWebshareProxyProtocol() {
  const url = config.webshareProxyUrl?.trim();
  if (!url) return;
  if (!url.startsWith('socks5://')) {
    console.warn(
      `[webshare-proxy] WEBSHARE_PROXY_URL should use socks5:// (got ${url.split(':')[0]}:) — wrong protocol can cause failures`,
    );
  }
}
