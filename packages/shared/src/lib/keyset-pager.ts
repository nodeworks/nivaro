/**
 * #2447 — page forward with a cursor instead of an offset.
 *
 * A paged list keeps one `CursorBook` per mounted list. Page 1 asks `after=start`; each
 * answer's `next_cursor` is written down as the way to reach the next page, so "Next" sends
 * the cursor and the server starts right after the last row it served (page 200 costs what
 * page 1 does). A page with no cursor written down (jumping to the last page, a fresh mount
 * on page 7) asks by number, with the same sort plus the id tie-break, so both ways put the
 * rows in one order. When the server refuses a cursor walk for this list (a sort on a
 * linked or computed field), the book stops trying until the list's query changes.
 *
 * The book is keyed by everything that shapes the list except the page; any change to that
 * key forgets every cursor.
 */

export interface CursorBook {
  key: string
  /** page → the cursor that reaches it. */
  cursors: Map<number, string>
  /** The server refused cursor paging for this key. */
  off: boolean
}

export const CURSOR_START = 'start'

export function createCursorBook(): CursorBook {
  return { key: '', cursors: new Map(), off: false }
}

function sync(book: CursorBook, key: string): void {
  if (book.key === key) return
  book.key = key
  book.cursors.clear()
  book.off = false
}

/**
 * How to ask for `page`: `{ after }` when a cursor reaches it, `{ page }` otherwise. `sort`
 * is what the request should send as its sort (the id tie-break added on the by-number path
 * while cursor paging is on).
 */
export function pageRequest(
  book: CursorBook,
  key: string,
  page: number,
  sort: string
): { after?: string; page?: number; sort: string } {
  sync(book, key)
  // A cursor walks the record's own stored columns: a linked or computed sort never can.
  if (/[.$]/.test(sort)) book.off = true
  if (book.off) return { page, sort }
  if (page <= 1) return { after: CURSOR_START, sort }
  const after = book.cursors.get(page)
  if (after) return { after, sort }
  return { page, sort: withIdTieBreak(sort) }
}

/** Write down how to reach the page after `page` (null = `page` was the last). */
export function noteNextCursor(
  book: CursorBook,
  key: string,
  page: number,
  next: string | null | undefined
): void {
  sync(book, key)
  if (book.off) return
  if (typeof next === 'string' && next) book.cursors.set(page + 1, next)
  else book.cursors.delete(page + 1)
}

/** The server cannot walk this list by cursor: page by number until the key changes. */
export function stopCursors(book: CursorBook, key: string): void {
  sync(book, key)
  book.off = true
  book.cursors.clear()
}

/** A cursor refusal (bad sort for a cursor, stale / foreign cursor). */
export function isCursorRefusal(err: unknown): boolean {
  const e = err as { status?: number; response?: { code?: unknown } } | null
  return e?.status === 400 && /^CURSOR_/.test(String(e.response?.code ?? ''))
}

/** `sort` with `id` appended unless it already orders by id (a repeated column is an error). */
export function withIdTieBreak(sort: string): string {
  const parts = sort
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.some((p) => p.replace(/^-/, '').toLowerCase() === 'id')) return parts.join(',')
  return [...parts, 'id'].join(',')
}
