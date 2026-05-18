import { useCallback, useEffect, useMemo, useState } from 'react';

function formatDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  if (sec < 120) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

function scoreClass(score) {
  if (score >= 75) return 'score-good';
  if (score >= 40) return 'score-mid';
  return 'score-low';
}

function ActivityChart({ series, label }) {
  const buckets = useMemo(() => {
    if (!series?.length) return [];
    const step = Math.max(1, Math.floor(series.length / 120));
    const sampled = [];
    for (let i = 0; i < series.length; i += step) sampled.push(series[i]);
    const max = Math.max(1, ...sampled.map((b) => b.weighted_count ?? b.count));
    return sampled.map((b) => ({
      ...b,
      pct: ((b.weighted_count ?? b.count) / max) * 100,
    }));
  }, [series]);

  if (!buckets.length) return <p className="empty">No comment history in range.</p>;

  return (
    <div className="chart-wrap">
      <p className="chart-label">{label}</p>
      <div className="chart-bars" role="img" aria-label={label}>
        {buckets.map((b) => (
          <div
            key={b.minute}
            className="chart-bar"
            title={`${new Date(b.minute).toLocaleString()}\nraw: ${b.count}\nweighted: ${b.weighted_count ?? b.count}`}
            style={{ height: `${Math.max(2, b.pct)}%` }}
          />
        ))}
      </div>
      <p className="chart-legend">
        <span>older</span>
        <span>recent → (taller = more gravity-weighted volume)</span>
      </p>
    </div>
  );
}

export default function EfficiencyPanel() {
  const [data, setData] = useState(null);
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchEfficiency = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/efficiency?days=${days}&limit=40`);
      if (!res.ok) throw new Error('Failed to load efficiency data');
      setData(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    fetchEfficiency();
    const id = setInterval(fetchEfficiency, 30000);
    return () => clearInterval(id);
  }, [fetchEfficiency]);

  const g = data?.global;

  return (
    <section className="efficiency-section">
      <div className="efficiency-header">
        <div>
          <h2>Scrape efficiency</h2>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            Weighted comment rate from DB (last {days} days). Recent minutes count more — e.g. 1k
            comments last minute outweighs 1k comments from an hour ago. Target:{' '}
            {data?.target_batch ?? 100} new comments per scrape.
          </p>
        </div>
        <label className="days-picker">
          History
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={1}>1 day</option>
            <option value={3}>3 days</option>
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
          </select>
        </label>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && !data && <p className="empty">Loading efficiency…</p>}

      {g && (
        <>
          <div className="grid">
            <div className="card">
              <h2>Weighted rate</h2>
              <p className="value">{g.weighted_rate_per_min?.toLocaleString() ?? '—'}/min</p>
              <p style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
                Half-life {data.half_life_minutes}m · {g.total_comments?.toLocaleString()} comments
                in window
              </p>
            </div>
            <div className="card">
              <h2>Recommended interval</h2>
              <p className="value">{formatDuration(g.recommended_interval_sec)}</p>
              <p style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
                Wait ~this long to refill {data.target_batch} comments at current weighted rate
              </p>
            </div>
            <div className="card">
              <h2>Peak minute</h2>
              <p className="value">{g.peak_count?.toLocaleString() ?? '—'}</p>
              <p style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
                {g.peak_minute ? new Date(g.peak_minute).toLocaleString() : '—'}
              </p>
            </div>
          </div>

          <ActivityChart
            series={g.series}
            label="Global weighted activity (recent = right, bar height = gravity-weighted volume)"
          />

          {data.subreddits?.length > 0 && (
            <div className="card" style={{ padding: 0, overflow: 'hidden', marginTop: '1.5rem' }}>
              <table>
                <thead>
                  <tr>
                    <th>Subreddit</th>
                    <th>Weighted /min</th>
                    <th>Rec. interval</th>
                    <th>Current interval</th>
                    <th>Last scrape new</th>
                    <th>Batch %</th>
                    <th>Overall</th>
                  </tr>
                </thead>
                <tbody>
                  {data.subreddits.map((s) => (
                    <tr key={s.name}>
                      <td>r/{s.name}</td>
                      <td>{s.weighted_rate_per_min?.toLocaleString() ?? '—'}</td>
                      <td>{formatDuration(s.recommended_interval_sec)}</td>
                      <td>{formatDuration(s.interval_seconds)}</td>
                      <td>{s.last_scrape_new ?? 0}</td>
                      <td className={scoreClass(s.batch_score)}>{s.batch_score ?? 0}%</td>
                      <td className={scoreClass(s.overall)}>{s.overall ?? 0}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
