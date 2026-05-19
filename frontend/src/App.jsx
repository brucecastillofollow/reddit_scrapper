import { useCallback, useEffect, useState } from 'react';
import EfficiencyPanel from './EfficiencyPanel.jsx';
import OverviewTab from './tabs/OverviewTab.jsx';
import ProxiesTab from './tabs/ProxiesTab.jsx';
import CommentsTab from './tabs/CommentsTab.jsx';
import PostsTab from './tabs/PostsTab.jsx';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'posts', label: 'Posts' },
  { id: 'comments', label: 'Comments' },
  { id: 'proxies', label: 'Proxies' },
  { id: 'efficiency', label: 'Efficiency' },
];

export default function App() {
  const [tab, setTab] = useState('overview');
  const [status, setStatus] = useState(null);
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

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 5000);
    return () => clearInterval(id);
  }, [fetchStatus]);

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

  const running = status?.posts_running || status?.comments_running;

  return (
    <>
      <header className="app-header">
        <div>
          <h1>Reddit Scraper</h1>
          <p className="subtitle">
            Posts from new.json · comments from r/subreddit/comments.json · last{' '}
            {status?.retention_days ?? 30} days searchable
          </p>
        </div>
        {running && <span className="badge running header-badge">Scraping</span>}
      </header>

      {error && <div className="error-banner">{error}</div>}
      {(status?.last_post_error || status?.last_comment_error) && (
        <div className="error-banner">
          {status.last_post_error && <div>Posts: {status.last_post_error}</div>}
          {status.last_comment_error && <div>Comments: {status.last_comment_error}</div>}
        </div>
      )}

      <nav className="tabs" role="tablist" aria-label="Dashboard sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? 'tab-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="tab-panel" role="tabpanel">
        {tab === 'overview' && <OverviewTab status={status} onTriggerScrape={triggerScrape} />}
        {tab === 'posts' && (
          <PostsTab retentionDays={status?.retention_days} scraping={running} />
        )}
        {tab === 'comments' && <CommentsTab status={status} />}
        {tab === 'proxies' && <ProxiesTab status={status} />}
        {tab === 'efficiency' && <EfficiencyPanel />}
      </div>
    </>
  );
}
