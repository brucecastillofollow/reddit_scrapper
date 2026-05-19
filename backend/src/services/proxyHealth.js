import { config } from '../config.js';

/** @type {Map<string, { consecutive403: number, quarantinedUntil: number, lastSuccessAt: number }>} */
const state = new Map();

function proxyId(endpoint) {
  return endpoint?.id ?? 'unknown';
}

function getState(id) {
  if (!state.has(id)) {
    state.set(id, { consecutive403: 0, quarantinedUntil: 0, lastSuccessAt: 0 });
  }
  return state.get(id);
}

export function clearAllProxyHealth() {
  state.clear();
}

/** Call after any successful Reddit HTTP response on this proxy. */
export function recordProxySuccess(endpoint) {
  const s = getState(proxyId(endpoint));
  s.consecutive403 = 0;
  s.lastSuccessAt = Date.now();
}

/**
 * Call on HTTP errors. Returns whether cookies should be cleared.
 * Skips cookie wipe if this proxy had a recent success (e.g. new.json worked).
 */
export function recordProxyHttpError(endpoint, status) {
  const id = proxyId(endpoint);
  const s = getState(id);

  if (status === 403) {
    s.consecutive403 += 1;
    if (s.consecutive403 >= config.proxySkipAfterConsecutive403) {
      s.quarantinedUntil = Date.now() + config.proxyQuarantineMinutes * 60 * 1000;
    }
    return shouldInvalidateCookiesOn403(endpoint);
  }

  return false;
}

export function shouldInvalidateCookiesOn403(endpoint) {
  const s = getState(proxyId(endpoint));
  const keepMs = config.proxyCookieKeepAfterSuccessMinutes * 60 * 1000;
  if (s.lastSuccessAt > 0 && Date.now() - s.lastSuccessAt < keepMs) {
    return false;
  }
  return s.consecutive403 >= config.proxyCookieInvalidateAfter403;
}

/** True while proxy is temporarily excluded from comment work (and round-robin). */
export function isProxyQuarantined(endpoint) {
  const s = getState(proxyId(endpoint));
  const now = Date.now();
  if (s.quarantinedUntil > now) return true;
  if (s.quarantinedUntil > 0) {
    s.quarantinedUntil = 0;
    s.consecutive403 = 0;
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
    consecutive_403: s.consecutive403,
    quarantined: s.quarantinedUntil > now,
    quarantine_remaining_sec:
      s.quarantinedUntil > now ? Math.ceil((s.quarantinedUntil - now) / 1000) : 0,
    last_success_ago_sec:
      s.lastSuccessAt > 0 ? Math.floor((now - s.lastSuccessAt) / 1000) : null,
  }));
}
