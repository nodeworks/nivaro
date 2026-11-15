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
 * Round 2 (rt6):
 *   settings {desktop, auto_add, auto_remove, digest}   the person's own switches (all off)
 *   alerts   [{id, c, rid, kind, step|field, label, repeat, at, fired?, due?}]  alert rules on
 *            pinned records (services/watch-list/alerts.ts)
 *   pins[].auto            added by "records that land on my step" (removable automatically)
 *   teams    [{id, name, owner, members, pins, at}]    shared lists this person OWNS (the list
 *            lives on its owner's row; members hold `team_refs` — services/watch-list/teams.ts)
 *   team_refs [id]         shared lists this person was added to
 *   team_seen {"<team>|c:id": iso}  what they have seen on a shared list's records
 *   digest_sent_on         YYYY-MM-DD of the last daily email (one per day)
 *
 * A saved list also carries plain flags (`wl_alerts`, `wl_auto`, `wl_digest`) so the few
 * background passes find the people who turned something on with one LIKE read.
 *
 * Pure functions here; routes/watch-list.ts reads and writes the row.
 */

export const WATCH_PINS_MAX = 50
export const DOCK_WIDTH_MIN = 280
export const DOCK_WIDTH_MAX = 480
export const DOCK_WIDTH_DEFAULT = 320

export const WATCH_ALERTS_MAX = 100
export const WATCH_ALERTS_PER_RECORD = 6
export const TEAM_LISTS_OWNED_MAX = 10
export const TEAM_REFS_MAX = 20
export const TEAM_MEMBERS_MAX = 40
export const TEAM_SEEN_MAX = 400

export type DockState = 'open' | 'minimized' | 'closed'
/** A shared list's tab is `team:<list id>`. */
export type DockTab = 'watching' | 'waiting' | 'mentions' | `team:${string}`
export type DockSort = 'mine' | 'changed' | 'due'

export interface WatchPin {
  c: string
  id: string
  at: string
  /** Added automatically when the record landed on the person's step. */
  auto?: boolean
}

export interface WatchSettings {
  /** Desktop (OS) notifications for watched records — the browser asks permission. */
  desktop: boolean
  /** Records that land on a step the person owns are pinned for them. */
  auto_add: boolean
  /** …and an automatically added pin goes when the record leaves their step. */
  auto_remove: boolean
  /** One email a day of what changed on their pinned records (empty days: none). */
  digest: boolean
}

export type AlertKind = 'step' | 'field' | 'overdue'

export interface WatchAlert {
  id: string
  /** The record: collection + id. */
  c: string
  rid: string
  kind: AlertKind
  /** step: the state key; field: the field name. */
  step?: string
  field?: string
  /** What the person picked, in words (step label / field label) — for lists and messages. */
  label?: string
  /** true = every time; false = once, then the rule goes. */
  repeat: boolean
  at: string
  /** When it last fired (repeat rules). */
  fired?: string
  /** overdue: the due time that already fired (one alert per breach). */
  due?: string
}

export interface TeamMember {
  u: string
  /** When they were added (changes before this are not "new" to them). */
  at: string
}

export interface TeamPin {
  c: string
  id: string
  at: string
  /** Who added it. */
  by: string
}

export interface TeamList {
  id: string
  name: string
  owner: string
  members: TeamMember[]
  pins: TeamPin[]
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
  settings: WatchSettings
  alerts: WatchAlert[]
  teams: TeamList[]
  team_refs: string[]
  team_seen: Record<string, string>
  digest_sent_on: string | null
}

const COLLECTION = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const ID = /^[A-Za-z0-9_.:-]{1,64}$/
const USER_ID = /^[A-Za-z0-9-]{1,40}$/
/** A shared list's id: its owner's user id, a tilde, a short random part. */
export const TEAM_ID = /^[A-Za-z0-9-]{1,40}~[a-z0-9]{4,12}$/
const ALERT_ID = /^[a-z0-9]{4,16}$/
const STATE_KEY = /^[A-Za-z0-9_.:-]{1,80}$/
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const STATES: DockState[] = ['open', 'minimized', 'closed']
const TABS: string[] = ['watching', 'waiting', 'mentions']
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
    tab:
      typeof o.tab === 'string' &&
      (TABS.includes(o.tab) || (o.tab.startsWith('team:') && TEAM_ID.test(o.tab.slice(5))))
        ? (o.tab as DockTab)
        : base.tab,
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
    pins.push({
      c: String(r.c),
      id: String(r.id),
      at: iso(r.at) ?? new Date(0).toISOString(),
      ...(r.auto === true ? { auto: true } : {})
    })
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
    replies_seen_at: iso(o.replies_seen_at),
    settings: normalizeSettings(o.settings),
    alerts: normalizeAlerts(o.alerts, keys),
    teams: (Array.isArray(o.teams) ? o.teams : [])
      .map((t) => normalizeTeam(t))
      .filter((t): t is TeamList => !!t)
      .slice(0, TEAM_LISTS_OWNED_MAX),
    team_refs: [
      ...new Set(
        (Array.isArray(o.team_refs) ? o.team_refs : []).filter(
          (r): r is string => typeof r === 'string' && TEAM_ID.test(r)
        )
      )
    ].slice(0, TEAM_REFS_MAX),
    team_seen: normalizeTeamSeen(o.team_seen),
    digest_sent_on:
      typeof o.digest_sent_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.digest_sent_on)
        ? o.digest_sent_on
        : null
  }
}

