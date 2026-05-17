import { Router } from 'express';
import { pool } from '../db.js';
import { config } from '../config.js';
import { getStatusRow } from '../db.js';
import { runScrapeCycle, isScrapeRunning } from '../services/scraper.js';
import { getProxyCount } from '../services/proxyPool.js';

const router = Router();

router.get('/status', async (_req, res, next) => {
  try {
    const status = await getStatusRow();
    const { rows: recentRuns } = await pool.query(
      `SELECT id, started_at, finished_at, status, query, proxy_used,
              posts_fetched, posts_inserted, error_message
       FROM scrape_runs ORDER BY started_at DESC LIMIT 10`,
    );
    res.json({
      is_running: status?.is_running ?? false,
      last_started_at: status?.last_started_at ?? null,
      last_finished_at: status?.last_finished_at ?? null,
      last_error: status?.last_error ?? null,
      total_posts_in_db: Number(status?.total_posts_in_db ?? 0),
      active_proxy_index: status?.active_proxy_index ?? 0,
      proxies_configured: getProxyCount(),
      proxies_healthy: status?.proxies_healthy ?? 0,
      retention_days: config.retentionDays,
      scrape_interval_minutes: config.scrapeIntervalMinutes,
      search_queries: config.searchQueries,
      recent_runs: recentRuns,
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

    const params = [cutoff];
    let where = 'created_utc >= $1';

    if (keyword) {
      params.push(`%${keyword}%`);
      where += ` AND (
        title ILIKE $${params.length}
        OR subreddit ILIKE $${params.length}
        OR search_query ILIKE $${params.length}
        OR author ILIKE $${params.length}
      )`;
    }

    const countSql = `SELECT COUNT(*)::int AS total FROM reddit_posts WHERE ${where}`;
    const listSql = `
      SELECT id, reddit_id, title, subreddit, author, permalink, url,
             score, num_comments, created_utc, search_query, scraped_at
      FROM reddit_posts WHERE ${where}
      ORDER BY created_utc DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

    params.push(limit, offset);

    const [{ rows: countRows }, { rows: items }] = await Promise.all([
      pool.query(countSql, params.slice(0, keyword ? 2 : 1)),
      pool.query(listSql, params),
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
    if (isScrapeRunning()) {
      return res.status(409).json({ error: 'Scrape already in progress' });
    }
    runScrapeCycle().catch(() => {});
    res.json({ message: 'Scrape started' });
  } catch (err) {
    next(err);
  }
});

router.get('/archives', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, archive_date, file_path, post_count, created_at FROM archive_records ORDER BY archive_date DESC',
    );
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

export default router;
