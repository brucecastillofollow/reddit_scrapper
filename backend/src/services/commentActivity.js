import { pool } from '../db.js';
import { config } from '../config.js';
import { clampInterval } from './commentInterval.js';

/** Weight for a bucket `ageMinutes` ago: recent minutes count more (exponential decay). */
export function weightForAgeMinutes(ageMinutes, halfLifeMinutes) {
  return Math.exp(-ageMinutes / halfLifeMinutes);
}

/**
 * Per-minute comment counts from DB, with decay weights (0 = current minute).
 */
export async function fetchCommentBuckets(subreddit = null, days = config.commentEfficiencyDays) {
  const params = [days];
  let subFilter = '';
  if (subreddit) {
    params.push(subreddit);
    subFilter = ` AND subreddit = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT
       date_trunc('minute', created_utc AT TIME ZONE 'UTC') AS minute,
       COUNT(*)::int AS count
     FROM comments
     WHERE created_utc >= NOW() - ($1::int || ' days')::interval
       ${subFilter}
     GROUP BY 1
     ORDER BY 1`,
    params,
  );

  const now = Date.now();
  return rows.map((r) => {
    const minuteMs = new Date(r.minute).getTime();
    const ageMinutes = Math.max(0, (now - minuteMs) / 60000);
    return {
      minute: new Date(r.minute).toISOString(),
      count: r.count,
      age_minutes: Math.round(ageMinutes * 10) / 10,
    };
  });
}

export function summarizeWeightedActivity(buckets, halfLifeMinutes = config.commentWeightHalfLifeMinutes) {
  let weightedSum = 0;
  let weightTotal = 0;
  let rawTotal = 0;
  let peak = { minute: null, count: 0 };

  for (const b of buckets) {
    const w = weightForAgeMinutes(b.age_minutes, halfLifeMinutes);
    const wc = b.count * w;
    weightedSum += wc;
    weightTotal += w;
    rawTotal += b.count;
    if (b.count > peak.count) peak = { minute: b.minute, count: b.count };
  }

  const weightedRatePerMinute = weightTotal > 0 ? weightedSum / weightTotal : 0;

  return {
    half_life_minutes: halfLifeMinutes,
    bucket_count: buckets.length,
    total_comments: rawTotal,
    weighted_sum: Math.round(weightedSum * 100) / 100,
    weight_total: Math.round(weightTotal * 100) / 100,
    weighted_rate_per_min: Math.round(weightedRatePerMinute * 100) / 100,
    peak_minute: peak.minute,
    peak_count: peak.count,
  };
}

/** Seconds to wait until ~target new comments at weighted DB rate. */
export function intervalFromWeightedRate(weightedPerMinute, target = config.commentTargetBatchSize) {
  if (!weightedPerMinute || weightedPerMinute <= 0) return null;
  const minutesForTarget = target / weightedPerMinute;
  return clampInterval(minutesForTarget * 60);
}

export async function getSubredditWeightedActivity(subreddit, days = config.commentEfficiencyDays) {
  const buckets = await fetchCommentBuckets(subreddit, days);
  const summary = summarizeWeightedActivity(buckets);
  const recommended_interval_sec = intervalFromWeightedRate(summary.weighted_rate_per_min);
  return { buckets, summary, recommended_interval_sec };
}
