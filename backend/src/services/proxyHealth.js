import { config } from '../config.js';

const QUARANTINE_STATUSES = new Set([403, 407, 502, 503]);

/** @type {Map<string, { consecutiveFailures: number, quarantinedUntil: number, lastSuccessAt: number }>} */
const state = new Map();

function proxyId(endpoint) {
  return endpoint?.id ?? 'unknown';
}

function getState(id) {
  if (!state.has(id)) {
    state.set(id, { consecutiveFailures: 0, quarantinedUntil: 0, lastSuccessAt: 0 });
  }
  return state.get(id);
}

export function clearAllProxyHealth() {
  state.clear();
}

export function recordProxySuccess(endpoint) {
  const s = getState(proxyId(endpoint));
  s.consecutiveFailures = 0;
  s.lastSuccessAt = Date.now();
}

/**
 * Call on HTTP errors. Returns whether cookies should be cleared (403 only).
 */
export function recordProxyHttpError(endpoint, status) {
  const id = proxyId(endpoint);
  const s = getState(id);
  const code = status == null ? null : Number(status);

  if (code != null && QUARANTINE_STATUSES.has(code)) {
    s.consecutiveFailures += 1;
    if (s.consecutiveFailures >= config.proxySkipAfterConsecutive403) {
      s.quarantinedUntil = Date.now() + config.proxyQuarantineMinutes * 60 * 1000;
    }
    return code === 403 && shouldInvalidateCookiesOn403(endpoint);
  }

  return false;
}

export function shouldInvalidateCookiesOn403(endpoint) {
  const s = getState(proxyId(endpoint));
  const keepMs = config.proxyCookieKeepAfterSuccessMinutes * 60 * 1000;
  if (s.lastSuccessAt > 0 && Date.now() - s.lastSuccessAt < keepMs) {
    return false;
  }
  return s.consecutiveFailures >= config.proxyCookieInvalidateAfter403;
}

export function isProxyQuarantined(endpoint) {
  const s = getState(proxyId(endpoint));
  const now = Date.now();
  if (s.quarantinedUntil > now) return true;
  if (s.quarantinedUntil > 0) {
    s.quarantinedUntil = 0;
    s.consecutiveFailures = 0;
  }
  return false;
}

export function getProxyQuarantineRemainingMs(endpoint) {
  const s = getState(proxyId(endpoint));
  return Math.max(0, s.quarantinedUntil - Date.now());
}

export function getProxyHealthSnapshot() {
  const now = Date.now();
  return [...state.entries()].map(([id, s]) => ({
    id,
    consecutive_failures: s.consecutiveFailures,
    consecutive_403: s.consecutiveFailures,
    quarantined: s.quarantinedUntil > now,
    quarantine_remaining_sec:
      s.quarantinedUntil > now ? Math.ceil((s.quarantinedUntil - now) / 1000) : 0,
    last_success_ago_sec:
      s.lastSuccessAt > 0 ? Math.floor((now - s.lastSuccessAt) / 1000) : null,
  }));
}
