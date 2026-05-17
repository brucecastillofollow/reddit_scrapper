import { useCallback, useEffect, useState } from 'react';

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function postUrl(permalink) {
  if (!permalink) return '#';
  if (permalink.startsWith('http')) return permalink;
  return `https://www.reddit.com${permalink}`;
}

export default function App() {
  const [status, setStatus] = useState(null);
  const [keyword, setKeyword] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [posts, setPosts] = useState({ items: [], total: 0, page: 1, page_size: 20 });
  const [loadingPosts, setLoadingPosts] = useState(false);
  const [error, setError] = useState(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) throw new Error('Failed to load status');
      setStatus(await res.json());
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const fetchPosts = useCallback(async (kw, page = 1) => {
    setLoadingPosts(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (kw) params.set('keyword', kw);
      const res = await fetch(`/api/posts?${params}`);
      if (!res.ok) throw new Error('Failed to load posts');
      setPosts(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingPosts(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchPosts('');
    const id = setInterval(fetchStatus, 5000);
    return () => clearInterval(id);
  }, [fetchStatus, fetchPosts]);

  const onSearch = (e) => {
    e.preventDefault();
    setKeyword(searchInput);
    fetchPosts(searchInput, 1);
  };

  const triggerScrape = async () => {
    try {
      const res = await fetch('/api/scrape/run', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Could not start scrape');
      }
      fetchStatus();
    } catch (e) {
      setError(e.message);
    }
  };

  const totalPages = Math.max(1, Math.ceil(posts.total / posts.page_size));
  const running = status?.posts_running || status?.comments_running;

  return (
    <>
      <h1>Reddit Scraper</h1>
      <p className="subtitle">
        Posts from new.json · comments from r/subreddit/comments.json · last{' '}
        {status?.retention_days ?? 30} days searchable
      </p>

      {error && <div className="error-banner">{error}</div>}
      {(status?.last_post_error || status?.last_comment_error) && (
        <div className="error-banner">
          {status.last_post_error && <div>Posts: {status.last_post_error}</div>}
          {status.last_comment_error && <div>Comments: {status.last_comment_error}</div>}
        </div>
      )}

      <section className="grid">
        <div className="card">
          <h2>Post scraper</h2>
          <p className="value">
            <span className={`badge ${status?.posts_running ? 'running' : 'idle'}`}>
              {status?.posts_running ? 'Running' : 'Idle'}
            </span>
          </p>
          <p style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
            Last: {formatDate(status?.last_post_finished_at)}
          </p>
          <button
            type="button"
            style={{ marginTop: '1rem' }}
            onClick={triggerScrape}
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
          <p style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
            {status?.subreddit_count ?? 0} subreddits tracked
          </p>
        </div>

        <div className="card">
          <h2>Database</h2>
          <p className="value">{status?.total_posts_in_db?.toLocaleString() ?? '—'} posts</p>
          <p style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
            {status?.total_comments_in_db?.toLocaleString() ?? '—'} comments
          </p>
        </div>

        <div className="card">
          <h2>Global interval</h2>
          <p className="value">{status?.global?.interval_seconds ?? '—'}s</p>
          <p style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
            Last post ts: {formatDate(status?.global?.last_timestamp)}
          </p>
        </div>

        <div className="card">
          <h2>Proxies</h2>
          <p className="value">
            {status?.proxies_healthy ?? 0} / {status?.proxies_configured ?? 0} healthy
          </p>
        </div>
      </section>

      {status?.recent_subreddits?.length > 0 && (
        <section className="card" style={{ marginBottom: '2rem' }}>
          <h2>Recent subreddit polls</h2>
          <ul className="runs-list">
            {status.recent_subreddits.map((s) => (
              <li key={s.name}>
                <span>
                  r/{s.name} — interval {s.interval_seconds}s
                </span>
                <span className="badge idle">{formatDate(s.last_poll_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <form className="search-bar" onSubmit={onSearch}>
          <input
            type="search"
            placeholder="Filter posts by keyword (title, subreddit, author, body)…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <button type="submit" disabled={loadingPosts}>
            Search
          </button>
          {keyword && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setSearchInput('');
                setKeyword('');
                fetchPosts('', 1);
              }}
            >
              Clear
            </button>
          )}
        </form>

        <p style={{ color: 'var(--muted)', marginBottom: '1rem', fontSize: '0.9rem' }}>
          {posts.total.toLocaleString()} result{posts.total !== 1 ? 's' : ''}
          {keyword ? ` for “${keyword}”` : ''} (last {posts.retention_days ?? 30} days)
          {running ? ' · scraping…' : ''}
        </p>

        {loadingPosts ? (
          <p className="empty">Loading…</p>
        ) : posts.items.length === 0 ? (
          <p className="empty">No posts found.</p>
        ) : (
          <>
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <table>
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Subreddit</th>
                    <th>Score</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {posts.items.map((p) => (
                    <tr key={p.data_id}>
                      <td className="title-cell">
                        <a href={postUrl(p.permalink)} target="_blank" rel="noreferrer">
                          {p.title}
                        </a>
                      </td>
                      <td>r/{p.subreddit}</td>
                      <td>{p.score}</td>
                      <td>{formatDate(p.created_utc)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="pagination">
              <button
                type="button"
                className="secondary"
                disabled={posts.page <= 1}
                onClick={() => fetchPosts(keyword, posts.page - 1)}
              >
                Previous
              </button>
              <span>
                Page {posts.page} of {totalPages}
              </span>
              <button
                type="button"
                className="secondary"
                disabled={posts.page >= totalPages}
                onClick={() => fetchPosts(keyword, posts.page + 1)}
              >
                Next
              </button>
            </div>
          </>
        )}
      </section>
    </>
  );
}
