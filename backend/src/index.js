import './loadEnv.js';
import express from 'express';
import cors from 'cors';

import { config } from './config.js';
import { initDb } from './db.js';
import apiRouter from './routes/api.js';
import { startScrapeWorkers } from './workers/scrapeWorkers.js';

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', apiRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

async function main() {
  await initDb();
  startScrapeWorkers();

  app.listen(config.port, () => {
    console.log(`API http://localhost:${config.port}`);
    console.log('Workers: post scraper (new.json) + comment scrapers (r/*/comments.json)');
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
