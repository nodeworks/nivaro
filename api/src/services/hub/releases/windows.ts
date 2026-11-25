import { db } from '../../../db/index.js'
import type { FreezeRefusal, FrozenAction } from './freeze.js'
import {
  rangeWords,
  type Span,
  validateRanges,
  type WeeklyRange,
  weeklyNextSpan,
  weeklySpanAt,
  weeklySpans
} from './weekly.js'
import { isTimeZone } from './zoned.js'

/**
 * Deploy windows (Hub enhancement 27): the times an app MAY be promoted. They are the other half
 * of the ONE release-time rule engine (freeze.ts judges freezes first, then these, in
 * freezeRefusal), so every start that honours a freeze — a person's promotion, Apply now, a train
 * step, a scheduled promotion — honours the windows too, with the same wait / fail handling.
 *
 * Which windows govern an environment of an app:
 *   - the app's own enabled windows whose scope fits the environment (`production` windows only
 *     govern production — THE production rule, owner-access envPolicy — `all` windows govern
 *     every environment);
 *   - when the app has none that fit, the Hub-wide ones (app_id null) that fit;
 *   - none at all: the environment may be promoted at any time.
 * A one-off window that has ended governs nothing any more.
 * Governed: inside any span of them = allowed, else 409 OUTSIDE_WINDOW carrying the next opening
 * (`freeze.ends_at`, so a scheduled run waits until then). Rollbacks are never judged here (the
 * same exemption as a freeze: only one to an OLDER version); moves and shared-deployment upgrades
 * are not deploys of the app's version and stay with freezes and checklists.
 */

export const WINDOWS = 'nivaro_hub_deploy_windows'

export type WindowScope = 'all' | 'production'
export type WindowRecurrence = 'weekly' | 'none'

export interface DeployWindow {
  id: number
  app_id: number | null
  name: string
  env_scope: WindowScope
  recurrence: WindowRecurrence
  ranges: WeeklyRange[]
  starts_at: string | null
  ends_at: string | null
  time_zone: string
  enabled: boolean
}

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

export function windowFromRow(r: Record<string, unknown>): DeployWindow {
  let ranges: WeeklyRange[] = []
  try {
    const parsed = typeof r.ranges === 'string' ? JSON.parse(r.ranges) : r.ranges
    const v = validateRanges(parsed)
    if (Array.isArray(v)) ranges = v
  } catch {
    ranges = []
  }
  const tz = typeof r.time_zone === 'string' && isTimeZone(r.time_zone) ? r.time_zone : 'UTC'
  return {
    id: Number(r.id),
    app_id: r.app_id == null ? null : Number(r.app_id),
    name: String(r.name ?? ''),
    env_scope: r.env_scope === 'all' ? 'all' : 'production',
    recurrence: r.recurrence === 'none' ? 'none' : 'weekly',
    ranges,
    starts_at: iso(r.starts_at),
    ends_at: iso(r.ends_at),
    time_zone: tz,
    enabled: r.enabled == null ? true : truthy(r.enabled)
  }
}

/** The spans of one window overlapping [from, to). */
export function windowSpans(w: DeployWindow, from: number, to: number): Span[] {
  if (w.recurrence === 'none') {
    const s = w.starts_at ? Date.parse(w.starts_at) : Number.NaN
    const e = w.ends_at ? Date.parse(w.ends_at) : Number.NaN
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return []
    return e > from && s < to ? [{ start: s, end: e }] : []
  }
  return weeklySpans(w.ranges, w.time_zone, from, to)
}

function spanAt(w: DeployWindow, now: number): Span | null {
  if (w.recurrence === 'none') return windowSpans(w, now, now + 1)[0] ?? null
  return weeklySpanAt(w.ranges, w.time_zone, now)
}

function nextSpan(w: DeployWindow, now: number): Span | null {
  if (w.recurrence === 'none') {
    const s = w.starts_at ? Date.parse(w.starts_at) : Number.NaN
    const e = w.ends_at ? Date.parse(w.ends_at) : Number.NaN
    return Number.isFinite(s) && s > now && e > s ? { start: s, end: e } : null
  }
  return weeklyNextSpan(w.ranges, w.time_zone, now)
}

