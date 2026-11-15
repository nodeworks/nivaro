import { useEffect, useMemo, useState } from 'react'

/**
 * "2 new" on a record's Comments / Tasks panel while it is folded shut: what
 * other people added since this person last had that panel open on this
 * record. Live because the panel's own list is live (RecordLiveSync re-reads
 * it on `$comments` / `$tasks`) — the count is computed from the rows the
 * panel already holds, so it costs no request of its own.
 *
 * The "last had it open" mark is per person, record and panel, kept in this
 * browser (localStorage, best-effort). The first time a panel is seen there is
 * no mark yet: it is set to now, so nobody opens an old record to "12 new".
 * Opening the panel clears the count and moves the mark while it stays open.
 */

export type SeenTab = 'comments' | 'tasks' | 'files'

/** One thing that happened in a panel: when, and who did it. */
export interface SeenEntry {
  at: string | number | Date | null | undefined
  by?: string | null
}

const PREFIX = 'nvr:tab-seen:'
/** Marks older than this are dropped the next time one is written. */
const KEEP_MS = 90 * 24 * 3_600_000
const MAX_KEYS = 400

export function seenKey(
  userId: string | null | undefined,
  collection: string,
  item: string | number,
  tab: SeenTab
): string {
  return `${PREFIX}${String(userId ?? 'anon').toLowerCase()}:${collection}:${String(item)}:${tab}`
}

export function readSeen(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

export function writeSeen(key: string, at: number = Date.now()): void {
  try {
    window.localStorage.setItem(key, String(at))
    pruneSeen(at)
  } catch {
    /* private window / blocked storage: the count just starts over */
  }
}

let lastPrune = 0
function pruneSeen(now: number): void {
  if (now - lastPrune < 3_600_000) return
  lastPrune = now
  try {
    const keys: Array<[string, number]> = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i)
      if (!k?.startsWith(PREFIX)) continue
      keys.push([k, Number(window.localStorage.getItem(k)) || 0])
    }
    keys.sort((a, b) => b[1] - a[1])
    keys.forEach(([k, t], i) => {
      if (i >= MAX_KEYS || now - t > KEEP_MS) window.localStorage.removeItem(k)
    })
  } catch {
    /* best effort */
  }
}

const sameId = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase()

/** Pure: how many entries other people made after `seenAt`. */
export function countNewSince(
  entries: SeenEntry[],
  seenAt: number | null,
  selfId: string | null | undefined
): number {
  if (seenAt == null) return 0
  let n = 0
  for (const e of entries) {
    if (e.by && sameId(e.by, selfId)) continue
    const t = e.at instanceof Date ? e.at.getTime() : new Date(e.at ?? '').getTime()
    if (Number.isFinite(t) && t > seenAt) n++
  }
  return n
}

/** Pure: "1 new", "2 new", "99+ new"; null for none. */
export function newCountLabel(n: number): string | null {
  if (!(n > 0)) return null
  return `${n > 99 ? '99+' : n} new`
}

/**
 * The count of entries other people added since this person last had the
 * panel open. `open` = the panel is showing its list now.
 */
export function useNewSince(opts: {
  userId: string | null | undefined
  collection: string
  item: string | number | null | undefined
  tab: SeenTab
  open: boolean
  entries: SeenEntry[]
  /** False while the list is still loading or the record is new. */
  ready: boolean
}): number {
  const { userId, collection, item, tab, open, entries, ready } = opts
  const key =
    item != null && item !== '' && item !== 'new' && userId
      ? seenKey(userId, collection, item, tab)
      : null
  const [seenAt, setSeenAt] = useState<number | null>(() => (key ? readSeen(key) : null))

  // A different record (or person): read its own mark.
  useEffect(() => {
    setSeenAt(key ? readSeen(key) : null)
  }, [key])

  // No mark yet: the baseline is now. Open: everything shown counts as seen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: entries re-run the mark while open
  useEffect(() => {
    if (!key || !ready) return
    if (open || readSeen(key) == null) {
      const now = Date.now()
      writeSeen(key, now)
      setSeenAt(now)
    }
  }, [key, ready, open, entries])

  return useMemo(
    () => (key && ready && !open ? countNewSince(entries, seenAt, userId) : 0),
    [key, ready, open, entries, seenAt, userId]
  )
}
