/**
 * The page a list was on, per browser history entry (army 8 b14: list page 2 → open a
 * row → Back landed on page 1 again; the page lives only in component state).
 *
 * Kept in sessionStorage under the history entry's own key (react-router writes a
 * unique `key` into `history.state` for every entry), so Back to THAT entry restores
 * its page, while a fresh visit to the same list (a new entry: a nav click, a new
 * tab) starts on page 1 as before. Storage failures (private mode, quota) are ignored.
 *
 * Army 9 b14: the FIRST entry after a full page load (a bookmark, a link from an email, a
 * new tab) carries no `key` — react-router writes only `{idx: 0}` there — so nothing was
 * remembered for the most common way in. Writing a page now mints a key for that entry
 * (history.replaceState keeps every other state field, so the router's idx and usr stay).
 *
 * Army 10: a record's own back arrow (efp-new) does not step back through history — it
 * opens the page the record was opened from as a NEW entry, so the per-entry page was
 * never found. That navigation carries LIST_RETURN_STATE; a list reached that way starts
 * on the page it was last on in this tab (kept per list beside the per-entry pages).
 */

const PREFIX = 'nvr:list-page:'
/** The page each list was last on in this tab (read only on a "return to the list"). */
const LAST = `${PREFIX}last:`
/** Entries kept at most; the oldest are dropped. */
const MAX_ENTRIES = 50

export function historyKey(): string | null {
  if (typeof window === 'undefined') return null
  const st = window.history?.state as { key?: unknown } | null | undefined
  return typeof st?.key === 'string' && st.key ? st.key : null
}

/**
 * History state for a navigation that RETURNS to a list (a record's back arrow): react-router
 * stores it under `usr`, where rememberedListPage looks for it. Hosts that cannot import this
 * (efp-new pins the published package) pass the same literal.
 */
export const LIST_RETURN_STATE = { nvrListReturn: true } as const

/** True when the current history entry was reached by a "return to the list" navigation. */
export function arrivedByListReturn(): boolean {
  if (typeof window === 'undefined') return false
  const st = window.history?.state as { usr?: { nvrListReturn?: unknown } | null } | null
  return st?.usr?.nvrListReturn === true
}

/** The current entry's key, minting one for an entry that has none (see above). */
export function ensureHistoryKey(): string | null {
  const have = historyKey()
  if (have || typeof window === 'undefined' || !window.history) return have
  try {
    const st = window.history.state
    const base = st && typeof st === 'object' ? (st as Record<string, unknown>) : {}
    const key = `nvr${Math.random().toString(36).slice(2, 10)}`
    window.history.replaceState({ ...base, key }, '')
    return historyKey()
  } catch {
    return null
  }
}

function storageKey(list: string, entry: string): string {
  return `${PREFIX}${list}|${entry}`
}

/** The page remembered for this list on the current history entry (null = none / page 1). */
export function rememberedListPage(
  list: string,
  entry: string | null = historyKey()
): number | null {
  try {
    const own = entry ? window.sessionStorage.getItem(storageKey(list, entry)) : null
    const raw = own ?? (arrivedByListReturn() ? window.sessionStorage.getItem(LAST + list) : null)
    const n = raw == null ? Number.NaN : Number(raw)
    return Number.isInteger(n) && n > 1 && n < 100_000 ? n : null
  } catch {
    return null
  }
}

/** Remember (or, at page 1, forget) the list's page for the current history entry. */
export function rememberListPage(
  list: string,
  page: number,
  entry: string | null = page > 1 ? ensureHistoryKey() : historyKey()
): void {
  try {
    const store = window.sessionStorage
    if (!(page > 1)) {
      store.removeItem(LAST + list)
      if (entry) store.removeItem(storageKey(list, entry))
      return
    }
    store.setItem(LAST + list, String(Math.floor(page)))
    if (!entry) return
    store.setItem(storageKey(list, entry), String(Math.floor(page)))
    const ours: string[] = []
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i)
      if (k?.startsWith(PREFIX) && !k.startsWith(LAST)) ours.push(k)
    }
    // sessionStorage keeps insertion order per key well enough for a cap: drop the first.
    for (const k of ours.slice(0, Math.max(0, ours.length - MAX_ENTRIES))) store.removeItem(k)
  } catch {
    /* private mode / quota — nothing remembered */
  }
}

/**
 * While a list is still settling after it mounted (async scope seeds, debounced column
 * filters, a default view arriving), its automatic resets to page 1 must not throw away
 * the page Back returned to (army 9 b14: the seed reset wiped the remembered page 2).
 * Returns the page to show: the restored page while one is pending, else `next`.
 */
export function pageWhileSettling(pending: number | null, next: number): number {
  return pending && pending > 1 && next === 1 ? pending : next
}

/**
 * What the restore window does once the list's first read settles (see pageWhileSettling):
 * `close` ends the window, `page` moves a restored page that is now past the end to the
 * last page. A failed first read closes it too (army 9 review L3) — or every later reset
 * to page 1 (a filter, a sort) snapped back to the restored page. Null = keep waiting.
 */
export function restoreWindowOutcome(s: {
  pending: number | null
  gateOpen: boolean
  fetching: boolean
  failed: boolean
  placeholder: boolean
  loaded: boolean
  total: number | null | undefined
  totalUnknown: boolean
  pageSize: number
  page: number
}): { close: true; page: number | null } | null {
  if (s.pending == null) return null
  if (s.failed && !s.fetching) return { close: true, page: null }
  if (!s.gateOpen || !s.loaded || s.fetching || s.placeholder) return null
  const last =
    s.totalUnknown || s.total == null ? null : Math.max(1, Math.ceil(s.total / s.pageSize))
  return { close: true, page: last != null && s.page > last ? last : null }
}
