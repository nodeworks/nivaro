/**
 * Back to the list keeps your place (realtime idea 16, 2026-11-14).
 *
 * Production showed people bouncing list → record → list hundreds of times a week, and every
 * return re-read the whole page. Three pieces make a return feel like the list never left:
 *
 * 1. WHERE A RECORD CAME FROM (`noteListOpen` / `readListReturn`): when a list opens a record it
 *    keeps, per tab, the ids it showed in order and which one was opened. The record header's
 *    "Previous / Next in list" walks that order (`listNeighbors`), and the list, once back,
 *    gives the row the person was last on a brief quiet highlight (`returnRowFor`,
 *    `markReturnRow`).
 *
 * 2. WHAT CHANGED WHILE AWAY (`standbyListAway` / `takeListAway`): while a list is mounted it
 *    holds a quiet second subscription to its collection's live events; when it unmounts, that
 *    subscription keeps recording (ids + field names only, never values) for a while. Coming
 *    back, the list reads the log: nothing changed → the cached rows stay as they are, no read
 *    at all; a few rows changed → only those rows are re-read (through the list's own live
 *    handler, as the viewer); the log is unsure (a dropped connection that could not replay,
 *    a bulk write, too many changes, too long away) → one quiet re-read with the cached rows
 *    kept on screen. `planListReturn` is that decision, pure and tested.
 *
 * 3. Scroll and page come back through the pieces that already did that (nav-trail.ts,
 *    list-page-memory.ts); this file adds nothing there.
 *
 * Everything is per tab (sessionStorage / module state) and best effort: storage off or no
 * realtime adapter simply means the list behaves as it did before.
 */

import { isOwnWrite } from './own-writes'
import type { CollectionUpdateEvent, RealtimeAdapter, RealtimeStatus } from './realtime'

// ─── 1. Where a record was opened from ──────────────────────────────────────

export const LIST_RETURN_KEY = 'nvr:list-return'
/** A stash older than this is not offered (Previous / Next, the return highlight). */
export const LIST_RETURN_MAX_AGE_MS = 6 * 60 * 60 * 1000
/** Rows kept in order at most (a page, or a grouped list's loaded rows). */
export const LIST_RETURN_MAX_ROWS = 500

export interface ListRef {
  collection: string
  id: string
}

export interface ListReturnStash {
  /** The list's own key: `cbv:<collection>`, `queue:<id>`. */
  list: string
  /** How the list is named to the person ("Workflows", a queue's name). */
  label?: string | null
  /** The list's address when the record was opened (pathname + search). */
  path: string
  /** The rows the list showed, in order. */
  rows: ListRef[]
  /**
   * How many records the WHOLE list holds (all pages), when the list knows it; null/absent =
   * unknown, and the header counts only the rows shown ("3 of 25 shown"), never passing a page
   * size off as the list's total (rt-nav review: "3 of 25" under "1–25 of about 49").
   */
  total?: number | null
  /** The list's total is an estimate (`count=approx`): said as "about 49". */
  totalApprox?: boolean
  /** Where `rows[0]` sits in the whole list, 0-based (page 2 of 25 → 25). */
  offset?: number
  /** The record the person is on now (moves with Previous / Next). */
  current: ListRef
  /** The record the list opened (stays put). */
  opened: ListRef
  /** history.state.idx of the record page (null when the host keeps no index). */
  idx: number | null
  /** The list's own history entry key, so Back to that entry knows it is a return. */
  entry: string | null
  at: number
}

const sameRef = (a: ListRef | null | undefined, b: ListRef | null | undefined) =>
  !!a &&
  !!b &&
  a.collection === b.collection &&
  String(a.id).toLowerCase() === String(b.id).toLowerCase()

function historyIdx(): number | null {
  if (typeof window === 'undefined') return null
  const idx = (window.history?.state as { idx?: unknown } | null)?.idx
  return typeof idx === 'number' && Number.isFinite(idx) ? idx : null
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch {
    return null
  }
}

