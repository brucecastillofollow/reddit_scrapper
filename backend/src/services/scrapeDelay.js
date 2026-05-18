import { config } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pause before each post/comment scrape run (rate limiting). */
export async function sleepBeforeScrape() {
  const seconds = config.scrapeSleepSeconds;
  if (seconds > 0) {
    await sleep(seconds * 1000);
  }
}
