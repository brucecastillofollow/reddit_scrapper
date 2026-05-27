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

async function appendJsonLog(logPath, tag, entry, { useConsoleError = false, consoleLine = null } = {}) {
  const record = {
    at: new Date().toISOString(),
    ...entry,
  };
  const line = JSON.stringify(record);
  const logFn = useConsoleError ? console.error : console.log;
  logFn(consoleLine ?? `[${tag}] ${line}`);

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

export async function logPostScrape(entry) {
  const durationMs = entry.duration_ms ?? 0;
  const durationS = Number((durationMs / 1000).toFixed(3));
  const record = {
    duration_ms: durationMs,
    duration_s: durationS,
    success: entry.success ?? true,
    ...entry,
  };

  let line;
  if (record.success) {
    line =
      `[post-scrape] ${durationS}s` +
      ` new=${record.posts_new ?? 0} existing=${record.posts_existing ?? 0}` +
      ` pages=${record.pages ?? 0}` +
      (record.outcome ? ` outcome=${record.outcome}` : '') +
      (record.reddit_children_total != null ? ` reddit_items=${record.reddit_children_total}` : '') +
      (record.stop_reason ? ` stop=${record.stop_reason}` : '') +
      (record.downtime_sec != null ? ` downtime=${record.downtime_sec}s` : '') +
      (record.backlog_span_sec != null ? ` backlog=${record.backlog_span_sec}s` : '') +
      (record.pagination_exhausted ? ' pagination_end' : '') +
      (record.hit_max_pages ? ' max_pages' : '');
  } else {
    line = `[post-scrape] ${durationS}s FAILED: ${record.error}`;
  }

  return appendJsonLog(config.scrapePostLog, 'post-scrape', record, { consoleLine: line });
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
