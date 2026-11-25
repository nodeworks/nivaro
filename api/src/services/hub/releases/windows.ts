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
 * Deploy windows (Hub enhancement 27): the times an app MAY be changed. They are the other half
 * of the ONE release-time rule engine (freeze.ts judges freezes first, then these, in
 * freezeRefusal), so every start that honours a freeze honours the windows too, with the same
 * wait / fail handling.
 *
 * Which WEEKLY windows govern an environment of an app (enabled ones only):
 *   - a production environment (THE production rule, owner-access envPolicy): the production-
 *     scope windows — the app's own when it has any, else the Hub-wide ones; only when there are
 *     none at all, the `all`-scope windows (own, else Hub-wide). A window meant for "every
 *     environment" never lifts a production-only rule;
 *   - any other environment: the `all`-scope windows, own else Hub-wide;
 *   - none: the environment may be changed at any time.
 * One-off windows only ADD openings (an approved extra slot) to an environment that weekly
 * windows govern; on their own they restrict nothing.
 * Governed: inside any span = allowed, else 409 OUTSIDE_WINDOW carrying the next opening
 * (`freeze.ends_at` and `next_opening`; null `next_opening` = nothing opens within 14 days).
 * A governing window whose stored ranges or zone cannot be read fails CLOSED (409
 * WINDOW_INVALID) until an administrator fixes it.
 *
 * Actions judged: promote, apply (Apply now, secret rotation), move (a move redeploys the app),
 * config_promote / extension_promote (the seam for hub-enh/config and hub-enh/verify), and
 * upgrade — a shared deployment upgrade is judged by the Hub-wide windows only (its apps'
 * own windows are warnings in its plan). Real rollbacks are never judged here (freeze.ts
 * rollbackExempt). An administrator's emergency start skips the windows (never a freeze or a
 * checklist): services/hub/changes/emergency.ts.
 */

export const WINDOWS = 'nivaro_hub_deploy_windows'
/** How far ahead an opening is looked for; none within it = no opening soon. */
export const OPENING_HORIZON_MS = 14 * 86_400_000

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
  /** Why the stored row cannot be read (a governing invalid window refuses); null = fine. */
  invalid?: string | null
}

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

export function windowFromRow(r: Record<string, unknown>): DeployWindow {
  const recurrence: WindowRecurrence = r.recurrence === 'none' ? 'none' : 'weekly'
  let ranges: WeeklyRange[] = []
  let invalid: string | null = null
  if (recurrence === 'weekly') {
    try {
      const parsed = typeof r.ranges === 'string' ? JSON.parse(r.ranges) : r.ranges
      const v = validateRanges(parsed)
      if (Array.isArray(v)) ranges = v
      else invalid = `its weekly ranges cannot be read (${v.error})`
    } catch {
      invalid = 'its weekly ranges cannot be read'
    }
  }
  const zone: string = r.time_zone == null || r.time_zone === '' ? 'UTC' : String(r.time_zone)
  const zoneOk = isTimeZone(zone)
  if (!zoneOk) invalid = invalid ?? `its time zone “${String(zone).slice(0, 64)}” is not known`
  return {
    id: Number(r.id),
    app_id: r.app_id == null ? null : Number(r.app_id),
    name: String(r.name ?? ''),
    env_scope: r.env_scope === 'all' ? 'all' : 'production',
    recurrence,
    ranges,
    starts_at: iso(r.starts_at),
    ends_at: iso(r.ends_at),
    time_zone: zoneOk ? zone : 'UTC',
    enabled: r.enabled == null ? true : truthy(r.enabled),
    invalid
  }
}

/** The spans of one window overlapping [from, to). */
export function windowSpans(w: DeployWindow, from: number, to: number): Span[] {
  if (w.invalid) return []
  if (w.recurrence === 'none') {
    const s = w.starts_at ? Date.parse(w.starts_at) : Number.NaN
    const e = w.ends_at ? Date.parse(w.ends_at) : Number.NaN
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return []
    return e > from && s < to ? [{ start: s, end: e }] : []
  }
  return weeklySpans(w.ranges, w.time_zone, from, to)
}

function spanAt(w: DeployWindow, now: number): Span | null {
  if (w.invalid) return null
  if (w.recurrence === 'none') return windowSpans(w, now, now + 1)[0] ?? null
  return weeklySpanAt(w.ranges, w.time_zone, now)
}

