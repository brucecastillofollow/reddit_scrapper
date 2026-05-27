import { Router } from 'express';
import {
  bulkInsertProxies,
  deleteProxy,
  deleteProxiesBulk,
  getProxySummary,
  isSupportedProtocol,
  listProxies,
  parseProxyLines,
  setProxyEnabled,
  setProxyInterval,
} from '../services/proxyRepository.js';
import { refreshProxyPool } from '../services/proxyPool.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const search = String(req.query.search || '').trim();
    const enabledOnly = req.query.enabled_only === 'true';

    const [list, summary] = await Promise.all([
      listProxies({ page, limit, search, enabledOnly }),
      getProxySummary(),
    ]);

    res.json({ ...list, summary });
  } catch (err) {
    next(err);
  }
});

router.get('/summary', async (_req, res, next) => {
  try {
    res.json(await getProxySummary());
  } catch (err) {
    next(err);
  }
});

router.post('/bulk', async (req, res, next) => {
  try {
    const protocol = String(req.body.protocol || '').toLowerCase();
    const lines = String(req.body.lines || '');

    if (!isSupportedProtocol(protocol)) {
      return res.status(400).json({
        error: 'Invalid protocol. Use socks5, socks4, http, or https.',
      });
    }

    const { parsed, errors } = parseProxyLines(lines);
    if (errors.length > 0 && parsed.length === 0) {
      return res.status(400).json({ error: 'No valid proxy lines', parse_errors: errors });
    }

    const { inserted, skipped } = await bulkInsertProxies(protocol, parsed);
    await refreshProxyPool();

    res.json({
      inserted,
      skipped,
      parse_errors: errors,
      message: `Added ${inserted} proxies (${skipped} duplicates skipped)`,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/reload', async (_req, res, next) => {
  try {
    await refreshProxyPool();
    res.json({ message: 'Proxy pool reloaded from database' });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid proxy id' });
    }

    const { enabled, interval_seconds: intervalSeconds } = req.body;
    if (enabled === undefined && intervalSeconds === undefined) {
      return res.status(400).json({ error: 'enabled and/or interval_seconds required' });
    }

    let updated = false;
    if (typeof enabled === 'boolean') {
      updated = (await setProxyEnabled(id, enabled)) || updated;
    }
    if (intervalSeconds !== undefined) {
      const sec = Number(intervalSeconds);
      if (!Number.isFinite(sec) || sec < 0) {
        return res.status(400).json({ error: 'interval_seconds must be a non-negative number' });
      }
      updated = (await setProxyInterval(id, sec)) || updated;
    }

    if (!updated) return res.status(404).json({ error: 'Proxy not found' });

    await refreshProxyPool();
    res.json({ message: 'Proxy updated' });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid proxy id' });
    }

    const ok = await deleteProxy(id);
    if (!ok) return res.status(404).json({ error: 'Proxy not found' });

    await refreshProxyPool();
    res.json({ message: 'Proxy deleted' });
  } catch (err) {
    next(err);
  }
});

router.post('/delete-bulk', async (req, res, next) => {
  try {
    const ids = (req.body.ids || [])
      .map((x) => parseInt(x, 10))
      .filter((x) => Number.isFinite(x));
    const deleted = await deleteProxiesBulk(ids);
    await refreshProxyPool();
    res.json({ deleted, message: `Deleted ${deleted} proxies` });
  } catch (err) {
    next(err);
  }
});

export default router;
