import cron from 'node-cron';
import { config } from './config.js';
import { runScrapeCycle } from './services/scraper.js';
import { archiveOldPosts } from './services/archiver.js';
import { refreshPostCount } from './db.js';

export function startScheduler() {
  const scrapeCron = `*/${config.scrapeIntervalMinutes} * * * *`;
  const safeCron = config.scrapeIntervalMinutes >= 1 && config.scrapeIntervalMinutes <= 59
    ? scrapeCron
    : '*/15 * * * *';

  cron.schedule(safeCron, () => {
    runScrapeCycle().catch((err) => console.error('[scrape]', err.message));
  });

  cron.schedule('0 2 * * *', () => {
    archiveOldPosts()
      .then((r) => {
        if (r.length) console.log('[archive]', r);
        return refreshPostCount();
      })
      .catch((err) => console.error('[archive]', err.message));
  });

  console.log(`Scheduler: scrape every ${config.scrapeIntervalMinutes}m, archive daily at 02:00`);
}
