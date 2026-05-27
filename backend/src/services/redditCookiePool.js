import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';

/** @type {{ label: string, cookies: object[] }[]} */
let accounts = [];
let rotateIndex = 0;

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

export async function loadRedditCookiePool() {
  const filePath = path.resolve(config.redditCookiesFile);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      console.warn('[reddit-cookies] expected JSON array — pool empty');
      accounts = [];
      return 0;
    }

    if (data.length > 0 && data[0]?.name && data[0]?.value) {
      accounts = [{ label: 'account_1', cookies: data }];
    } else {
      accounts = data
        .map((entry, i) => normalizeAccount(entry, i))
        .filter((a) => a && a.cookies.length > 0);
    }

    console.log(`[reddit-cookies] loaded ${accounts.length} account(s) from ${filePath}`);
    return accounts.length;
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`[reddit-cookies] no file at ${filePath} — using proxy/bootstrap cookies only`);
    } else {
      console.warn('[reddit-cookies] load failed:', err.message);
    }
    accounts = [];
    return 0;
  }
}

export function getRedditCookieAccountCount() {
  return accounts.length;
}

/** Round-robin next account for one scrape run (post or comment). */
export function acquireRedditCookieAccount() {
  if (!accounts.length) return null;
  const account = accounts[rotateIndex % accounts.length];
  rotateIndex = (rotateIndex + 1) % accounts.length;
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
