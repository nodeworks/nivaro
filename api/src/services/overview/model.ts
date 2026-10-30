/**
 * The Overview page's pure rules (route `/` in the admin): the windows its figures compare, the
 * hour buckets behind the activity bars, the per-person preference shape and the role starter
 * layouts. No I/O here — services/overview/stats.ts and prefs.ts do the reads.
 */

export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

/** Activity actions that mean "a record changed" (never reads, logins or config housekeeping). */
export const RECORD_CHANGE_ACTIONS = [
  'create',
  'update',
  'delete',
  'transition',
  'pipeline-transition',
  'pipeline-start',
  'restore',
  'revert'
] as const

/** System tables are never "records" on the Overview. */
export function isSystemCollection(c: string | null | undefined): boolean {
  return !c || /^(nivaro_|directus_)/.test(c)
}

/**
 * The start of the viewer's day, as their browser sent it (local midnight as an ISO instant).
 * Anything unreadable, in the future or more than 36 hours back is replaced by UTC midnight —
 * the figure is still a day, just the server's.
 */
export function parseDayStart(raw: unknown, now: Date): Date {
  if (typeof raw === 'string' && raw.trim()) {
    const d = new Date(raw.trim())
    const t = d.getTime()
    if (Number.isFinite(t) && t <= now.getTime() && now.getTime() - t <= 36 * HOUR_MS) return d
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

export interface Window {
  from: Date
  to: Date
}

/**
 * The windows every figure compares. "Today" runs from the viewer's midnight to now and is
 * compared with yesterday UP TO THE SAME TIME (a morning never reads as a collapse against a
 * whole day); job failures compare the last 24 hours with the 24 before.
 */
export function overviewWindows(dayStart: Date, now: Date) {
  const n = now.getTime()
  const d = dayStart.getTime()
  return {
    today: { from: new Date(d), to: new Date(n) },
    sameTimeYesterday: { from: new Date(d - DAY_MS), to: new Date(n - DAY_MS) },
    last24: { from: new Date(n - DAY_MS), to: new Date(n) },
    previous24: { from: new Date(n - 2 * DAY_MS), to: new Date(n - DAY_MS) },
    /** The one read that covers both "today" windows and the 24 bars. */
    span: { from: new Date(Math.min(d - DAY_MS, n - DAY_MS)), to: new Date(n) }
  }
}

export const inWindow = (t: number, w: Window) => t >= w.from.getTime() && t <= w.to.getTime()

/**
 * Changes per hour for the `hours` hours ending now, oldest first: bucket i covers
 * [now - (hours - i) h, now - (hours - i - 1) h). Times outside are ignored.
 */
export function hourlyBuckets(
  times: Array<Date | string | number>,
  now: Date,
  hours = 24
): number[] {
  const out = new Array<number>(hours).fill(0)
  const end = now.getTime()
  const start = end - hours * HOUR_MS
  for (const raw of times) {
    const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime()
    if (!Number.isFinite(t) || t < start || t > end) continue
    const i = Math.min(hours - 1, Math.floor((t - start) / HOUR_MS))
    out[i]++
  }
  return out
}

/** Hour offsets from `start` (SQL DATEDIFF answers) → the same oldest-first buckets. */
export function bucketsFromOffsets(
  rows: Array<{ h: number | string | null; n: number | string | null }>,
  hours = 24
): number[] {
  const out = new Array<number>(hours).fill(0)
  for (const r of rows) {
    if (r.h == null || r.h === '') continue
    const h = Number(r.h)
    if (!Number.isInteger(h) || h < 0 || h >= hours) continue
    out[h] += Number(r.n) || 0
  }
  return out
}

/** Distinct records (collection + item) among rows inside a window. */
export function distinctRecords(
  rows: Array<{ collection: string | null; item: string | null; timestamp: Date | string }>,
  w: Window
): number {
  const seen = new Set<string>()
  for (const r of rows) {
    if (!r.collection || r.item == null) continue
    const t = new Date(r.timestamp).getTime()
    if (!inWindow(t, w)) continue
    seen.add(`${r.collection}\u0000${r.item}`)
  }
  return seen.size
}

/**
 * Open issues 24 hours ago, from what is known now: today's open count, minus the open ones
 * raised in the last 24 h, plus the ones closed in the last 24 h that were raised before it.
 */
export function openIssuesBefore(open: number, openedLast24: number, closedLast24: number): number {
  return Math.max(0, open - openedLast24 + closedLast24)
}

export type FigureKey = 'records_changed' | 'people_active' | 'failed_jobs' | 'open_issues'

export interface OverviewFigure {
  key: FigureKey
  value: number
  /** The comparable figure (null = no comparison could be made). */
  previous: number | null
  /** What `previous` is: 'yesterday' (same time) or 'previous_24h'. */
  compare: 'yesterday' | 'previous_24h'
  /** The read hit its row cap: `value` is a floor. */
  capped?: boolean
}

// ─── Per-person preferences (nivaro_users.preferences.overview) ──────────────

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/
const MAX_SECTIONS = 40
const MAX_ACTIONS = 12
const MAX_WIDGETS = 8

export interface OverviewLayout {
  order: string[]
  hidden: string[]
  shown: string[]
}

export interface PinnedAction {
  path: string
  label: string
}

export interface OverviewPrefs {
  layout: OverviewLayout | null
  pinned_actions: PinnedAction[]
  /** Hidden suggestions: paths the person un-pinned from the suggested row. */
  dismissed_actions: string[]
  pinned_widgets: string[]
  last_visit_at: string | null
  prev_visit_at: string | null
  last_visit_version: string | null
  prev_visit_version: string | null
}

export const EMPTY_PREFS: OverviewPrefs = {
  layout: null,
  pinned_actions: [],
  dismissed_actions: [],
  pinned_widgets: [],
  last_visit_at: null,
  prev_visit_at: null,
  last_visit_version: null,
  prev_visit_version: null
}

function keyList(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) {
    const k = typeof v === 'string' ? v.trim() : ''
    if (KEY_RE.test(k) && !out.includes(k)) out.push(k)
    if (out.length >= max) break
  }
  return out
}

/** A section layout, or null when the input is not one. Keys are not checked against a list. */
export function normalizeLayout(raw: unknown): OverviewLayout | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const src = raw as Record<string, unknown>
  const order = keyList(src.order, MAX_SECTIONS)
  const hidden = keyList(src.hidden, MAX_SECTIONS)
  const shown = keyList(src.shown, MAX_SECTIONS).filter((k) => !hidden.includes(k))
  return { order, hidden, shown }
}

