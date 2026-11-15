/**
 * The watch list (rt5 #1 / #2): records a person pinned to follow from every page, plus how they
 * left the dock. Everything lives in ONE key of the person's own preferences JSON
 * (`nivaro_users.preferences.watch_list`) — no table, no migration — so it follows them across
 * tabs and devices (a save announces `prefs:changed {keys:['watch_list']}`).
 *
 *   pins   [{c, id, at}]   collection, record id, when pinned (ISO); array order = "My order"
 *   seen   {"c:id": iso}    the newest change the person has seen on that pin
 *   dock   {state, width, tab, sort}
 *   replies_seen_at        newest reply the person has seen (Mentions & replies tab)
 *
 * Pure functions here; routes/watch-list.ts reads and writes the row.
 */

export const WATCH_PINS_MAX = 50
export const DOCK_WIDTH_MIN = 280
export const DOCK_WIDTH_MAX = 480
export const DOCK_WIDTH_DEFAULT = 320

export type DockState = 'open' | 'minimized' | 'closed'
export type DockTab = 'watching' | 'waiting' | 'mentions'
export type DockSort = 'mine' | 'changed' | 'due'

export interface WatchPin {
  c: string
  id: string
  at: string
}

export interface WatchDock {
  state: DockState
  width: number
  tab: DockTab
  sort: DockSort
}

export interface WatchListPrefs {
  pins: WatchPin[]
  seen: Record<string, string>
  dock: WatchDock
  replies_seen_at: string | null
}

const COLLECTION = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const ID = /^[A-Za-z0-9_.:-]{1,64}$/
const STATES: DockState[] = ['open', 'minimized', 'closed']
const TABS: DockTab[] = ['watching', 'waiting', 'mentions']
const SORTS: DockSort[] = ['mine', 'changed', 'due']

export const pinKey = (c: string, id: string | number): string => `${c}:${id}`

/** A record the watch list may hold: business collections only, a plain id. */
export function pinnable(collection: unknown, id: unknown): boolean {
  return (
    typeof collection === 'string' &&
    COLLECTION.test(collection) &&
    !/^(nivaro_|directus_)/i.test(collection) &&
    (typeof id === 'string' || typeof id === 'number') &&
    ID.test(String(id))
  )
}