/** Whether a window still governs anything at `now` (an ended one-off does not). */
function live(w: DeployWindow, now: number): boolean {
  if (!w.enabled) return false
  if (w.recurrence === 'weekly') return w.ranges.length > 0
  const e = w.ends_at ? Date.parse(w.ends_at) : Number.NaN
  return Number.isFinite(e) && e > now
}

const fits = (w: DeployWindow, production: boolean | null) =>
  w.env_scope === 'all' || (w.env_scope === 'production' && production === true)

/**
 * The windows that govern an environment of `appId` (pure). `production` null = unknown (no
 * environment named: a train as a whole): production-only windows are then not judged — each
 * step judges its own environment when it starts.
 */
export function governingWindows(
  rows: DeployWindow[],
  appId: number | null,
  production: boolean | null,
  now: number
): DeployWindow[] {
  const usable = rows.filter((w) => live(w, now) && fits(w, production))
  const own = usable.filter((w) => w.app_id != null && w.app_id === appId)
  if (own.length) return own
  return usable.filter((w) => w.app_id == null)
}

export interface WindowJudgement {
  /** Whether any window governs the environment (false = any time). */
  governed: boolean
  open: boolean
  /** The window and span that hold now (open), the one closing last. */
  current: { window: DeployWindow; span: Span } | null
  /** The next opening (closed), the soonest. */
  next: { window: DeployWindow; span: Span } | null
  windows: DeployWindow[]
}

/** Open or closed now, and when it opens next (pure). */
export function judgeWindows(
  rows: DeployWindow[],
  appId: number | null,
  production: boolean | null,
  now: number
): WindowJudgement {
  const windows = governingWindows(rows, appId, production, now)
  if (!windows.length) return { governed: false, open: true, current: null, next: null, windows }
  let current: WindowJudgement['current'] = null
  for (const w of windows) {
    const s = spanAt(w, now)
    if (s && (!current || s.end > current.span.end)) current = { window: w, span: s }
  }
  if (current) return { governed: true, open: true, current, next: null, windows }
  let next: WindowJudgement['next'] = null
  for (const w of windows) {
    const s = nextSpan(w, now)
    if (s && (!next || s.start < next.span.start)) next = { window: w, span: s }
  }
  return { governed: true, open: false, current: null, next, windows }
}

const ACTION_WORDS: Partial<Record<FrozenAction, string>> = {
  promote: 'Promotions',
  apply: 'Stack applies'
}