export const DEFAULT_SETTINGS: WatchSettings = {
  desktop: false,
  auto_add: false,
  auto_remove: false,
  digest: false
}

export function normalizeSettings(
  raw: unknown,
  base: WatchSettings = DEFAULT_SETTINGS
): WatchSettings {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const pick = (k: keyof WatchSettings) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : base[k])
  return {
    desktop: pick('desktop'),
    auto_add: pick('auto_add'),
    auto_remove: pick('auto_remove'),
    digest: pick('digest')
  }
}

/** One stored or requested rule → a valid rule, or null. */
export function normalizeAlert(raw: unknown): WatchAlert | null {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  if (!r) return null
  const kind = r.kind
  if (kind !== 'step' && kind !== 'field' && kind !== 'overdue') return null
  if (!pinnable(r.c, r.rid)) return null
  if (typeof r.id !== 'string' || !ALERT_ID.test(r.id)) return null
  const out: WatchAlert = {
    id: r.id,
    c: String(r.c),
    rid: String(r.rid),
    kind,
    repeat: r.repeat === true,
    at: iso(r.at) ?? new Date(0).toISOString()
  }
  if (kind === 'step') {
    if (typeof r.step !== 'string' || !STATE_KEY.test(r.step)) return null
    out.step = r.step
  }
  if (kind === 'field') {
    if (typeof r.field !== 'string' || !FIELD.test(r.field)) return null
    out.field = r.field
  }
  if (typeof r.label === 'string' && r.label.trim()) out.label = r.label.trim().slice(0, 120)
  const fired = iso(r.fired)
  if (fired) out.fired = fired
  const due = iso(r.due)
  if (due) out.due = due
  return out
}

/** Stored rules, kept only for records still pinned (`pinKeys`), capped. */
export function normalizeAlerts(raw: unknown, pinKeys: Set<string>): WatchAlert[] {
  const out: WatchAlert[] = []
  const ids = new Set<string>()
  for (const a of Array.isArray(raw) ? raw : []) {
    const n = normalizeAlert(a)
    if (!n || ids.has(n.id) || !pinKeys.has(pinKey(n.c, n.rid))) continue
    ids.add(n.id)
    out.push(n)
    if (out.length >= WATCH_ALERTS_MAX) break
  }
  return out
}

