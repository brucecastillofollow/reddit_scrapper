import './loadEnv.js';
import express from 'express';
import cors from 'cors';

import { config } from './config.js';
import { initDb } from './db.js';
import apiRouter from './routes/api.js';
import proxiesRouter from './routes/proxies.js';
import { startScrapeWorkers } from './workers/scrapeWorkers.js';
import { getPoolSummary, refreshProxyPool } from './services/proxyPool.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: config.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: config.bodyLimit }));
app.use('/api', apiRouter);
app.use('/api/proxies', proxiesRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: `Request body too large (max ${config.bodyLimit}). Split proxy list or set BODY_LIMIT in .env.`,
    });
  }
  res.status(500).json({ error: err.message || 'Internal server error' });
});

async function main() {
  await initDb();
  await refreshProxyPool();
  startScrapeWorkers();

  app.listen(config.port, () => {
    console.log(`API http://localhost:${config.port}`);
    console.log('Workers: post scraper (new.json) + comment scrapers (r/*/comments.json)');
    console.log('Proxy pool:', getPoolSummary().map((p) => `${p.id} (${p.protocol})`).join(' → '));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
