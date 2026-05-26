import { pool } from '../db.js';

const SUPPORTED_PROTOCOLS = new Set(['socks5', 'socks4', 'http', 'https']);

export function isSupportedProtocol(protocol) {
  return SUPPORTED_PROTOCOLS.has(String(protocol || '').toLowerCase());
}

/** Parse lines: host:port or host:port:user or host:port:user:pass */
export function parseProxyLines(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const parsed = [];
  const errors = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const parts = line.split(':');
    if (parts.length < 2) {
      errors.push({ line: i + 1, message: 'Expected host:port[:username[:password]]' });
      continue;
    }

    const host = parts[0].trim();
    const port = Number(parts[1]);
    const username = parts.length >= 3 ? parts.slice(2, parts.length > 3 ? -1 : undefined).join(':').trim() : '';
    const password = parts.length >= 4 ? parts[parts.length - 1].trim() : '';

    if (!host) {
      errors.push({ line: i + 1, message: 'Missing host' });
      continue;
    }
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      errors.push({ line: i + 1, message: 'Invalid port' });
      continue;
    }

    parsed.push({ host, port, username: username || '', password: password || '' });
  }

  return { parsed, errors };
}

export function buildProxyUrl({ protocol, host, port, username, password }) {
  const proto = String(protocol).toLowerCase();
  const auth =
    username || password
      ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
      : '';
  return `${proto}://${auth}${host}:${port}`;
}

export function maskProxyRow(row) {
  const user = row.username ? `${row.username.slice(0, 2)}***` : '';
  return `${row.host}:${row.port}${user ? ` (${user})` : ''}`;
}

export async function listProxies({ page = 1, limit = 50, search = '', enabledOnly = false } = {}) {
  const offset = (page - 1) * limit;
  const params = [];
  let where = '1=1';

  if (enabledOnly) {
    where += ' AND enabled = true';
  }

  if (search) {
    params.push(`%${search}%`);
    const p = params.length;
    where += ` AND (host ILIKE $${p} OR username ILIKE $${p} OR protocol ILIKE $${p})`;
  }

  const countSql = `SELECT COUNT(*)::int AS total FROM proxies WHERE ${where}`;
  const listSql = `
    SELECT id, protocol, host, port, username,
           CASE WHEN password <> '' THEN true ELSE false END AS has_password,
           enabled, last_success_at,
           total_success_request_count, total_failed_request_count, created_at
    FROM proxies
    WHERE ${where}
    ORDER BY id DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

  const listParams = [...params, limit, offset];
  const [{ rows: countRows }, { rows: items }] = await Promise.all([
    pool.query(countSql, params),
    pool.query(listSql, listParams),
  ]);

  return {
    items: items.map((r) => ({
      ...r,
      host_masked: maskProxyRow(r),
      requests_total:
        Number(r.total_success_request_count) + Number(r.total_failed_request_count),
    })),
    total: countRows[0].total,
    page,
    page_size: limit,
  };
}

export async function listEnabledProxiesForPool() {
  const { rows } = await pool.query(
    `SELECT id, protocol, host, port, username, password,
            last_success_at, total_success_request_count, total_failed_request_count
     FROM proxies
     WHERE enabled = true
     ORDER BY total_failed_request_count ASC,
              (CASE WHEN total_success_request_count = 0 AND total_failed_request_count = 0 THEN 0 ELSE 1 END),
              last_success_at ASC NULLS FIRST,
              id ASC`,
  );
  return rows;
}

export async function bulkInsertProxies(protocol, entries) {
  if (!isSupportedProtocol(protocol)) {
    throw new Error(`Unsupported protocol: ${protocol}`);
  }
  if (!entries.length) return { inserted: 0, skipped: 0 };

  const client = await pool.connect();
  let inserted = 0;
  let skipped = 0;

  try {
    await client.query('BEGIN');
    for (const e of entries) {
      const { rowCount } = await client.query(
        `INSERT INTO proxies (protocol, host, port, username, password)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (protocol, host, port, username) DO NOTHING`,
        [protocol, e.host, e.port, e.username || '', e.password || ''],
      );
      if (rowCount > 0) inserted += 1;
      else skipped += 1;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { inserted, skipped };
}

export async function setProxyEnabled(id, enabled) {
  const { rowCount } = await pool.query(
    `UPDATE proxies SET enabled = $2 WHERE id = $1`,
    [id, enabled],
  );
  return rowCount > 0;
}

export async function deleteProxy(id) {
  const { rowCount } = await pool.query(`DELETE FROM proxies WHERE id = $1`, [id]);
  return rowCount > 0;
}

export async function deleteProxiesBulk(ids) {
  if (!ids.length) return 0;
  const { rowCount } = await pool.query(`DELETE FROM proxies WHERE id = ANY($1::int[])`, [ids]);
  return rowCount;
}

export async function recordProxyRequestResult(proxyDbId, success) {
  if (!proxyDbId) return;
  if (success) {
    await pool.query(
      `UPDATE proxies SET
        last_success_at = NOW(),
        total_success_request_count = total_success_request_count + 1
       WHERE id = $1`,
      [proxyDbId],
    );
  } else {
    await pool.query(
      `UPDATE proxies SET total_failed_request_count = total_failed_request_count + 1 WHERE id = $1`,
      [proxyDbId],
    );
  }
}

export async function getProxySummary() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE enabled = true)::int AS enabled,
      COALESCE(SUM(total_success_request_count), 0)::bigint AS success_requests,
      COALESCE(SUM(total_failed_request_count), 0)::bigint AS failed_requests
    FROM proxies
  `);
  return rows[0];
}
