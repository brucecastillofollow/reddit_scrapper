import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { config } from './config.js';
import { initDb, refreshPostCount } from './db.js';
import apiRouter from './routes/api.js';
import { startScheduler } from './scheduler.js';
import { runScrapeCycle } from './services/scraper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

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
  await refreshPostCount();
  startScheduler();

  app.listen(config.port, () => {
    console.log(`API http://localhost:${config.port}`);
    runScrapeCycle().catch((err) => console.error('[initial scrape]', err.message));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
