import { formatDate } from '../utils.js';

export default function CommentsTab({ status }) {
  const q = status?.comment_queue;
  const subs = status?.subreddit_comments;

  return (
    <>
      <section className="grid">
        <div className="card">
          <h2>Task capacity</h2>
          <p className="value">
            {q?.active ?? 0} / {q?.max_tasks ?? 20}
          </p>
          <p className="card-meta">
            {q?.queued ?? 0} queued · {q?.in_flight ?? 0} in flight · {q?.capacity ?? 0} slots free
          </p>
        </div>
        <div className="card">
          <h2>Due now</h2>
          <p className="value">{subs?.waiting ?? '—'}</p>
          <p className="card-meta">{subs?.scheduled ?? 0} not due yet</p>
        </div>
        <div className="card">
          <h2>Scraped once+</h2>
          <p className="value">{subs?.scraped_once ?? '—'}</p>
          <p className="card-meta">Of {subs?.total ?? 0} tracked</p>
        </div>
        <div className="card">
          <h2>Never scraped</h2>
          <p className="value">{subs?.never_scraped ?? '—'}</p>
        </div>
      </section>

      {status?.waiting_subreddits?.length > 0 && (
        <section className="card list-card">
          <h2 className="section-title">Waiting for comment scrape</h2>
          <ul className="runs-list">
            {status.waiting_subreddits.map((s) => (
              <li key={s.name}>
                <span>
                  r/{s.name} — every {s.interval_seconds}s
                  {s.last_poll_at ? ` · last ${formatDate(s.last_poll_at)}` : ' · never scraped'}
                </span>
                <span className="badge running">waiting</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {status?.recent_subreddits?.length > 0 && (
        <section className="card list-card">
          <h2 className="section-title">Recently polled</h2>
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
    </>
  );
}
