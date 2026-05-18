import { Router } from 'express';
import { pool, getGlobal, getScrapeStatus } from '../db.js';
import { config } from '../config.js';
import { getProxyCount, getPoolStats } from '../services/proxyPool.js';
import { isPostScrapeRunning, getCommentQueueStatus, triggerPostScrape } from '../workers/scrapeWorkers.js';

const router = Router();

router.get('/status', async (_req, res, next) => {
  try {
    const [status, global, postsCount, commentsCount, subredditCount] = await Promise.all([
      getScrapeStatus(),
      getGlobal(),
      pool.query('SELECT COUNT(*)::bigint AS c FROM posts'),
      pool.query('SELECT COUNT(*)::bigint AS c FROM comments'),
      pool.query('SELECT COUNT(*)::int AS c FROM subreddit'),
    ]);

    const [{ rows: subStatsRows }, { rows: recentSubs }, { rows: waitingSubs }] =
      await Promise.all([
        pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE last_poll_at IS NOT NULL)::int AS scraped_once,
          COUNT(*) FILTER (
            WHERE last_poll_at IS NULL
               OR last_poll_at + (interval_seconds || ' seconds')::interval <= NOW()
          )::int AS waiting,
          COUNT(*) FILTER (
            WHERE last_poll_at IS NOT NULL
              AND last_poll_at + (interval_seconds || ' seconds')::interval > NOW()
          )::int AS scheduled
        FROM subreddit
      `),
        pool.query(
          `SELECT name, last_timestamp, interval_seconds, last_poll_at, total_posts, new_posts
           FROM subreddit ORDER BY last_poll_at DESC NULLS LAST LIMIT 10`,
        ),
        pool.query(
          `SELECT name, last_timestamp, interval_seconds, last_poll_at, total_posts, new_posts,
                  CASE
                    WHEN last_poll_at IS NULL THEN NULL
                    ELSE last_poll_at + (interval_seconds || ' seconds')::interval
                  END AS next_due_at
           FROM subreddit
           WHERE last_poll_at IS NULL
              OR last_poll_at + (interval_seconds || ' seconds')::interval <= NOW()
           ORDER BY last_poll_at NULLS FIRST,
                    (last_poll_at + (interval_seconds || ' seconds')::interval) ASC
           LIMIT 15`,
        ),
      ]);

    const subStats = subStatsRows[0];

    res.json({
      posts_running: status?.posts_running ?? false,
      comments_running: status?.comments_running ?? false,
      last_post_finished_at: status?.last_post_finished_at ?? null,
      last_comment_finished_at: status?.last_comment_finished_at ?? null,
      last_post_error: status?.last_post_error ?? null,
      last_comment_error: status?.last_comment_error ?? null,
      last_post_run: {
        new: status?.last_post_new ?? 0,
        existing: status?.last_post_existing ?? 0,
        total: status?.last_post_total ?? 0,
        finished_at: status?.last_post_finished_at ?? null,
      },
      last_comment_run: {
        subreddit: status?.last_comment_subreddit ?? null,
        new: status?.last_comment_new ?? 0,
        existing: status?.last_comment_existing ?? 0,
        total: status?.last_comment_total ?? 0,
        finished_at: status?.last_comment_finished_at ?? null,
      },
      session_added: {
        posts: Number(status?.session_posts_new ?? 0),
        comments: Number(status?.session_comments_new ?? 0),
      },
      total_posts_in_db: Number(postsCount.rows[0].c),
      total_comments_in_db: Number(commentsCount.rows[0].c),
      subreddit_count: subredditCount.rows[0].c,
      subreddit_comments: {
        total: subStats.total,
        scraped_once: subStats.scraped_once,
        waiting: subStats.waiting,
        scheduled: subStats.scheduled,
        never_scraped: subStats.total - subStats.scraped_once,
      },
      waiting_subreddits: waitingSubs,
      comment_queue: getCommentQueueStatus(),
      global: {
        last_timestamp: global?.last_timestamp ?? null,
        interval_seconds: global?.interval_seconds ?? null,
        last_poll_at: global?.last_poll_at ?? null,
      },
      active_proxy_index: status?.active_proxy_index ?? 0,
      proxies_configured: getProxyCount(),
      proxy_stats: getPoolStats(),
      use_direct: config.useDirect,
      proxy_cooldown_seconds: config.proxyCooldownSeconds,
      proxies_healthy: status?.proxies_healthy ?? 0,
      retention_days: config.retentionDays,
      recent_subreddits: recentSubs,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/posts', async (req, res, next) => {
  try {
    const keyword = String(req.query.keyword || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - config.retentionDays);

    const filterParams = [cutoff];
    let where = 'created_utc >= $1';

    if (keyword) {
      filterParams.push(`%${keyword}%`);
      const p = filterParams.length;
      where += ` AND (
        title ILIKE $${p}
        OR subreddit ILIKE $${p}
        OR author ILIKE $${p}
        OR selftext ILIKE $${p}
      )`;
    }

    const countParams = [...filterParams];
    const listParams = [...filterParams, limit, offset];

    const countSql = `SELECT COUNT(*)::int AS total FROM posts WHERE ${where}`;
    const listSql = `
      SELECT data_id, fullname, title, subreddit, author, permalink, url,
             score, num_comments, created_utc, updated_at
      FROM posts WHERE ${where}
      ORDER BY created_utc DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`;

    const [{ rows: countRows }, { rows: items }] = await Promise.all([
      pool.query(countSql, countParams),
      pool.query(listSql, listParams),
    ]);

    res.json({
      items,
      total: countRows[0].total,
      page,
      page_size: limit,
      keyword: keyword || null,
      retention_days: config.retentionDays,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/scrape/run', async (_req, res, next) => {
  try {
    if (isPostScrapeRunning()) {
      return res.status(409).json({ error: 'Post scrape already in progress' });
    }
    triggerPostScrape().catch(() => {});
    res.json({ message: 'Post scrape triggered' });
  } catch (err) {
    next(err);
  }
});

router.get('/subreddits', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT name, last_timestamp, interval_seconds, last_poll_at, total_posts, new_posts,
              CASE
                WHEN last_poll_at IS NULL THEN 'waiting'
                WHEN last_poll_at + (interval_seconds || ' seconds')::interval <= NOW() THEN 'waiting'
                ELSE 'scheduled'
              END AS scrape_status,
              CASE
                WHEN last_poll_at IS NULL THEN NULL
                ELSE last_poll_at + (interval_seconds || ' seconds')::interval
              END AS next_due_at
       FROM subreddit ORDER BY name`,
    );
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

export default router;
