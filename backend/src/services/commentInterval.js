import { config } from '../config.js';
import { intervalFromWeightedRate } from './commentActivity.js';

export function clampInterval(seconds) {
  return Math.max(
    config.intervalMinSeconds,
    Math.min(config.intervalMaxSeconds, Math.floor(seconds)),
  );
}

function intervalFromScrapeRun({ scrapedCount, commentSpanSec, wallDeltaSec }) {
  const target = config.commentTargetBatchSize;
  const span = Math.max(1, Math.floor(commentSpanSec ?? 0));
  const wall = Math.max(1, Math.floor(wallDeltaSec ?? 0));

  if (scrapedCount <= 0) return { seconds: null, mode: 'unchanged', deltaFor100: null, basisSec: null };

  let deltaFor100;
  let mode;
  let basisSec;

  if (scrapedCount >= target) {
    mode = 'full_batch';
    basisSec = span;
    deltaFor100 = span;
  } else {
    basisSec = span > 1 ? span : wall;
    mode = span > 1 ? 'extrapolate_span' : 'extrapolate_wall';
    deltaFor100 = basisSec * (target / scrapedCount);
  }

  return {
    seconds: clampInterval(deltaFor100),
    mode,
    deltaFor100: Math.floor(deltaFor100),
    basisSec: Math.floor(basisSec),
  };
}

/**
 * Interval to target ~100 new comments per scrape.
 * Uses DB weighted rate when available; if last run &lt; target, waits at least scrape extrapolation.
 */
export function computeCommentInterval({
  scrapedCount,
  commentSpanSec,
  wallDeltaSec,
  weightedRatePerMin = null,
}) {
  const target = config.commentTargetBatchSize;
  const span = Math.max(1, Math.floor(commentSpanSec ?? 0));
  const wall = Math.max(1, Math.floor(wallDeltaSec ?? 0));

  const base = {
    scraped_count: scrapedCount,
    target_batch: target,
    comment_span_sec: span,
    wall_delta_sec: wall,
    weighted_rate_per_min: weightedRatePerMin,
    interval_min_sec: config.intervalMinSeconds,
    interval_max_sec: config.intervalMaxSeconds,
  };

  const scrape = intervalFromScrapeRun({ scrapedCount, commentSpanSec, wallDeltaSec });
  const dbSec = intervalFromWeightedRate(weightedRatePerMin);

  if (scrapedCount <= 0 && dbSec == null) {
    return {
      intervalSeconds: null,
      detail: { ...base, mode: 'unchanged', reason: 'no_comments_processed' },
    };
  }

  let intervalSeconds;
  let mode;
  let formula;

  if (scrapedCount >= target) {
    intervalSeconds = dbSec ?? scrape.seconds;
    mode = dbSec != null ? 'db_weighted' : scrape.mode;
    formula =
      dbSec != null
        ? `interval = 100 / (${weightedRatePerMin}/min) ≈ ${intervalSeconds}s`
        : `interval = comment_span(${scrape.deltaFor100})`;
  } else if (scrapedCount > 0) {
    const scrapeSec = scrape.seconds;
    intervalSeconds = Math.max(scrapeSec ?? 0, dbSec ?? 0) || scrapeSec;
    mode =
      dbSec != null && dbSec >= (scrapeSec ?? 0) ? 'max_db_scrape' : scrape.mode;
    formula = `max(scrape=${scrapeSec}s [${scrape.mode}], db=${dbSec ?? 'n/a'}s) → ${intervalSeconds}s`;
  } else {
    intervalSeconds = dbSec;
    mode = 'db_weighted_only';
    formula = `interval = 100 / (${weightedRatePerMin}/min) ≈ ${intervalSeconds}s`;
  }

  const rawIntervalSec = intervalSeconds;
  const clamped = rawIntervalSec !== clampInterval(rawIntervalSec);
  intervalSeconds = clampInterval(rawIntervalSec);

  return {
    intervalSeconds,
    detail: {
      ...base,
      mode,
      scrape_mode: scrape.mode,
      scrape_interval_sec: scrape.seconds,
      db_interval_sec: dbSec,
      delta_for_100_sec: scrape.deltaFor100,
      basis_sec: scrape.basisSec,
      raw_interval_sec: rawIntervalSec,
      interval_after_sec: intervalSeconds,
      clamped,
      formula,
    },
  };
}

/** @deprecated use computeCommentInterval */
export function intervalForCommentBatch(opts) {
  const { intervalSeconds } = computeCommentInterval(opts);
  return intervalSeconds;
}