/**
 * A list is opening a record: keep its row order and the opened row. Call it right BEFORE the
 * navigation (the record page lands one history entry later, which `idx` records).
 */
export function noteListOpen(s: {
  list: string
  label?: string | null
  path?: string
  rows: ListRef[]
  opened: ListRef
  entry?: string | null
  /** The whole list's record count (all pages), when known. */
  total?: number | null
  totalApprox?: boolean
  /** 0-based position of the first row shown in the whole list. */
  offset?: number
}): void {
  const store = storage()
  if (!store) return
  const here = historyIdx()
  const rows: ListRef[] = []
  const seen = new Set<string>()
  for (const r of s.rows) {
    if (!r?.collection || r.id == null || r.id === '') continue
    const k = `${r.collection}\u0001${String(r.id).toLowerCase()}`
    if (seen.has(k)) continue
    seen.add(k)
    rows.push({ collection: r.collection, id: String(r.id) })
    if (rows.length >= LIST_RETURN_MAX_ROWS) break
  }
  const stash: ListReturnStash = {
    list: s.list,
    label: s.label ?? null,
    path:
      s.path ??
      (typeof window !== 'undefined' ? `${window.location.pathname}${window.location.search}` : ''),
    rows,
    ...(typeof s.total === 'number' && Number.isFinite(s.total) && s.total >= 0
      ? { total: Math.round(s.total), ...(s.totalApprox ? { totalApprox: true } : {}) }
      : {}),
    ...(typeof s.offset === 'number' && Number.isFinite(s.offset) && s.offset > 0
      ? { offset: Math.floor(s.offset) }
      : {}),
    current: { collection: s.opened.collection, id: String(s.opened.id) },
    opened: { collection: s.opened.collection, id: String(s.opened.id) },
    idx: here == null ? null : here + 1,
    entry: s.entry ?? null,
    at: Date.now()
  }
  try {
    store.setItem(LIST_RETURN_KEY, JSON.stringify(stash))
  } catch {
    /* storage full / blocked — no Previous / Next this time */
  }
}

