import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';

/** @type {Map<string, { accounts: { label: string, cookies: object[] }[], rotateIndex: number }>} */
const pools = new Map();

function normalizeAccount(entry, index) {
  if (Array.isArray(entry)) {
    return { label: `account_${index + 1}`, cookies: entry };
  }
  if (entry && Array.isArray(entry.cookies)) {
    return {
      label: String(entry.label || entry.name || `account_${index + 1}`),
      cookies: entry.cookies,
    };
  }
  return null;
}

function parseCookieFile(data) {
  if (!Array.isArray(data)) return [];
  if (data.length > 0 && data[0]?.name && data[0]?.value) {
    return [{ label: 'account_1', cookies: data }];
  }
  return data
    .map((entry, i) => normalizeAccount(entry, i))
    .filter((a) => a && a.cookies.length > 0);
}

async function loadPool(channel, filePath) {
  const resolved = path.resolve(filePath);
  try {
    const raw = await fs.readFile(resolved, 'utf8');
    const accounts = parseCookieFile(JSON.parse(raw));
    pools.set(channel, { accounts, rotateIndex: 0 });
    console.log(`[reddit-cookies:${channel}] loaded ${accounts.length} account(s) from ${resolved}`);
    return accounts.length;
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`[reddit-cookies:${channel}] no file at ${resolved}`);
    } else {
      console.warn(`[reddit-cookies:${channel}] load failed:`, err.message);
    }
    pools.set(channel, { accounts: [], rotateIndex: 0 });
    return 0;
  }
}

export async function loadRedditCookiePools() {
  const defaultCount = await loadPool('default', config.redditCookiesFile);

  const webshareFile = config.webshareRedditCookiesFile || config.redditCookiesFile;
  if (config.webshareUseRedditCookies && webshareFile !== config.redditCookiesFile) {
    await loadPool('webshare', webshareFile);
  } else if (config.webshareUseRedditCookies) {
    const def = pools.get('default');
    pools.set('webshare', {
      accounts: def?.accounts ?? [],
      rotateIndex: 0,
    });
    console.warn(
      '[reddit-cookies:webshare] using same accounts as default — set WEBSHARE_REDDIT_COOKIES_FILE or WEBSHARE_USE_REDDIT_COOKIES=false',
    );
  }

  return defaultCount;
}

/** @deprecated use loadRedditCookiePools */
export async function loadRedditCookiePool() {
  return loadRedditCookiePools();
}

function poolForChannel(channel) {
  if (channel === 'webshare' && config.webshareUseRedditCookies) {
    return pools.get('webshare') ?? pools.get('default');
  }
  return pools.get('default');
}

export function cookieChannelForEndpoint(endpoint) {
  return endpoint?.source === 'webshare' ? 'webshare' : 'default';
}

export function getRedditCookieAccountCount(channel = 'default') {
  return poolForChannel(channel)?.accounts.length ?? 0;
}

/** Round-robin next account for one scrape run. */
export function acquireRedditCookieAccount(channel = 'default') {
  if (channel === 'webshare' && !config.webshareUseRedditCookies) {
    return null;
  }

  const pool = poolForChannel(channel);
  if (!pool?.accounts.length) return null;

  const account = pool.accounts[pool.rotateIndex % pool.accounts.length];
  pool.rotateIndex = (pool.rotateIndex + 1) % pool.accounts.length;
  return account;
}

function cookieToSetCookieHeader(c) {
  const domain = c.domain || '.reddit.com';
  const parts = [
    `${c.name}=${c.value}`,
    `Domain=${domain}`,
    `Path=${c.path || '/'}`,
  ];
  if (c.secure) parts.push('Secure');
  if (c.httpOnly) parts.push('HttpOnly');
  if (c.sameSite && c.sameSite !== 'unspecified') {
    const site = String(c.sameSite).replace(/_/g, '-');
    parts.push(`SameSite=${site}`);
  }
  return { domain, header: parts.join('; ') };
}

/** Inject Cookie Editor export into a tough-cookie jar for this scrape session. */
export async function applyRedditCookiesToJar(jar, account) {
  if (!account?.cookies?.length) return;

  for (const c of account.cookies) {
    if (!c?.name || c.value == null) continue;
    const { domain, header } = cookieToSetCookieHeader(c);
    const host = domain.startsWith('.') ? domain.slice(1) : domain;
    const baseUrl = `https://${host}${c.path || '/'}`;
    await jar.setCookie(header, baseUrl, { ignoreError: true });
  }
}
