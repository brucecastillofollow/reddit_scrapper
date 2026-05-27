import { config } from '../config.js';

/** Normalize to Date for UTC comparisons (Reddit epochs and DB timestamptz). */
export function toUtcDate(value) {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') {
    // Reddit API uses Unix seconds; JS Date expects ms
    return new Date(value < 1e12 ? value * 1000 : value);
  }
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

export function isStrictlyBeforeUtc(a, b) {
  if (!a || !b) return false;
  return toUtcDate(a).getTime() < toUtcDate(b).getTime();
}