export function readListReturn(now = Date.now()): ListReturnStash | null {
  const store = storage()
  if (!store) return null
  try {
    const raw = store.getItem(LIST_RETURN_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as ListReturnStash
    if (!s || typeof s.list !== 'string' || !Array.isArray(s.rows) || !s.current) return null
    if (!(now - Number(s.at ?? 0) <= LIST_RETURN_MAX_AGE_MS)) return null
    return s
  } catch {
    return null
  }
}

function writeStash(s: ListReturnStash): void {
  try {
    storage()?.setItem(LIST_RETURN_KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}

/** Where `at` sits in the stashed list. */
export interface ListNeighbors {
  /** 1-based position among the rows the list showed (what Previous / Next walk). */
  index: number
  /** Rows the list showed (Previous / Next never leave them). */
  total: number
  prev: ListRef | null
  next: ListRef | null
  /** 1-based position in the WHOLE list (index + the page's offset). */
  position: number
  /** The whole list's record count; null = unknown (only the rows shown are counted). */
  listTotal: number | null
  /** listTotal is an estimate ("about 49"). */
  approx: boolean
  /** The list goes on past the last row shown (a later page): Next stops here. */
  moreAfter: boolean
  /** The list starts before the first row shown (an earlier page): Previous stops here. */
  moreBefore: boolean
}

/** Where `at` sits in the stashed list: its position, the list's total and its neighbours. */
export function listNeighbors(stash: ListReturnStash | null, at: ListRef): ListNeighbors | null {
  if (!stash) return null
  const i = stash.rows.findIndex((r) => sameRef(r, at))
  if (i < 0) return null
  const shown = stash.rows.length
  const offset =
    typeof stash.offset === 'number' && Number.isFinite(stash.offset) && stash.offset > 0
      ? Math.floor(stash.offset)
      : 0
  const known = typeof stash.total === 'number' && Number.isFinite(stash.total)
  // A total smaller than what the list showed is stale (rows added since the count): never
  // print "30 of 25".
  const listTotal = known ? Math.max(Number(stash.total), offset + shown) : null
  return {
    index: i + 1,
    total: shown,
    prev: i > 0 ? stash.rows[i - 1] : null,
    next: i < shown - 1 ? stash.rows[i + 1] : null,
    position: offset + i + 1,
    listTotal,
    approx: listTotal != null && !!stash.totalApprox,
    moreAfter: listTotal != null && offset + shown < listTotal,
    moreBefore: offset > 0
  }
}

/**
 * The stash this record page belongs to, or null: the record must be the one the list opened
 * (or walked to with Previous / Next), on the history entry it was opened on — the same
 * record reached later from a search is not "in the list" any more.
 */
export function listReturnFor(at: ListRef, stash = readListReturn()): ListReturnStash | null {
  if (!stash || !sameRef(stash.current, at)) return null
  const idx = historyIdx()
  if (stash.idx != null && idx != null && stash.idx !== idx) return null
  return listNeighbors(stash, at) ? stash : null
}

/** Previous / Next moved to `to`: keep the stash in step (same history entry, see the nav). */
export function stepListReturn(to: ListRef): void {
  const s = readListReturn()
  if (!s) return
  writeStash({ ...s, current: { collection: to.collection, id: String(to.id) }, at: Date.now() })
}

/**
 * The row to highlight when the list `list` shows again: the record the person was last on,
 * when they opened it from this list. Read once per arrival; null = nothing to mark.
 */
export function returnRowFor(list: string, stash = readListReturn()): ListRef | null {
  if (!stash || stash.list !== list) return null
  return stash.current
}

/**
 * The brief, quiet mark on the row the person comes back to: a thin accent edge and a faint
 * tint that fade out (reduced motion: the tint just shows for a moment, nothing moves).
 * Rows are found by `data-row-key` (the list's own row key) inside `root`.
 */
export function markReturnRow(root: ParentNode | null | undefined, key: string): boolean {
  if (!root || typeof window === 'undefined' || !key) return false
  const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key.replace(/"/g, '\\"')
  const row = root.querySelector(`[data-row-key="${esc}"]`) as HTMLElement | null
  if (!row) return false
  row.setAttribute('data-return-row', '')
  let reduced = false
  try {
    reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  } catch {
    reduced = false
  }
  const cells = Array.from(row.children) as HTMLElement[]
  if (reduced || cells.some((c) => typeof c.animate !== 'function')) {
    setTimeout(() => row.removeAttribute('data-return-row'), 1800)
    return true
  }
  // The tint is an inset shadow painted OVER each cell's own (opaque) background, so pinned
  // sticky cells stay opaque. A step stronger on light surfaces, where 10% all but vanished
  // on a bright screen (rt-nav review); dark keeps 10%, which already reads.
  const dark =
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  const wash = `rgba(0, 206, 255, ${dark ? 0.1 : 0.16})`
  cells.forEach((cell, i) => {
    const edge = i === 0 ? 'inset 3px 0 0 0 rgba(0, 206, 255, 0.85), ' : ''
    cell.animate(
      [
        { boxShadow: `${edge}inset 0 0 0 9999px ${wash}` },
        { boxShadow: `${edge}inset 0 0 0 9999px ${wash}`, offset: 0.55 },
        {
          boxShadow: `${i === 0 ? 'inset 3px 0 0 0 rgba(0, 206, 255, 0), ' : ''}inset 0 0 0 9999px rgba(0, 206, 255, 0)`
        }
      ],
      { duration: 2400, easing: 'ease-out' }
    )
  })
  setTimeout(() => row.removeAttribute('data-return-row'), 2400)
  return true
}

/** Whether `el` is (at least partly) inside `scroller`'s visible box. */
export function rowInView(el: Element, scroller: Element | null): boolean {
  const r = el.getBoundingClientRect()
  const box = scroller
    ? scroller.getBoundingClientRect()
    : { top: 0, bottom: typeof window !== 'undefined' ? window.innerHeight : 0 }
  return r.bottom > box.top + 4 && r.top < box.bottom - 4
}

// ─── 2. What changed while away ─────────────────────────────────────────────

/** One live event recorded while the list was away (ids + field names only). */
export interface AwayEvent extends CollectionUpdateEvent {
  /** The viewer's own write (their save on the record page). */
  own: boolean
}

export interface AwayLog {
  events: AwayEvent[]
  /** True when every change while away is in `events` (no drop, overflow or expiry). */
  complete: boolean
  /** Why the log is incomplete, for diagnostics. */
  reason?: 'overflow' | 'reconnect' | 'stale' | 'expired' | 'bulk'
  leftAt: number
  awayMs: number
}

/** Events kept at most before the log gives up and the list re-reads. */
export const AWAY_MAX_EVENTS = 300
/** How long an away list keeps listening; past it the return re-reads. */
export const AWAY_MAX_MS = 15 * 60 * 1000
/** Distinct records a return re-reads one by one at most; more = one page read. */
export const RETURN_MAX_ROWS = 40

interface Watch {
  key: string
  events: AwayEvent[]
  complete: boolean
  reason?: AwayLog['reason']
  away: boolean
  leftAt: number
  dropped: boolean
  stop: () => void
  timer: ReturnType<typeof setTimeout> | null
}

const watches = new Map<string, Watch>()

/** Expand a coalesced burst (#1681) into per-record events (mirrors live.ts expandCoalesced). */
function expand(ev: CollectionUpdateEvent & Record<string, unknown>): CollectionUpdateEvent[] {
  if (!ev.coalesced) return [ev]
  const { coalesced: _c, items, many, count: _n, ...base } = ev
  if (many || !Array.isArray(items)) return [{ ...base, item: '*' } as CollectionUpdateEvent]
  return (items as unknown[]).map((item) => ({ ...base, item }) as CollectionUpdateEvent)
}

function markIncomplete(w: Watch, reason: NonNullable<AwayLog['reason']>) {
  if (!w.complete) return
  w.complete = false
  w.reason = reason
  w.events = []
}

/**
 * Called when a list mounts: holds a second, quiet subscription to `collections` that starts
 * recording only once the list leaves. Returns `leave` — call it when the list unmounts.
 * Calling `standbyListAway` again for the same key (the list came back) replaces the old one.
 */
export function standbyListAway(
  realtime: RealtimeAdapter | null | undefined,
  key: string,
  collections: string[]
): () => void {
  const names = [...new Set(collections.filter(Boolean))]
  if (!realtime || !key || names.length === 0) return () => {}
  const w: Watch = {
    key,
    events: [],
    complete: true,
    away: false,
    leftAt: 0,
    dropped: false,
    stop: () => {},
    timer: null
  }
  const onEvent = (raw: CollectionUpdateEvent) => {
    if (!w.away || !w.complete) return
    for (const ev of expand(raw as CollectionUpdateEvent & Record<string, unknown>)) {
      if (!ev || !names.includes(String(ev.collection))) continue
      if (String(ev.item) === '*') {
        markIncomplete(w, 'bulk')
        return
      }
      if (w.events.length >= AWAY_MAX_EVENTS) {
        markIncomplete(w, 'overflow')
        return
      }
      const fields = Array.isArray(ev.changed_fields) ? ev.changed_fields : null
      w.events.push({
        collection: String(ev.collection),
        item: String(ev.item),
        ...(ev.action ? { action: ev.action } : {}),
        ...(fields ? { changed_fields: [...fields] } : {}),
        own: isOwnWrite(String(ev.collection), String(ev.item), fields)
      })
    }
  }
  const unsub = realtime.subscribeCollections(names, onEvent)
  const offStatus = realtime.onStatus
    ? realtime.onStatus((s: RealtimeStatus) => {
        if (!w.away) return
        if (s.state === 'reconnecting') w.dropped = true
        else if (w.dropped) {
          w.dropped = false
          // The reconnect replayed every missed event into the same listeners: still whole.
          if (s.resumed !== 'replayed') markIncomplete(w, 'reconnect')
        }
      })
    : () => {}
  const onStale = () => {
    if (w.away) markIncomplete(w, 'stale')
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('nvr:catchup-full', onStale)
    window.addEventListener('nvr:realtime-stale', onStale)
  }
  w.stop = () => {
    unsub()
    offStatus()
    if (typeof window !== 'undefined') {
      window.removeEventListener('nvr:catchup-full', onStale)
      window.removeEventListener('nvr:realtime-stale', onStale)
    }
    if (w.timer) clearTimeout(w.timer)
    w.timer = null
  }
  return () => {
    // Another mount of the same list took over meanwhile: this one just stops.
    const other = watches.get(key)
    if (other && other !== w) other.stop()
    w.away = true
    w.leftAt = Date.now()
    w.timer = setTimeout(() => {
      w.stop()
      markIncomplete(w, 'expired')
    }, AWAY_MAX_MS)
    watches.set(key, w)
  }
}

function logOf(w: Watch, now: number): AwayLog {
  const expired = now - w.leftAt > AWAY_MAX_MS
  return {
    events: w.complete && !expired ? [...w.events] : [],
    complete: w.complete && !expired,
    ...(w.reason ? { reason: w.reason } : expired ? { reason: 'expired' as const } : {}),
    leftAt: w.leftAt,
    awayMs: Math.max(0, now - w.leftAt)
  }
}

/** What the list's away log says so far, without ending it (null = the list was not away). */
export function peekListAway(key: string, now = Date.now()): AwayLog | null {
  const w = watches.get(key)
  return w?.away ? logOf(w, now) : null
}

/** End the away log for `key` and hand it over (null = the list was not away). */
export function takeListAway(key: string, now = Date.now()): AwayLog | null {
  const w = watches.get(key)
  if (!w?.away) return null
  watches.delete(key)
  w.stop()
  return logOf(w, now)
}

/** Test seam. */
export function resetListAwayForTests(): void {
  for (const w of watches.values()) w.stop()
  watches.clear()
}

/**
 * What a list does on coming back:
 * - `fresh`: it was not away (a first visit) — behave as always.
 * - `keep`: nothing changed while away — show the cached rows, read nothing.
 * - `replay`: these few records changed — keep the cached rows and re-read only them.
 * - `refetch`: the log cannot vouch for the cache — keep it on screen, read the page once.
 */
export type ReturnPlan = 'fresh' | 'keep' | 'replay' | 'refetch'

export function planListReturn(log: AwayLog | null, opts: { maxRows?: number } = {}): ReturnPlan {
  if (!log) return 'fresh'
  if (!log.complete) return 'refetch'
  if (log.events.length === 0) return 'keep'
  const ids = new Set(log.events.map((e) => `${e.collection}\u0001${String(e.item)}`))
  return ids.size <= (opts.maxRows ?? RETURN_MAX_ROWS) ? 'replay' : 'refetch'
}

/**
 * Of a cached page and the page a return re-read, the rows whose content differs (by id,
 * shallow compare of every value), for a quiet flash on those rows only.
 */
export function changedRowIds(
  before: Array<Record<string, unknown>> | null | undefined,
  after: Array<Record<string, unknown>> | null | undefined,
  idOf: (row: Record<string, unknown>) => string = (r) => String(r.id)
): string[] {
  if (!before || !after) return []
  const old = new Map(before.map((r) => [idOf(r), r]))
  const out: string[] = []
  for (const row of after) {
    const id = idOf(row)
    const prev = old.get(id)
    if (!prev) continue
    const keys = new Set([...Object.keys(prev), ...Object.keys(row)])
    for (const k of keys) {
      const a = prev[k]
      const b = row[k]
      if (a === b) continue
      if (
        a &&
        b &&
        typeof a === 'object' &&
        typeof b === 'object' &&
        JSON.stringify(a) === JSON.stringify(b)
      )
        continue
      out.push(id)
      break
    }
  }
  return out
}