function iso(v: unknown): string | null {
  if (typeof v !== 'string' && !(v instanceof Date)) return null
  const t = new Date(v as string).getTime()
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

export const DEFAULT_DOCK: WatchDock = {
  state: 'open',
  width: DOCK_WIDTH_DEFAULT,
  tab: 'watching',
  sort: 'mine'
}

export function normalizeDock(raw: unknown, base: WatchDock = DEFAULT_DOCK): WatchDock {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const width = Number(o.width)
  return {
    state: STATES.includes(o.state as DockState) ? (o.state as DockState) : base.state,
    width: Number.isFinite(width)
      ? Math.round(Math.min(DOCK_WIDTH_MAX, Math.max(DOCK_WIDTH_MIN, width)))
      : base.width,
    tab: TABS.includes(o.tab as DockTab) ? (o.tab as DockTab) : base.tab,
    sort: SORTS.includes(o.sort as DockSort) ? (o.sort as DockSort) : base.sort
  }
}

/** Read whatever is stored (any shape, any age) as a valid watch list. */
export function normalizeWatchList(raw: unknown): WatchListPrefs {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const pins: WatchPin[] = []
  const keys = new Set<string>()
  for (const p of Array.isArray(o.pins) ? o.pins : []) {
    const r = p && typeof p === 'object' ? (p as Record<string, unknown>) : {}
    if (!pinnable(r.c, r.id)) continue
    const k = pinKey(String(r.c), String(r.id))
    if (keys.has(k)) continue
    keys.add(k)
    pins.push({ c: String(r.c), id: String(r.id), at: iso(r.at) ?? new Date(0).toISOString() })
    if (pins.length >= WATCH_PINS_MAX) break
  }
  const seen: Record<string, string> = {}
  const rawSeen = o.seen && typeof o.seen === 'object' ? (o.seen as Record<string, unknown>) : {}
  for (const k of keys) {
    const at = iso(rawSeen[k])
    if (at) seen[k] = at
  }
  return {
    pins,
    seen,
    dock: normalizeDock(o.dock),
    replies_seen_at: iso(o.replies_seen_at)
  }
}

export type PinResult =
  | { ok: true; list: WatchListPrefs; changed: boolean }
  | { ok: false; code: 'WATCH_LIST_FULL' | 'NOT_PINNABLE'; message: string }

/** Pin a record (to the top of "My order"); already pinned = unchanged. */
export function addPin(
  list: WatchListPrefs,
  collection: string,
  id: string,
  now: Date = new Date()
): PinResult {
  if (!pinnable(collection, id))
    return { ok: false, code: 'NOT_PINNABLE', message: 'This record cannot be watched' }
  const k = pinKey(collection, id)
  if (list.pins.some((p) => pinKey(p.c, p.id) === k)) return { ok: true, list, changed: false }
  if (list.pins.length >= WATCH_PINS_MAX)
    return {
      ok: false,
      code: 'WATCH_LIST_FULL',
      message: `Your watch list holds ${WATCH_PINS_MAX} records. Unpin one to add another.`
    }
  const at = now.toISOString()
  return {
    ok: true,
    changed: true,
    // Pinning counts as having seen it as it is now: no "changed" mark for history.
    list: {
      ...list,
      pins: [{ c: collection, id, at }, ...list.pins],
      seen: { ...list.seen, [k]: at }
    }
  }
}

export function removePin(
  list: WatchListPrefs,
  collection: string,
  id: string
): { list: WatchListPrefs; changed: boolean } {
  const k = pinKey(collection, id)
  const pins = list.pins.filter((p) => pinKey(p.c, p.id) !== k)
  if (pins.length === list.pins.length) return { list, changed: false }
  const seen = { ...list.seen }
  delete seen[k]
  return { list: { ...list, pins, seen }, changed: true }
}

/**
 * "My order": the keys given first, in that order, then any pin they did not name (a pin made
 * in another tab while this one was dragging is kept, not lost).
 */
export function reorderPins(list: WatchListPrefs, keys: unknown): WatchListPrefs {
  const order = Array.isArray(keys) ? keys.map(String) : []
  const byKey = new Map(list.pins.map((p) => [pinKey(p.c, p.id), p]))
  const out: WatchPin[] = []
  for (const k of order) {
    const p = byKey.get(k)
    if (!p) continue
    out.push(p)
    byKey.delete(k)
  }
  for (const p of list.pins) if (byKey.has(pinKey(p.c, p.id))) out.push(p)
  return { ...list, pins: out }
}

/** Mark pins seen up to `at` (never moves a marker backwards). No keys = every pin. */
export function markSeen(
  list: WatchListPrefs,
  keys: string[] | null,
  at: Date = new Date()
): { list: WatchListPrefs; changed: boolean } {
  const stamp = at.toISOString()
  const wanted = new Set(keys ?? list.pins.map((p) => pinKey(p.c, p.id)))
  const seen = { ...list.seen }
  let changed = false
  for (const p of list.pins) {
    const k = pinKey(p.c, p.id)
    if (!wanted.has(k)) continue
    if (!seen[k] || seen[k] < stamp) {
      seen[k] = stamp
      changed = true
    }
  }
  return { list: { ...list, seen }, changed }
}

/** When the person last saw this pin as it was (pinning counts). */
export function seenAt(list: WatchListPrefs, pin: WatchPin): string {
  const s = list.seen[pinKey(pin.c, pin.id)]
  return s && s > pin.at ? s : pin.at
}

/** Parse the stored preferences column (string or object) into an object. */
export function parsePreferences(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const v = JSON.parse(raw)
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
    } catch {
      return {}
    }
  }
  return {}
}
