import { config } from '../config.js';

export function clampInterval(seconds) {
  return Math.max(
    config.intervalMinSeconds,
    Math.min(config.intervalMaxSeconds, Math.floor(seconds)),
  );
}

/** Never-scraped: average of current interval and time span of the latest 100 comments. */
export function intervalFromNeverScrapedDelta(currentInterval, deltaSeconds) {
  const delta = Math.max(0, Math.floor(deltaSeconds));
  return clampInterval((currentInterval + delta) / 2);
}

/**
 * Incremental scrape: scale interval by comment volume (100 comments ≈ unchanged, 200 ≈ half).
 */
export function intervalFromCommentVolume(currentInterval, scrapedCount) {
  if (scrapedCount <= 0) return currentInterval;
  return clampInterval((currentInterval * 100) / scrapedCount);
}
