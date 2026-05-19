export default function ProxiesTab({ status }) {
  const stats = status?.proxy_stats ?? [];
  if (stats.length === 0) {
    return <p className="empty">No proxies configured.</p>;
  }

  return (
    <section className="card table-card">
      <h2 className="section-title">Requests per proxy</h2>
      <p className="card-meta section-intro">
        One proxy per scrape run; pagination reuses the same session. Cooldown{' '}
        {status?.proxy_cooldown_min_seconds ?? 2}–{status?.proxy_cooldown_max_seconds ?? 10}s between
        requests on the same endpoint.
      </p>
      <table>
        <thead>
          <tr>
            <th>Proxy</th>
            <th>Protocol</th>
            <th>Status</th>
            <th>Total</th>
            <th>Success</th>
            <th>Failed</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((p) => (
            <tr key={p.id}>
              <td>
                <span className="proxy-id">{p.id}</span>
                <span className="proxy-meta">{p.url_masked}</span>
              </td>
              <td>{p.protocol}</td>
              <td>
                {p.quarantined ? (
                  <span className="badge error">
                    Quarantined {p.quarantine_remaining_sec}s
                  </span>
                ) : (
                  <span className="badge idle">OK</span>
                )}
              </td>
              <td>{p.requests_total.toLocaleString()}</td>
              <td className="stat-success">{p.requests_success.toLocaleString()}</td>
              <td className={p.requests_failed > 0 ? 'stat-failed' : ''}>
                {p.requests_failed.toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
