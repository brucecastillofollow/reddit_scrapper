import { pool } from '../db.js';
import { config } from '../config.js';

const SUPPORTED_PROTOCOLS = new Set(['socks5', 'socks4', 'http', 'https']);

export function isSupportedProtocol(protocol) {
  return SUPPORTED_PROTOCOLS.has(String(protocol || '').toLowerCase());
}

function parseQuotedProxyLine(line) {
  const quoted = line.match(/^"([^"]+)"\s*:\s*"([^"]*)"\s*@\s*"([^"]+)"\s*:\s*"([^"]+)"$/);
  if (!quoted) return null;

  const [, username, password, host, portRaw] = quoted;
  const port = Number(portRaw);

  if (!host) return { error: 'Missing host' };
  if (!Number.isFinite(port) || port < 1 || port > 65535) return { error: 'Invalid port' };

  return { host, port, username: username || '', password: password || '' };
}

/** username:password@ip:port (password may contain colons or @) */
function parseAtProxyLine(line) {
  if (!line.includes('@') || line.startsWith('"')) return null;

  const atIdx = line.lastIndexOf('@');
  const auth = line.slice(0, atIdx);
  const hostPort = line.slice(atIdx + 1);

  const colonIdx = hostPort.lastIndexOf(':');
  if (colonIdx <= 0) return { error: 'Invalid host:port after @' };

  const host = hostPort.slice(0, colonIdx).trim();
  const port = Number(hostPort.slice(colonIdx + 1).trim());

  const userColon = auth.indexOf(':');
  if (userColon < 0) return { error: 'Expected username:password before @' };

  const username = auth.slice(0, userColon).trim();
  const password = auth.slice(userColon + 1);

  if (!host) return { error: 'Missing host' };
  if (!Number.isFinite(port) || port < 1 || port > 65535) return { error: 'Invalid port' };

  return { host, port, username: username || '', password: password || '' };
}

/** Parse lines:
 * - host:port
 * - host:port:username
 * - host:port:username:password
 * - username:password@ip:port
 * - "username":"password"@"ip":"port"
 */
export function parseProxyLines(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const parsed = [];
  const errors = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const quoted = parseQuotedProxyLine(line);
    if (quoted) {
      if (quoted.error) {
        errors.push({ line: i + 1, message: quoted.error });
      } else {
        parsed.push(quoted);
      }
      continue;
    }

    const atFormat = parseAtProxyLine(line);
    if (atFormat) {
      if (atFormat.error) {
        errors.push({ line: i + 1, message: atFormat.error });
      } else {
        parsed.push(atFormat);
      }
      continue;
    }

    const parts = line.split(':');
    if (parts.length < 2) {
      errors.push({
        line: i + 1,
        message:
          'Expected host:port, username:password@ip:port, or "username":"password"@"ip":"port"',
      });
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
           enabled, last_success_at, last_used_at, interval_seconds,
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
            last_success_at, last_used_at, interval_seconds,
            total_success_request_count, total_failed_request_count
     FROM proxies
     WHERE enabled = true
     ORDER BY total_failed_request_count ASC,
              last_used_at ASC NULLS FIRST,
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
        `INSERT INTO proxies (protocol, host, port, username, password, interval_seconds)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (protocol, host, port, username) DO NOTHING`,
        [protocol, e.host, e.port, e.username || '', e.password || '', config.proxyDefaultIntervalSeconds],
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

export async function setProxyInterval(id, intervalSeconds) {
  const sec = Math.max(0, Math.floor(Number(intervalSeconds)));
  const { rowCount } = await pool.query(
    `UPDATE proxies SET interval_seconds = $2 WHERE id = $1`,
    [id, sec],
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

export async function recordProxyUsed(proxyDbId) {
  if (!proxyDbId) return;
  await pool.query(`UPDATE proxies SET last_used_at = NOW() WHERE id = $1`, [proxyDbId]);
}

/** @param {{ success: boolean, proxyFault?: boolean }} result */
export async function recordProxyRequestResult(proxyDbId, result) {
  if (!proxyDbId) return;
  const { success, proxyFault = false } = result;
  if (success) {
    await pool.query(
      `UPDATE proxies SET
        last_success_at = NOW(),
        total_success_request_count = total_success_request_count + 1
       WHERE id = $1`,
      [proxyDbId],
    );
  } else if (proxyFault) {
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
