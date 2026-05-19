import fs from 'fs/promises';
import path from 'path';
import { CookieJar } from 'tough-cookie';
import { config } from '../config.js';

/** @type {Map<string, CookieJar>} */
const jars = new Map();

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const saveTimers = new Map();

function jarFile(id) {
  return path.join(config.redditCookieDir, `${id}.json`);
}

export async function getCookieJar(endpoint) {
  const id = endpoint?.id ?? 'unknown';
  if (jars.has(id)) return jars.get(id);

  const jar = new CookieJar();
  try {
    const raw = await fs.readFile(jarFile(id), 'utf8');
    await jar.deserialize(JSON.parse(raw));
  } catch {
    /* no saved cookies yet */
  }
  jars.set(id, jar);
  return jar;
}

export async function persistCookieJar(endpoint) {
  const id = endpoint?.id ?? 'unknown';
  const jar = jars.get(id);
  if (!jar) return;

  await fs.mkdir(config.redditCookieDir, { recursive: true });
  const serialized = await jar.serialize();
  await fs.writeFile(jarFile(id), JSON.stringify(serialized), 'utf8');
}

export function schedulePersistCookieJar(endpoint) {
  const id = endpoint?.id ?? 'unknown';
  const prev = saveTimers.get(id);
  if (prev) clearTimeout(prev);
  saveTimers.set(
    id,
    setTimeout(() => {
      saveTimers.delete(id);
      persistCookieJar(endpoint).catch(() => {});
    }, 1500),
  );
}

export async function clearCookieJar(endpoint) {
  const id = endpoint?.id ?? 'unknown';
  jars.delete(id);
  const prev = saveTimers.get(id);
  if (prev) clearTimeout(prev);
  saveTimers.delete(id);
  try {
    await fs.unlink(jarFile(id));
  } catch {
    /* missing file */
  }
}

export function clearAllCookieJars() {
  jars.clear();
  for (const t of saveTimers.values()) clearTimeout(t);
  saveTimers.clear();
}

/** True when the jar already has anonymous Reddit session cookies. */
export async function hasRedditSession(endpoint) {
  const jar = await getCookieJar(endpoint);
  const cookies = await jar.getCookies('https://www.reddit.com');
  return cookies.length >= 1;
}
