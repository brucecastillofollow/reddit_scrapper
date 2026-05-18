/** Cursor from newest item on a listing page (Reddit `after` param). */
export function getListingCursor(child) {
  if (!child?.data) return null;
  if (child.data.name) return child.data.name;
  if (child.kind && child.data.id) return `${child.kind}_${child.data.id}`;
  return null;
}

export function getListingChildren(listing) {
  return listing?.data?.children ?? [];
}

/**
 * Paginate with `after` (public JSON API). Bootstrap = single page.
 * Saves the first page's newest item id as the run bookmark.
 */
export async function paginateWithAfter({
  bootstrap,
  startAfter,
  maxPages,
  fetchPage,
  processPage,
}) {
  let cursorAfter = startAfter ?? null;
  let savedLastId = null;
  let pages = 0;
  let lastPageCount = 0;
  let lastMeta = {};

  while (pages < maxPages) {
    const params = { limit: 100 };
    if (cursorAfter) params.after = cursorAfter;

    const result = await fetchPage(params);
    lastMeta = result;
    pages += 1;

    const children = getListingChildren(result.listing);
    lastPageCount = children.length;

    if (lastPageCount === 0) break;

    const pageNewestId = getListingCursor(children[0]);
    if (!savedLastId && pageNewestId) savedLastId = pageNewestId;

    await processPage(children, { listing: result.listing, page: pages });

    if (bootstrap || lastPageCount < 100) break;

    cursorAfter = pageNewestId;
    if (!cursorAfter) break;
  }

  return { savedLastId, pages, lastPageCount, ...lastMeta };
}
