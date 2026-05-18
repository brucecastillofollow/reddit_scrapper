import { pool } from '../db.js';
import { config } from '../config.js';
import {
  summarizeWeightedActivity,
  intervalFromWeightedRate,
  weightForAgeMinutes,
} from './commentActivity.js';

function efficiencyScore(lastScrapeNew, currentIntervalSec, recommendedIntervalSec) {
  const target = config.commentTargetBatchSize;
  const batchScore = lastScrapeNew > 0 ? Math.min(100, Math.round((lastScrapeNew / target) * 100)) : 0;

  let intervalMatch = null;
  if (recommendedIntervalSec > 0 && currentIntervalSec > 0) {
    const ratio = currentIntervalSec / recommendedIntervalSec;
    intervalMatch = Math.round(Math.max(0, 100 - Math.abs(1 - ratio) * 100));
  }

  const overall =
    intervalMatch != null ? Math.round(batchScore * 0.6 + intervalMatch * 0.4) : batchScore;

  return { batch_score: batchScore, interval_match: intervalMatch, overall };
}

async function fetchAllSubredditBuckets(days) {
  const { rows } = await pool.query(
    `SELECT
       subreddit,
       date_trunc('minute', created_utc AT TIME ZONE 'UTC') AS minute,
       COUNT(*)::int AS count
     FROM comments
     WHERE created_utc >= NOW() - ($1::int || ' days')::interval
     GROUP BY 1, 2`,
    [days],
  );

  const now = Date.now();
  const bySub = new Map();
  const globalByMinute = new Map();

  for (const r of rows) {
    const minuteIso = new Date(r.minute).toISOString();
    globalByMinute.set(minuteIso, (globalByMinute.get(minuteIso) ?? 0) + r.count);

    if (!bySub.has(r.subreddit)) bySub.set(r.subreddit, []);
    bySub.get(r.subreddit).push({
      minute: minuteIso,
      count: r.count,
      age_minutes: Math.round((Math.max(0, (now - new Date(r.minute).getTime()) / 60000)) * 10) / 10,
    });
  }

  const globalBuckets = [...globalByMinute.entries()]
    .map(([minute, count]) => ({
      minute,
      count,
      age_minutes: Math.round((Math.max(0, (now - new Date(minute).getTime()) / 60000)) * 10) / 10,
    }))
    .sort((a, b) => a.minute.localeCompare(b.minute));

  return { globalBuckets, bySub };
}

function enrichSeries(buckets, halfLife) {
  return buckets.slice(-1440).map((b) => {
    const w = weightForAgeMinutes(b.age_minutes, halfLife);
    return {
      ...b,
      weight: Math.round(w * 1000) / 1000,
      weighted_count: Math.round(b.count * w),
    };
  });
}

export async function buildEfficiencyReport({ days = config.commentEfficiencyDays, subredditLimit = 30 } = {}) {
  const halfLife = config.commentWeightHalfLifeMinutes;
  const { globalBuckets, bySub } = await fetchAllSubredditBuckets(days);

  const globalSummary = summarizeWeightedActivity(globalBuckets, halfLife);
  const globalRecommended = intervalFromWeightedRate(globalSummary.weighted_rate_per_min);

  const { rows: subRows } = await pool.query(
    `SELECT name, interval_seconds, last_scrape_new, total_comment, last_poll_at
     FROM subreddit
     WHERE total_comment > 0 OR last_poll_at IS NOT NULL
     ORDER BY total_comment DESC
     LIMIT $1`,
    [subredditLimit],
  );

  const subreddits = [];

  for (const row of subRows) {
    const buckets = bySub.get(row.name) ?? [];
    const summary = summarizeWeightedActivity(buckets, halfLife);
    const recommended_interval_sec = intervalFromWeightedRate(summary.weighted_rate_per_min);
    const scores = efficiencyScore(
      row.last_scrape_new,
      row.interval_seconds,
      recommended_interval_sec,
    );

    subreddits.push({
      name: row.name,
      interval_seconds: row.interval_seconds,
      last_scrape_new: row.last_scrape_new,
      total_comment: row.total_comment,
      last_poll_at: row.last_poll_at,
      ...summary,
      recommended_interval_sec,
      ...scores,
    });
  }

  subreddits.sort((a, b) => b.weighted_rate_per_min - a.weighted_rate_per_min);

  return {
    days,
    half_life_minutes: halfLife,
    target_batch: config.commentTargetBatchSize,
    global: {
      ...globalSummary,
      recommended_interval_sec: globalRecommended,
      series: enrichSeries(globalBuckets, halfLife),
    },
    subreddits,
  };
}
