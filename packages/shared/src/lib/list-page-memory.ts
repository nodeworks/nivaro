/**
 * The page a list was on, per browser history entry (army 8 b14: list page 2 → open a
 * row → Back landed on page 1 again; the page lives only in component state).
 *
 * Kept in sessionStorage under the history entry's own key (react-router writes a
 * unique `key` into `history.state` for every entry), so Back to THAT entry restores
 * its page, while a fresh visit to the same list (a new entry: a nav click, a new
 * tab) starts on page 1 as before. Without a history key (a host without a router),
 * nothing is remembered. Storage failures (private mode, quota) are ignored.
 */

const PREFIX = 'nvr:list-page:'
/** Entries kept at most; the oldest are dropped. */
const MAX_ENTRIES = 50

function historyKey(): string | null {
  if (typeof window === 'undefined') return null
  const st = window.history?.state as { key?: unknown } | null | undefined
  return typeof st?.key === 'string' && st.key ? st.key : null
}

function storageKey(list: string, entry: string): string {
  return `${PREFIX}${list}|${entry}`
}

/** The page remembered for this list on the current history entry (null = none / page 1). */
export function rememberedListPage(
  list: string,
  entry: string | null = historyKey()
): number | null {
  if (!entry) return null
  try {
    const raw = window.sessionStorage.getItem(storageKey(list, entry))
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
  entry: string | null = historyKey()
): void {
  if (!entry) return
  try {
    const store = window.sessionStorage
    const key = storageKey(list, entry)
    if (!(page > 1)) {
      store.removeItem(key)
      return
    }
    store.setItem(key, String(Math.floor(page)))
    const ours: string[] = []
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i)
      if (k?.startsWith(PREFIX)) ours.push(k)
    }
    // sessionStorage keeps insertion order per key well enough for a cap: drop the first.
    for (const k of ours.slice(0, Math.max(0, ours.length - MAX_ENTRIES))) store.removeItem(k)
  } catch {
    /* private mode / quota — nothing remembered */
  }
}