const utcWords = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`

/** How a window reads in a sentence: "Weekdays 7 AM–5 PM (America/New_York)". */
export function windowWords(w: DeployWindow): string {
  if (w.recurrence === 'none')
    return `${w.starts_at ? utcWords(Date.parse(w.starts_at)) : '?'} to ${w.ends_at ? utcWords(Date.parse(w.ends_at)) : '?'}`
  return `${w.ranges.map(rangeWords).join(', ')} (${w.time_zone})`
}

/** The refusal for `action` when the judgement is closed (pure). */
export function windowRefusalFor(action: FrozenAction, j: WindowJudgement): FreezeRefusal | null {
  if (j.open || !ACTION_WORDS[action]) return null
  const first = j.next?.window ?? j.windows[0]
  // No opening in the next two weeks: a runner looks again in an hour.
  const opens = j.next ? j.next.span.start : Date.now() + 3_600_000
  const scope = first.app_id == null ? 'Hub-wide deploy windows' : 'this app’s deploy windows'
  const when = j.next
    ? `The next window opens ${utcWords(opens)}.`
    : 'No window opens in the next two weeks.'
  return {
    status: 409,
    code: 'OUTSIDE_WINDOW',
    message: `${ACTION_WORDS[action]} are allowed only inside ${scope} (${first.name}: ${windowWords(first)}). ${when} A rollback to an older version is always allowed.`,
    freeze: {
      id: first.id,
      name: first.name,
      app_id: first.app_id,
      ends_at: new Date(opens).toISOString()
    }
  }
}

export async function listWindows(o: { appIds?: number[] } = {}): Promise<DeployWindow[]> {
  const q = db(WINDOWS).orderBy('id', 'asc').select('*')
  if (o.appIds)
    q.where((w) => w.whereNull('app_id').orWhereIn('app_id', o.appIds?.length ? o.appIds : [-1]))
  return ((await q) as Array<Record<string, unknown>>).map(windowFromRow)
}

async function tableMissing(): Promise<boolean> {
  try {
    return !(await db.schema.hasTable(WINDOWS))
  } catch {
    return false
  }
}

/** Production per THE rule (owner-access envPolicy); fails closed to production. */
async function envIsProduction(envId: number): Promise<boolean> {
  try {
    const { envPolicy } = await import('../owner-access.js')
    return (await envPolicy(envId))?.production ?? true
  } catch {
    return true
  }
}

/**
 * Whether the windows refuse `action` for any of these apps now. Fails CLOSED like a freeze
 * (FREEZE_UNKNOWN, transient for runners) except on an install with no windows table (behind
 * migration 573). Only promote and apply are judged.
 */
export async function windowRefusal(o: {
  appIds: number[]
  action: FrozenAction
  envId?: number | null
  now?: number
  rows?: DeployWindow[]
  production?: boolean | null
}): Promise<FreezeRefusal | null> {
  if (!ACTION_WORDS[o.action]) return null
  let rows = o.rows
  if (!rows) {
    try {
      rows = await listWindows()
    } catch {
      if (await tableMissing()) return null
      const { freezeUnknown } = await import('./freeze.js')
      return freezeUnknown()
    }
  }
  if (!rows.length) return null
  const now = o.now ?? Date.now()
  let production = o.production ?? null
  if (production === null && o.envId != null) production = await envIsProduction(o.envId)
  for (const appId of o.appIds.length ? o.appIds : [null]) {
    const r = windowRefusalFor(o.action, judgeWindows(rows, appId, production, now))
    if (r) return r
  }
  return null
}

export interface WindowInput {
  app_id: number | null
  name: string
  env_scope: WindowScope
  recurrence: WindowRecurrence
  ranges: string | null
  starts_at: Date | null
  ends_at: Date | null
  time_zone: string
  enabled: boolean
}

/** Validates a window body; answers the row to write or a message. */
export function validateWindow(b: Record<string, unknown>): WindowInput | { error: string } {
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name || name.length > 120) return { error: 'name is required (at most 120 characters)' }
  let appId: number | null = null
  if (b.app_id != null && b.app_id !== '') {
    const n = Number(b.app_id)
    if (!Number.isSafeInteger(n) || n <= 0) return { error: 'app_id must be an app id or null' }
    appId = n
  }
  const scope =
    b.env_scope == null || b.env_scope === 'production'
      ? 'production'
      : b.env_scope === 'all'
        ? 'all'
        : null
  if (!scope) return { error: 'env_scope is production or all' }
  const recurrence =
    b.recurrence == null || b.recurrence === 'weekly'
      ? 'weekly'
      : b.recurrence === 'none'
        ? 'none'
        : null
  if (!recurrence) return { error: 'recurrence is weekly or none' }
  const tz = b.time_zone == null || b.time_zone === '' ? 'UTC' : b.time_zone
  if (!isTimeZone(tz))
    return { error: 'time_zone must be an IANA time zone (e.g. America/New_York)' }
  const enabled = b.enabled == null ? true : truthy(b.enabled)
  if (recurrence === 'weekly') {
    const ranges = validateRanges(b.ranges)
    if (!Array.isArray(ranges)) return ranges
    return {
      app_id: appId,
      name,
      env_scope: scope,
      recurrence,
      ranges: JSON.stringify(ranges),
      starts_at: null,
      ends_at: null,
      time_zone: tz,
      enabled
    }
  }
  const s = typeof b.starts_at === 'string' ? new Date(b.starts_at) : null
  const e = typeof b.ends_at === 'string' ? new Date(b.ends_at) : null
  if (!s || Number.isNaN(s.getTime()) || !e || Number.isNaN(e.getTime()))
    return { error: 'starts_at and ends_at are ISO times' }
  if (e.getTime() <= s.getTime()) return { error: 'ends_at must be after starts_at' }
  if (e.getTime() - s.getTime() > 31 * 86_400_000)
    return { error: 'a one-off window lasts at most 31 days' }
  return {
    app_id: appId,
    name,
    env_scope: scope,
    recurrence,
    ranges: null,
    starts_at: s,
    ends_at: e,
    time_zone: tz,
    enabled
  }
}
