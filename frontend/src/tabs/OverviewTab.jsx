import { formatDate } from '../utils.js';

export default function OverviewTab({ status, onTriggerScrape }) {
  return (
    <section className="grid">
      <div className="card">
        <h2>Post scraper</h2>
        <p className="value">
          <span className={`badge ${status?.posts_running ? 'running' : 'idle'}`}>
            {status?.posts_running ? 'Running' : 'Idle'}
          </span>
        </p>
        <p className="card-meta">
          Every {status?.post_scrape_interval_seconds ?? 30}s · failover to next proxy on error · same
          session for pagination
        </p>
        <p className="card-meta">Last: {formatDate(status?.last_post_run?.finished_at)}</p>
        <p className="card-meta">
          <span className="stat-success">+{status?.last_post_run?.new?.toLocaleString() ?? 0} new</span>
          {' · '}
          {status?.last_post_run?.existing?.toLocaleString() ?? 0} updated
        </p>
        <button
          type="button"
          className="tab-action"
          onClick={onTriggerScrape}
          disabled={status?.posts_running}
        >
          Run post scrape
        </button>
      </div>

      <div className="card">
        <h2>Comment scraper</h2>
        <p className="value">
          <span className={`badge ${status?.comments_running ? 'running' : 'idle'}`}>
            {status?.comments_running ? 'Running' : 'Idle'}
          </span>
        </p>
        <p className="card-meta">
          Max {status?.comment_max_tasks ?? 20} tasks · {status?.comment_queue?.workers ?? 0} workers
        </p>
        <p className="card-meta">
          Queue {status?.comment_queue?.active ?? 0}/{status?.comment_queue?.max_tasks ?? 20} (
          {status?.comment_queue?.queued ?? 0} waiting, {status?.comment_queue?.in_flight ?? 0} in flight)
        </p>
        <p className="card-meta">
          Last: {formatDate(status?.last_comment_run?.finished_at)}
          {status?.last_comment_run?.subreddit && <> · r/{status.last_comment_run.subreddit}</>}
        </p>
        <p className="card-meta">
          <span className="stat-success">
            +{status?.last_comment_run?.new?.toLocaleString() ?? 0} new
          </span>
          {' · '}
          {status?.last_comment_run?.existing?.toLocaleString() ?? 0} updated
        </p>
      </div>

      <div className="card">
        <h2>Database</h2>
        <p className="value">{status?.total_posts_in_db?.toLocaleString() ?? '—'} posts</p>
        <p className="card-meta">{status?.total_comments_in_db?.toLocaleString() ?? '—'} comments</p>
        <p className="card-meta">
          Session +{status?.session_added?.posts?.toLocaleString() ?? 0} posts · +
          {status?.session_added?.comments?.toLocaleString() ?? 0} comments
        </p>
      </div>

      <div className="card">
        <h2>Global watermark</h2>
        <p className="value">{formatDate(status?.global?.last_timestamp)}</p>
      </div>

      <div className="card">
        <h2>Proxies</h2>
        <p className="value">
          {status?.proxies_healthy ?? 0} / {status?.proxies_configured ?? 0} healthy
        </p>
        <p className="card-meta">
          Cooldown {status?.proxy_cooldown_min_seconds ?? 2}–{status?.proxy_cooldown_max_seconds ?? 10}s
        </p>
      </div>

      <div className="card">
        <h2>Subreddits</h2>
        <p className="value">{status?.subreddit_count ?? '—'}</p>
        <p className="card-meta">
          {status?.subreddit_comments?.waiting ?? 0} waiting ·{' '}
          {status?.subreddit_comments?.never_scraped ?? 0} never scraped
        </p>
      </div>
    </section>
  );
}
