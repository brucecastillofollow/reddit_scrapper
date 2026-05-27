import { useCallback, useEffect, useState } from 'react';
import { formatDate } from '../utils.js';

const PROTOCOLS = ['socks5', 'socks4', 'http', 'https'];

function formatCount(n) {
  return Number(n ?? 0).toLocaleString();
}

export default function ManageProxiesTab({ status }) {
  const [protocol, setProtocol] = useState('socks5');
  const [lines, setLines] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  const limit = 50;

  const fetchProxies = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (search) params.set('search', search);
      const res = await fetch(`/api/proxies?${params}`);
      if (!res.ok) throw new Error('Failed to load proxies');
      setData(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    fetchProxies();
    const id = setInterval(fetchProxies, 15000);
    return () => clearInterval(id);
  }, [fetchProxies]);

  const onBulkAdd = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch('/api/proxies/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol, lines }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Bulk add failed');
      setMessage(body.message);
      if (body.parse_errors?.length) {
        setMessage(
          `${body.message} (${body.parse_errors.length} line(s) skipped — see console)`,
        );
        console.warn('Parse errors', body.parse_errors);
      }
      setLines('');
      setPage(1);
      fetchProxies();
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleEnabled = async (id, enabled) => {
    try {
      const res = await fetch(`/api/proxies/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled }),
      });
      if (!res.ok) throw new Error('Update failed');
      fetchProxies();
    } catch (e) {
      setError(e.message);
    }
  };

  const removeProxy = async (id) => {
    if (!confirm('Delete this proxy?')) return;
    try {
      const res = await fetch(`/api/proxies/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      fetchProxies();
    } catch (e) {
      setError(e.message);
    }
  };

  const reloadPool = async () => {
    try {
      const res = await fetch('/api/proxies/reload', { method: 'POST' });
      if (!res.ok) throw new Error('Reload failed');
      setMessage('Proxy pool reloaded');
      fetchProxies();
    } catch (e) {
      setError(e.message);
    }
  };

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / limit));
  const summary = data?.summary ?? status?.proxy_db_summary;

  return (
    <>
      <section className="grid">
        <div className="card">
          <h2>Database proxies</h2>
          <p className="value">{summary?.enabled ?? status?.proxies_db ?? '—'} enabled</p>
          <p className="card-meta">{summary?.total ?? '—'} total in DB</p>
        </div>
        <div className="card">
          <h2>Success requests</h2>
          <p className="value stat-success">{formatCount(summary?.success_requests)}</p>
          <p className="card-meta">Persisted per proxy in DB</p>
        </div>
        <div className="card">
          <h2>Failed requests</h2>
          <p className="value stat-failed">{formatCount(summary?.failed_requests)}</p>
          <p className="card-meta">Env proxies used when DB proxy fails</p>
        </div>
        <div className="card">
          <h2>Runtime pool</h2>
          <p className="value">{status?.proxies_configured ?? '—'}</p>
          <p className="card-meta">
            {status?.proxies_db ?? 0} db + env fallbacks · {status?.comment_queue?.workers ?? '—'}{' '}
            comment workers
          </p>
        </div>
      </section>

      <section className="card proxy-add-card">
        <h2 className="section-title">Add proxies</h2>
        <p className="card-meta section-intro">
          One proxy per line: <code>host:port</code>, <code>username:password@ip:port</code>,{' '}
          <code>host:port:username:password</code>, or{' '}
          <code>"username":"password"@"ip":"port"</code>. All lines use the selected protocol.
        </p>

        <form onSubmit={onBulkAdd} className="proxy-add-form">
          <label className="form-field">
            Protocol
            <select value={protocol} onChange={(e) => setProtocol(e.target.value)}>
              {PROTOCOLS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>

          <label className="form-field form-field-grow">
            Proxy list
            <textarea
              rows={8}
              placeholder={
                '192.168.1.1:1080\nuser:pass@192.168.1.10:8080\nproxy.example.com:8080:user:pass'
              }
              value={lines}
              onChange={(e) => setLines(e.target.value)}
            />
          </label>

          <div className="proxy-add-actions">
            <button type="submit" disabled={submitting || !lines.trim()}>
              {submitting ? 'Adding…' : 'Add proxies'}
            </button>
            <button type="button" className="secondary" onClick={reloadPool}>
              Reload pool
            </button>
          </div>
        </form>

        {message && <p className="success-banner">{message}</p>}
        {error && <p className="error-banner">{error}</p>}
      </section>

      <section className="card table-card">
        <div className="proxy-list-header">
          <h2 className="section-title">Proxy list</h2>
          <form
            className="search-bar proxy-search"
            onSubmit={(e) => {
              e.preventDefault();
              setPage(1);
              fetchProxies();
            }}
          >
            <input
              type="search"
              placeholder="Search host or username…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button type="submit" className="secondary">
              Search
            </button>
          </form>
        </div>

        {loading && !data ? (
          <p className="empty">Loading…</p>
        ) : data?.items?.length === 0 ? (
          <p className="empty">No proxies in database. Add some above.</p>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Protocol</th>
                    <th>Host</th>
                    <th>Port</th>
                    <th>User</th>
                    <th>Last used</th>
                    <th>Last success</th>
                    <th>Success</th>
                    <th>Failed</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((p) => (
                    <tr key={p.id}>
                      <td>{p.id}</td>
                      <td>{p.protocol}</td>
                      <td className="title-cell">{p.host}</td>
                      <td>{p.port}</td>
                      <td>{p.username || '—'}</td>
                      <td>{formatDate(p.last_used_at)}</td>
                      <td>{formatDate(p.last_success_at)}</td>
                      <td className="stat-success">
                        {formatCount(p.total_success_request_count)}
                      </td>
                      <td className={p.total_failed_request_count > 0 ? 'stat-failed' : ''}>
                        {formatCount(p.total_failed_request_count)}
                      </td>
                      <td>
                        <span className={`badge ${p.enabled ? 'running' : 'idle'}`}>
                          {p.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                      </td>
                      <td className="proxy-actions">
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => toggleEnabled(p.id, p.enabled)}
                        >
                          {p.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => removeProxy(p.id)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="pagination">
              <button
                type="button"
                className="secondary"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </button>
              <span>
                Page {page} of {totalPages} ({data.total.toLocaleString()} total)
              </span>
              <button
                type="button"
                className="secondary"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
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