function nextSpan(w: DeployWindow, now: number): Span | null {
  if (w.invalid) return null
  let s: Span | null
  if (w.recurrence === 'none') {
    const a = w.starts_at ? Date.parse(w.starts_at) : Number.NaN
    const e = w.ends_at ? Date.parse(w.ends_at) : Number.NaN
    s = Number.isFinite(a) && a > now && e > a ? { start: a, end: e } : null
  } else s = weeklyNextSpan(w.ranges, w.time_zone, now)
  return s && s.start - now <= OPENING_HORIZON_MS ? s : null
}

const fits = (w: DeployWindow, production: boolean | null) =>
  w.env_scope === 'all' || (w.env_scope === 'production' && production === true)

/** Own windows of `scope` when the app has any, else the Hub-wide ones (pure). */
function ownElseHub(list: DeployWindow[], appId: number | null): DeployWindow[] {
  const own = list.filter((w) => w.app_id != null && w.app_id === appId)
  return own.length ? own : list.filter((w) => w.app_id == null)
}

/**
 * The weekly windows that govern an environment of `appId`, and the one-off windows that add
 * openings to it (pure). `production` null = unknown (no environment named: a train as a whole):
 * production-scope windows are then not judged — each step judges its own environment.
 * `hubWideOnly` = only Hub-wide windows count (a shared deployment upgrade).
 */
export function governingWindows(
  rows: DeployWindow[],
  appId: number | null,
  production: boolean | null,
  _now: number,
  o: { hubWideOnly?: boolean } = {}
): DeployWindow[] {
  const usable = rows.filter(
    (w) =>
      w.enabled &&
      fits(w, production) &&
      (!o.hubWideOnly || w.app_id == null) &&
      (w.app_id == null || w.app_id === appId)
  )
  const weekly = usable.filter((w) => w.recurrence === 'weekly')
  const prod =
    production === true
      ? ownElseHub(
          weekly.filter((w) => w.env_scope === 'production'),
          appId
        )
      : []
  const base = prod.length
    ? prod
    : ownElseHub(
        weekly.filter((w) => w.env_scope === 'all'),
        appId
      )
  if (!base.length) return []
  const extras = usable.filter((w) => w.recurrence === 'none')
  return [...base, ...extras]
}

export interface WindowJudgement {
  /** Whether any weekly window governs the environment (false = any time). */
  governed: boolean
  open: boolean
  /** The window and span that hold now (open), the one closing last. */
  current: { window: DeployWindow; span: Span } | null
  /** The next opening within 14 days (closed), the soonest; null = none that soon. */
  next: { window: DeployWindow; span: Span } | null
  windows: DeployWindow[]
  /** Governing windows that cannot be read: the judgement is closed while any is. */
  invalid: DeployWindow[]
}

/** Open or closed now, and when it opens next (pure). */
export function judgeWindows(
  rows: DeployWindow[],
  appId: number | null,
  production: boolean | null,
  now: number,
  o: { hubWideOnly?: boolean } = {}
): WindowJudgement {
  const windows = governingWindows(rows, appId, production, now, o)
  const invalid = windows.filter((w) => w.invalid)
  if (!windows.length)
    return { governed: false, open: true, current: null, next: null, windows, invalid }
  if (invalid.length)
    return { governed: true, open: false, current: null, next: null, windows, invalid }
  let current: WindowJudgement['current'] = null
  for (const w of windows) {
    const s = spanAt(w, now)
    if (s && (!current || s.end > current.span.end)) current = { window: w, span: s }
  }
  if (current) return { governed: true, open: true, current, next: null, windows, invalid }
  let next: WindowJudgement['next'] = null
  for (const w of windows) {
    const s = nextSpan(w, now)
    if (s && (!next || s.start < next.span.start)) next = { window: w, span: s }
  }
  return { governed: true, open: false, current: null, next, windows, invalid }
}

/** The actions deploy windows judge, in words. */
export const WINDOW_ACTION_WORDS: Partial<Record<FrozenAction, string>> = {
  promote: 'Promotions',
  apply: 'Stack applies',
  move: 'Moves',
  upgrade: 'Shared deployment upgrades',
  config_promote: 'Config promotions',
  extension_promote: 'Extension promotions',
  retire: 'Retirements'
}

