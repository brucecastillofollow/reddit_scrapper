# Cursor command — paste into chat

Copy and send this to Cursor to work on this project with full context:

---

**Project: Reddit scraping service (Node.js monorepo)**

Build and maintain a Reddit scraping service with:

- **Backend**: Express on port 3001 (`backend/src/`)
- **Frontend**: Vite + React on port 5173 (`frontend/src/`)
- **Database**: PostgreSQL — store only the **last 30 days** of scraped posts
- **Archives**: For data older than 30 days, export **one JSON file per day**, zip it, save under `ARCHIVE_DIR`, then delete those rows from PostgreSQL
- **Scraping**: Use Reddit public API `https://www.reddit.com/search.json` with **4 rotating SOCKS5 proxies** (`PROXY_1`–`PROXY_4` in `.env`) to reduce rate limits
- **Frontend features**:
  1. Live **scraping status** (running/idle, last run, proxy health, recent runs)
  2. **Keyword filter** on posts from the last 30 days (title, subreddit, search query, author)

**Run locally:**
```bash
cp .env.example .env
docker compose up -d
npm install
npm run dev
```

Open http://localhost:5173

**Key files:**
- `backend/src/services/scraper.js` — fetch + upsert
- `backend/src/services/proxyPool.js` — SOCKS5 rotation
- `backend/src/services/archiver.js` — daily ZIP export
- `backend/src/routes/api.js` — REST API
- `frontend/src/App.jsx` — dashboard UI

Follow `.cursor/rules/reddit-scraper.mdc` for conventions.

---

## Example follow-up prompts

- "Add subreddit filter to `/api/posts` and the search UI"
- "Show archive download links on a new Archives tab"
- "Add rate-limit backoff when Reddit returns 429"
