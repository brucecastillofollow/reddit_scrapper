import { useCallback, useEffect, useState } from 'react';
import { formatDate, postUrl } from '../utils.js';

export default function PostsTab({ retentionDays, scraping }) {
  const [keyword, setKeyword] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [posts, setPosts] = useState({ items: [], total: 0, page: 1, page_size: 20 });
  const [loadingPosts, setLoadingPosts] = useState(false);
  const [error, setError] = useState(null);

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
    fetchPosts('');
  }, [fetchPosts]);

  const onSearch = (e) => {
    e.preventDefault();
    setKeyword(searchInput);
    fetchPosts(searchInput, 1);
  };

  const totalPages = Math.max(1, Math.ceil(posts.total / posts.page_size));

  return (
    <section>
      {error && <div className="error-banner">{error}</div>}

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

      <p className="card-meta results-summary">
        {posts.total.toLocaleString()} result{posts.total !== 1 ? 's' : ''}
        {keyword ? ` for “${keyword}”` : ''} (last {retentionDays ?? 30} days)
        {scraping ? ' · scraping…' : ''}
      </p>

      {loadingPosts ? (
        <p className="empty">Loading…</p>
      ) : posts.items.length === 0 ? (
        <p className="empty">No posts found.</p>
      ) : (
        <>
          <div className="card table-card" style={{ padding: 0 }}>
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
  );
}