export function normalizeTeam(raw: unknown): TeamList | null {
  const t = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  if (!t || typeof t.id !== 'string' || !TEAM_ID.test(t.id)) return null
  if (typeof t.owner !== 'string' || !USER_ID.test(t.owner)) return null
  const name = typeof t.name === 'string' ? t.name.trim().slice(0, 60) : ''
  if (!name) return null
  const members: TeamMember[] = []
  const seenMembers = new Set<string>()
  for (const m of Array.isArray(t.members) ? t.members : []) {
    const r = m && typeof m === 'object' ? (m as Record<string, unknown>) : {}
    if (typeof r.u !== 'string' || !USER_ID.test(r.u)) continue
    const k = r.u.toLowerCase()
    if (seenMembers.has(k)) continue
    seenMembers.add(k)
    members.push({ u: r.u, at: iso(r.at) ?? new Date(0).toISOString() })
    if (members.length >= TEAM_MEMBERS_MAX) break
  }
  const pins: TeamPin[] = []
  const pinKeys = new Set<string>()
  for (const p of Array.isArray(t.pins) ? t.pins : []) {
    const r = p && typeof p === 'object' ? (p as Record<string, unknown>) : {}
    if (!pinnable(r.c, r.id)) continue
    const k = pinKey(String(r.c), String(r.id))
    if (pinKeys.has(k)) continue
    pinKeys.add(k)
    pins.push({
      c: String(r.c),
      id: String(r.id),
      at: iso(r.at) ?? new Date(0).toISOString(),
      by: typeof r.by === 'string' && USER_ID.test(r.by) ? r.by : t.owner
    })
    if (pins.length >= WATCH_PINS_MAX) break
  }
  return {
    id: t.id,
    name,
    owner: t.owner,
    members,
    pins,
    at: iso(t.at) ?? new Date(0).toISOString()
  }
}

/** "<team id>|<collection>:<id>" → iso, newest kept when over the cap. */
export function normalizeTeamSeen(raw: unknown): Record<string, string> {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const entries: Array<[string, string]> = []
  for (const [k, v] of Object.entries(o)) {
    const bar = k.indexOf('|')
    if (bar < 0 || !TEAM_ID.test(k.slice(0, bar))) continue
    const at = iso(v)
    if (at) entries.push([k, at])
  }
  entries.sort((a, z) => (a[1] < z[1] ? 1 : a[1] > z[1] ? -1 : 0))
  return Object.fromEntries(entries.slice(0, TEAM_SEEN_MAX))
}

/** The stored shape: the list plus the flags the background passes look for. */
export function serializeWatchList(list: WatchListPrefs): Record<string, unknown> {
  const out: Record<string, unknown> = { ...list }
  if (list.alerts.length > 0) out.wl_alerts = true
  if (list.settings.auto_add || list.settings.auto_remove) out.wl_auto = true
  if (list.settings.digest && list.pins.length > 0) out.wl_digest = true
  return out
}

/** A short random id for a rule or a shared list. */
export function shortId(n = 8): string {
  let s = ''
  while (s.length < n) s += Math.random().toString(36).slice(2)
  return s.slice(0, n)
}

export type PinResult =
  | { ok: true; list: WatchListPrefs; changed: boolean }
  | { ok: false; code: 'WATCH_LIST_FULL' | 'NOT_PINNABLE'; message: string }

/** Pin a record (to the top of "My order"); already pinned = unchanged. */
export function addPin(
  list: WatchListPrefs,
  collection: string,
  id: string,
  now: Date = new Date(),
  opts: { auto?: boolean } = {}
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
      pins: [{ c: collection, id, at, ...(opts.auto ? { auto: true } : {}) }, ...list.pins],
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
  // A record no longer watched takes its alert rules with it.
  const alerts = list.alerts.filter((a) => pinKey(a.c, a.rid) !== k)
  return { list: { ...list, pins, seen, alerts }, changed: true }
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