/** An in-app absolute route only — never an external or javascript: target. */
export function isAppPath(p: unknown): p is string {
  return typeof p === 'string' && /^\/(?!\/)[A-Za-z0-9/_\-.?=&%:~]*$/.test(p) && p.length <= 300
}

export function normalizePinnedActions(raw: unknown): PinnedAction[] {
  if (!Array.isArray(raw)) return []
  const out: PinnedAction[] = []
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue
    const path = String((v as { path?: unknown }).path ?? '').trim()
    const label = String((v as { label?: unknown }).label ?? '')
      .trim()
      .slice(0, 60)
    if (!isAppPath(path) || !label || out.some((a) => a.path === path)) continue
    out.push({ path, label })
    if (out.length >= MAX_ACTIONS) break
  }
  return out
}

function pathList(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) {
    if (isAppPath(v) && !out.includes(v)) out.push(v)
    if (out.length >= max) break
  }
  return out
}

const WIDGET_ID = /^[A-Za-z0-9-]{1,64}$/

export function normalizePinnedWidgets(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) {
    const id = typeof v === 'string' || typeof v === 'number' ? String(v) : ''
    if (WIDGET_ID.test(id) && !out.includes(id)) out.push(id)
    if (out.length >= MAX_WIDGETS) break
  }
  return out
}

const isoOrNull = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}
const versionOrNull = (v: unknown): string | null =>
  typeof v === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(v) ? v : null

/** Stored JSON → preferences (anything unreadable falls back to empty). */
export function normalizePrefs(raw: unknown): OverviewPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY_PREFS }
  const src = raw as Record<string, unknown>
  return {
    layout: normalizeLayout(src.layout),
    pinned_actions: normalizePinnedActions(src.pinned_actions),
    dismissed_actions: pathList(src.dismissed_actions, 30),
    pinned_widgets: normalizePinnedWidgets(src.pinned_widgets),
    last_visit_at: isoOrNull(src.last_visit_at),
    prev_visit_at: isoOrNull(src.prev_visit_at),
    last_visit_version: versionOrNull(src.last_visit_version),
    prev_visit_version: versionOrNull(src.prev_visit_version)
  }
}

/** A visit inside this long after the last one is the same sitting: the baseline stays. */
export const VISIT_GRACE_MS = 30 * 60_000

/**
 * Roll the last-visit watermark. The "since your last visit" baseline is the visit BEFORE this
 * sitting: a reload inside the grace window keeps it, a return after it moves it forward.
 */
export function rollVisit(prefs: OverviewPrefs, now: Date, version: string | null): OverviewPrefs {
  const last = prefs.last_visit_at ? new Date(prefs.last_visit_at).getTime() : null
  const sameSitting = last != null && now.getTime() - last < VISIT_GRACE_MS
  if (sameSitting) {
    return {
      ...prefs,
      last_visit_at: now.toISOString(),
      last_visit_version: version ?? prefs.last_visit_version
    }
  }
  return {
    ...prefs,
    prev_visit_at: prefs.last_visit_at,
    prev_visit_version: prefs.last_visit_version,
    last_visit_at: now.toISOString(),
    last_visit_version: version ?? prefs.last_visit_version
  }
}

const ROLE_ID = /^[0-9A-Fa-f-]{36}$/

/** `{ <role uuid>: layout }` — invalid entries dropped; at most 200 roles. */
export function normalizeRoleDefaults(raw: unknown): Record<string, OverviewLayout> {
  let src: unknown = raw
  if (typeof raw === 'string') {
    try {
      src = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (!src || typeof src !== 'object' || Array.isArray(src)) return {}
  const out: Record<string, OverviewLayout> = {}
  for (const [role, layout] of Object.entries(src as Record<string, unknown>).slice(0, 200)) {
    if (!ROLE_ID.test(role)) continue
    const l = normalizeLayout(layout)
    if (l) out[role.toUpperCase()] = l
  }
  return out
}
