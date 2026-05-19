export function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export function postUrl(permalink) {
  if (!permalink) return '#';
  if (permalink.startsWith('http')) return permalink;
  return `https://www.reddit.com${permalink}`;
}
