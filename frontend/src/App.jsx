import { useCallback, useEffect, useState } from 'react';

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
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

  return (
    <>
      <h1>Reddit Scraper</h1>
      <p className="subtitle">
        Last {status?.retention_days ?? 30} days in PostgreSQL · older data archived as daily ZIP
      </p>

      {error && <div className="error-banner">{error}</div>}
      {status?.last_error && (
        <div className="error-banner">Last scrape error: {status.last_error}</div>
      )}

      <section className="grid">
        <div className="card">
          <h2>Scrape status</h2>
          <p className="value">
            <span className={`badge ${status?.is_running ? 'running' : 'idle'}`}>
              {status?.is_running ? 'Running' : 'Idle'}
            </span>
          </p>
          <p style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
            Last run: {formatDate(status?.last_finished_at)}
          </p>
          <button
            type="button"
            style={{ marginTop: '1rem' }}
            onClick={triggerScrape}
            disabled={status?.is_running}
          >
            Run scrape now
          </button>
        </div>

        <div className="card">
          <h2>Posts in database</h2>
          <p className="value">{status?.total_posts_in_db?.toLocaleString() ?? '—'}</p>
        </div>

        <div className="card">
          <h2>Proxies</h2>
          <p className="value">
            {status?.proxies_healthy ?? 0} / {status?.proxies_configured ?? 0} healthy
          </p>
          <p style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
            Active index: {status?.active_proxy_index ?? 0}
          </p>
        </div>

        <div className="card">
          <h2>Schedule</h2>
          <p className="value">Every {status?.scrape_interval_minutes ?? 15} min</p>
          <p style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
            Queries: {(status?.search_queries ?? []).join(', ') || '—'}
          </p>
        </div>
      </section>

      {status?.recent_runs?.length > 0 && (
        <section className="card" style={{ marginBottom: '2rem' }}>
          <h2>Recent runs</h2>
          <ul className="runs-list">
            {status.recent_runs.map((run) => (
              <li key={run.id}>
                <span>
                  <strong>{run.query}</strong> — {run.posts_inserted} new / {run.posts_fetched}{' '}
                  fetched
                </span>
                <span className={`badge ${run.status === 'success' ? 'idle' : 'error'}`}>
                  {run.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <form className="search-bar" onSubmit={onSearch}>
          <input
            type="search"
            placeholder="Filter by keyword (title, subreddit, query, author)…"
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
                    <tr key={p.id}>
                      <td className="title-cell">
                        <a href={p.permalink} target="_blank" rel="noreferrer">
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
