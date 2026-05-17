import { config } from '../config.js';

/** Normalize to Date for UTC comparisons (Reddit epochs and DB timestamptz). */
export function toUtcDate(value) {
  if (value == null) return null;
  if (value instanceof Date) return value;
  return new Date(value);
}

export function utcNow() {
  return new Date();
}

/** UTC calendar lookback for comment scraping (default 30 days). */
export function utcCommentCutoff() {
  const days = config.commentLookbackDays;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export function isAtOrBeforeUtc(a, b) {
  if (!a || !b) return false;
  return toUtcDate(a).getTime() <= toUtcDate(b).getTime();
}
