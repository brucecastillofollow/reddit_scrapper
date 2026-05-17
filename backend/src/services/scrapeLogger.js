import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';

export function maskProxyUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    if (u.username) u.username = `${u.username.slice(0, 4)}***`;
    return u.toString();
  } catch {
    return String(url).replace(/:([^:@/]+)@/, ':***@');
  }
}

export function describeEndpoint(endpoint) {
  if (!endpoint || endpoint.mode === 'direct') {
    return {
      mode: 'direct',
      id: 'direct',
      protocol: 'direct',
      index: endpoint?.index ?? null,
      env_key: 'direct',
      url_masked: 'local-ip',
    };
  }

  return {
    mode: 'proxy',
    id: endpoint.id,
    protocol: endpoint.protocol,
    index: endpoint.index,
    env_key: endpoint.id,
    url_masked: maskProxyUrl(endpoint.url),
  };
}

/** @deprecated use describeEndpoint */
export function describeProxy(endpoint) {
  return describeEndpoint(endpoint);
}

export function formatProxyForMessage(proxyInfo) {
  if (!proxyInfo || proxyInfo.mode === 'direct') {
    return 'direct (local-ip)';
  }
  const proto = proxyInfo.protocol ? `${proxyInfo.protocol} ` : '';
  if (proxyInfo.env_key && proxyInfo.url_masked) {
    return `${proxyInfo.env_key} ${proto}(${proxyInfo.url_masked})`;
  }
  return proxyInfo.env_key || `endpoint_index=${proxyInfo.index}`;
}

async function appendJsonLog(logPath, tag, entry, { useConsoleError = false } = {}) {
  const record = {
    at: new Date().toISOString(),
    ...entry,
  };
  const line = JSON.stringify(record);
  const logFn = useConsoleError ? console.error : console.log;
  logFn(`[${tag}] ${line}`);

  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, `${line}\n`, 'utf8');
  } catch (err) {
    console.error(`[${tag}] could not write log file:`, err.message);
  }

  return record;
}

export async function logScrapeFailure(entry) {
  return appendJsonLog(config.scrapeFailureLog, 'scrape-fail', entry, { useConsoleError: true });
}

export async function logCommentScrapeTiming(entry) {
  const durationMs = entry.duration_ms ?? 0;
  const summary = {
    subreddit: entry.subreddit,
    duration_ms: durationMs,
    duration_s: Number((durationMs / 1000).toFixed(3)),
    success: entry.success ?? true,
    ...entry,
  };
  console.log(
    `[comment-timing] r/${summary.subreddit} ${summary.duration_s}s` +
      (summary.success
        ? ` new=${summary.comments_new ?? 0} existing=${summary.comments_existing ?? 0} pages=${summary.pages ?? 1}` +
            (summary.stop_reason ? ` stop=${summary.stop_reason}` : '')
        : ` FAILED: ${summary.error}`),
  );
  return appendJsonLog(config.scrapeCommentTimingLog, 'comment-timing', summary);
}

export async function logScrapeFailureFromError(kind, err, extra = {}) {
  const proxy = err.proxy ?? { mode: 'unknown', id: null, protocol: null, index: null, env_key: null };
  return logScrapeFailure({
    kind,
    ...extra,
    proxy,
    error: err.message,
    status: err.response?.status ?? err.status ?? null,
  });
}

export function enrichError(err, endpoint) {
  const wrapped = new Error(err.message);
  wrapped.proxy = describeEndpoint(endpoint);
  wrapped.status = err.response?.status;
  wrapped.cause = err;
  return wrapped;
}

export function errorMessageWithProxy(err) {
  const proxy = err.proxy;
  if (!proxy) return err.message;
  return `[${formatProxyForMessage(proxy)}] ${err.message}`;
}