const utcWords = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`

/** How a window reads in a sentence: "Weekdays 7 AM–5 PM (America/New_York)". */
export function windowWords(w: DeployWindow): string {
  if (w.invalid) return `cannot be read: ${w.invalid}`
  if (w.recurrence === 'none')
    return `${w.starts_at ? utcWords(Date.parse(w.starts_at)) : '?'} to ${w.ends_at ? utcWords(Date.parse(w.ends_at)) : '?'}`
  return `${w.ranges.map(rangeWords).join(', ')} (${w.time_zone})`
}

/** The refusal for `action` when the judgement is closed (pure). */
export function windowRefusalFor(
  action: FrozenAction,
  j: WindowJudgement,
  now = Date.now()
): FreezeRefusal | null {
  const words = WINDOW_ACTION_WORDS[action]
  if (j.open || !words) return null
  const bad = j.invalid[0]
  if (bad)
    return {
      status: 409,
      code: 'WINDOW_INVALID',
      message: `${words} are refused: the deploy window “${bad.name}” ${bad.invalid}. An administrator fixes or deletes it on the Apps hub’s Changes tab. A rollback to an older version is always allowed.`,
      freeze: {
        id: bad.id,
        name: bad.name,
        app_id: bad.app_id,
        ends_at: new Date(now + 3_600_000).toISOString()
      },
      next_opening: null
    }
  const first = j.next?.window ?? j.windows[0]
  // No opening in the next 14 days: a runner looks again in an hour (a schedule is missed).
  const opens = j.next ? j.next.span.start : now + 3_600_000
  const scope = first.app_id == null ? 'Hub-wide deploy windows' : 'this app’s deploy windows'
  const when = j.next
    ? `The next window opens ${utcWords(opens)}.`
    : 'No window opens in the next 14 days.'
  return {
    status: 409,
    code: 'OUTSIDE_WINDOW',
    message: `${words} are allowed only inside ${scope} (${first.name}: ${windowWords(first)}). ${when} A rollback to an older version is always allowed.`,
    freeze: {
      id: first.id,
      name: first.name,
      app_id: first.app_id,
      ends_at: new Date(opens).toISOString()
    },
    next_opening: j.next ? new Date(opens).toISOString() : null
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
 * migration 573). An `upgrade` is judged by the Hub-wide windows only, as production.
 */
export async function windowRefusal(o: {
  appIds: number[]
  action: FrozenAction
  envId?: number | null
  now?: number
  rows?: DeployWindow[]
  production?: boolean | null
}): Promise<FreezeRefusal | null> {
  if (!WINDOW_ACTION_WORDS[o.action]) return null
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
  const hubWideOnly = o.action === 'upgrade'
  let production = o.production ?? null
  if (hubWideOnly) production = true
  else if (production === null && o.envId != null) production = await envIsProduction(o.envId)
  for (const appId of hubWideOnly ? [null] : o.appIds.length ? o.appIds : [null]) {
    const r = windowRefusalFor(
      o.action,
      judgeWindows(rows, appId, production, now, { hubWideOnly }),
      now
    )
    if (r) return r
  }
  return null
}

/**
 * The apps on a shared deployment whose OWN windows are closed now (warnings in its upgrade plan,
 * never a block): `{app_id, text}` per closed app.
 */
export async function closedAppWindows(
  apps: Array<{ app_id: number; key: string; production: boolean }>,
  now = Date.now()
): Promise<Array<{ app_id: number; text: string }>> {
  let rows: DeployWindow[]
  try {
    rows = await listWindows({ appIds: apps.map((a) => a.app_id) })
  } catch {
    return []
  }
  const out: Array<{ app_id: number; text: string }> = []
  for (const a of apps) {
    const own = rows.filter((w) => w.app_id === a.app_id)
    if (!own.length) continue
    const j = judgeWindows(own, a.app_id, a.production, now)
    if (j.governed && !j.open)
      out.push({
        app_id: a.app_id,
        text: j.invalid.length
          ? `${a.key}: its deploy window “${j.invalid[0].name}” cannot be read.`
          : `${a.key}: outside its own deploy window${j.next ? ` (next opens ${utcWords(j.next.span.start)})` : ''}. The upgrade changes its version anyway.`
      })
  }
  return out
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
