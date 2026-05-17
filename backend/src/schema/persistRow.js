import { pool } from '../db.js';

export function rowToQuery(row, table) {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  const cols = keys.join(', ');
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const values = keys.map((k) => {
    const v = row[k];
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      return JSON.stringify(v);
    }
    return v;
  });
  return { sql: `INSERT INTO ${table} (${cols}) VALUES (${placeholders})`, values, keys };
}

export function rowToUpdate(row, table, pk = 'data_id') {
  const keys = Object.keys(row).filter((k) => k !== pk && row[k] !== undefined);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const values = [
    row[pk],
    ...keys.map((k) => {
      const v = row[k];
      if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
        return JSON.stringify(v);
      }
      return v;
    }),
  ];
  return {
    sql: `UPDATE ${table} SET ${sets}, updated_at = NOW() WHERE ${pk} = $1`,
    values,
  };
}

export async function insertRow(table, row) {
  const { sql, values } = rowToQuery(row, table);
  await pool.query(sql, values);
}

export async function updateRow(table, row) {
  const { sql, values } = rowToUpdate(row, table);
  await pool.query(sql, values);
}
