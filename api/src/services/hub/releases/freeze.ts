import { db } from '../../../db/index.js'
import { daysInMonth, isTimeZone, zonedMidnightUtc, zonedParts } from './zoned.js'

/**
 * Freeze windows (Hub release operations): while one is on, the Hub refuses to promote, upgrade
 * a shared deployment or move an environment — a rollback is always allowed. A window belongs to
 * one app (app_id) or to the whole Hub (app_id null).
 *
 *  - recurrence 'none'       one window, starts_at ≤ now < ends_at (UTC instants)
 *  - recurrence 'month_end'  every month: the last `days_before` days of the month through the
 *                            first `days_after` days of the next, midnight to midnight on the
 *                            calendar of `time_zone` (a month end in New York is not UTC's)
 *
 * The judgement is pure (activeWindow); freezeRefusal reads the rows and answers the refusal a
 * route or a runner sends (409 FROZEN), or null. It is the ONE release-time rule engine: after
 * the freezes it judges the deploy windows (windows.ts, allowed times) for promote and apply
 * (409 OUTSIDE_WINDOW), so every caller honours both.
 */

import { archivedRefusal } from './archived.js'

export const FREEZES = 'nivaro_hub_freezes'

export type FreezeRecurrence = 'none' | 'month_end'
/** What a freeze stops. A rollback is never one of them. */
/**
 * config_promote / extension_promote: the seam for hub-enh/config (config promotion through the
 * Hub) and hub-enh/verify (extension promotion) — once their starts call freezeRefusal (and
 * checklistGate), freezes, deploy windows and checklists judge them like any other start.
 */
export type FrozenAction =
  | 'promote'
  | 'upgrade'
  | 'move'
  | 'apply'
  | 'config_promote'
  | 'extension_promote'
  /** Hub placement (review L1): placing an environment / changing its placement (no deploy). */
  | 'placement'
  /** An access review's removals (services/hub/security/reviews.ts): accounts suspended. */
  | 'access_change'
  /** Hub enhancement 47: every step of an app's retirement wizard (services/hub/lifecycle). */
  | 'retire'
  /** Hub providers: a change of an app's (or a shared) managed resource at a provider. */
  | 'resource_change'

export interface HubFreeze {
  id: number
  app_id: number | null
  name: string
  recurrence: FreezeRecurrence
  starts_at: string | null
  ends_at: string | null
  days_before: number | null
  days_after: number | null
  time_zone: string | null
  /** What made it (`incident:<id>`, `retire:<id>`); null = a person's own freeze window. */
  source?: string | null
}

export interface FreezeWindow {
  start: number
  end: number
}

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
const intOrNull = (v: unknown): number | null =>
  v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v))

export function freezeFromRow(r: Record<string, unknown>): HubFreeze {
  return {
    id: Number(r.id),
    app_id: r.app_id == null ? null : Number(r.app_id),
    name: String(r.name ?? ''),
    recurrence: r.recurrence === 'month_end' ? 'month_end' : 'none',
    starts_at: iso(r.starts_at),
    ends_at: iso(r.ends_at),
    days_before: intOrNull(r.days_before),
    days_after: intOrNull(r.days_after),
    time_zone: r.time_zone == null ? null : String(r.time_zone),
    source: r.source == null ? null : String(r.source)
  }
}

/** The month-end window that starts in (year, month) of the freeze's zone. */
function monthEndWindow(f: HubFreeze, year: number, month: number): FreezeWindow | null {
  const tz = f.time_zone && isTimeZone(f.time_zone) ? f.time_zone : 'UTC'
  const before = Math.max(0, f.days_before ?? 0)
  const after = Math.max(0, f.days_after ?? 0)
  if (before + after === 0) return null
  const dim = daysInMonth(year, month)
  const start = zonedMidnightUtc(year, month, dim - before + 1, tz)
  const end = zonedMidnightUtc(year, month + 1, after + 1, tz)
  return { start, end }
}

/** The window of `f` that holds `now`, or null. */
export function activeWindow(f: HubFreeze, now: number): FreezeWindow | null {
  if (f.recurrence === 'none') {
    const start = f.starts_at ? Date.parse(f.starts_at) : Number.NaN
    const end = f.ends_at ? Date.parse(f.ends_at) : Number.NaN
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null
    return now >= start && now < end ? { start, end } : null
  }
  const tz = f.time_zone && isTimeZone(f.time_zone) ? f.time_zone : 'UTC'
  const p = zonedParts(now, tz)
  // This month's window, and last month's (its tail reaches into the first days of this one).
  for (const [y, m] of [
    [p.year, p.month],
    p.month === 1 ? [p.year - 1, 12] : [p.year, p.month - 1]
  ]) {
    const w = monthEndWindow(f, y, m)
    if (w && now >= w.start && now < w.end) return w
  }
  return null
}

/** The next window of `f` that starts after `now` (for the page), or null. */
export function nextWindow(f: HubFreeze, now: number): FreezeWindow | null {
  if (f.recurrence === 'none') {
    const start = f.starts_at ? Date.parse(f.starts_at) : Number.NaN
    const end = f.ends_at ? Date.parse(f.ends_at) : Number.NaN
    return Number.isFinite(start) && start > now && end > start ? { start, end } : null
  }
  const tz = f.time_zone && isTimeZone(f.time_zone) ? f.time_zone : 'UTC'
  const p = zonedParts(now, tz)
  for (let i = 0; i < 3; i++) {
    const m0 = p.month - 1 + i
    const w = monthEndWindow(f, p.year + Math.floor(m0 / 12), (m0 % 12) + 1)
    if (w && w.start > now) return w
  }
  return null
}

export interface ActiveFreeze {
  freeze: HubFreeze
  window: FreezeWindow
}

/** The windows on now for `appId` (its own and the Hub-wide ones), the one ending last first. */
export function activeFreezes(
  rows: HubFreeze[],
  appId: number | null,
  now: number
): ActiveFreeze[] {
  const out: ActiveFreeze[] = []
  for (const f of rows) {
    if (f.app_id != null && f.app_id !== appId) continue
    const w = activeWindow(f, now)
    if (w) out.push({ freeze: f, window: w })
  }
  return out.sort((a, b) => b.window.end - a.window.end)
}

const ACTION_WORDS: Record<FrozenAction, string> = {
  promote: 'Promotions',
  apply: 'Stack applies',
  upgrade: 'Shared deployment upgrades',
  move: 'Moves',
  config_promote: 'Config promotions',
  extension_promote: 'Extension promotions',
  placement: 'Placement changes',
  access_change: 'Access review removals',
  retire: 'Retirements',
  resource_change: 'Resource changes'
}

export interface FreezeRefusal {
  status: 409 | 503
  /**
   * FREEZE_UNKNOWN: the windows could not be read (fails closed; a runner tries again).
   * OUTSIDE_WINDOW: a deploy window governs the app and none is open (windows.ts); `ends_at` is
   * then the next opening. WINDOW_INVALID: a governing window cannot be read (fails closed).
   */
  code: 'FROZEN' | 'FREEZE_UNKNOWN' | 'OUTSIDE_WINDOW' | 'WINDOW_INVALID' | 'ENV_ARCHIVED'
  message: string
  freeze: { id: number; name: string; app_id: number | null; ends_at: string }
  /** OUTSIDE_WINDOW: the next opening, or null when none opens within 14 days. */
  next_opening?: string | null
}

/** The refusal for `action` under an active freeze (pure). */
export function refusalFor(
  action: FrozenAction,
  active: ActiveFreeze | undefined,
  appKey?: string | null
): FreezeRefusal | null {
  if (!active) return null
  const ends = new Date(active.window.end).toISOString()
  const scope =
    active.freeze.app_id == null ? 'Hub-wide' : appKey ? `for ${appKey}` : 'for this app'
  return {
    status: 409,
    code: 'FROZEN',
    // A readable UTC time in the sentence (stored notes keep it); ends_at carries the instant.
    message: `${ACTION_WORDS[action]} are frozen ${scope} until ${ends.slice(0, 16).replace('T', ' ')} UTC (${active.freeze.name}). A rollback to an older version is still allowed.`,
    freeze: {
      id: active.freeze.id,
      name: active.freeze.name,
      app_id: active.freeze.app_id,
      ends_at: ends
    }
  }
}

export async function listFreezes(): Promise<HubFreeze[]> {
  const rows = (await db(FREEZES).orderBy('id', 'asc').select('*')) as Array<
    Record<string, unknown>
  >
  return rows.map(freezeFromRow)
}

/** The refusal when the windows cannot be read: closed, never "no freeze". */
export function freezeUnknown(): FreezeRefusal {
  return {
    status: 503,
    code: 'FREEZE_UNKNOWN',
    message: 'The Hub could not read its freeze windows — try again shortly',
    freeze: { id: 0, name: '', app_id: null, ends_at: new Date().toISOString() }
  }
}

/** A read failure that means "no freeze table" (an install behind migration 565). */
async function tableMissing(): Promise<boolean> {
  try {
    return !(await db.schema.hasTable(FREEZES))
  } catch {
    return false
  }
}

/**
 * Whether a freeze stops `action` for any of these apps now. Fails CLOSED: windows that cannot
 * be read answer FREEZE_UNKNOWN (503; runners treat it as passing) — except on an install with
 * no freeze table at all (behind migration 565), which has no windows to honour.
 */
export async function freezeRefusal(o: {
  appIds: number[]
  action: FrozenAction
  now?: number
  rows?: HubFreeze[]
  /**
   * The environment the action deploys (deploy windows scoped to production judge it by THE
   * production rule); omitted = production-only windows are not judged here.
   */
  envId?: number | null
  /** Deploy windows handed in (tests); omitted with `rows` given = none. */
  windows?: import('./windows.js').DeployWindow[]
  /**
   * An administrator's emergency start (services/hub/changes/emergency.ts): the deploy windows
   * are not judged. Freezes always are.
   */
  skipWindows?: boolean
  /** App keys to name in the refusal (a shared upgrade names the frozen app). */
  appKeys?: Map<number, string>
  /**
   * Freezes this judgement leaves out, by their `source` (a shared upgrade leaves out the
   * `retire:<id>` freezes of apps being taken off the deployment).
   */
  ignoreSource?: (source: string) => boolean
}): Promise<FreezeRefusal | null> {
  // Hub enhancement 47: nothing starts on a retired app (409 ENV_ARCHIVED). The retirement's
  // own steps archive it; a shared upgrade names no environment of its own.
  if (o.action !== 'retire' && o.action !== 'upgrade') {
    const archived = await archivedRefusal({ appIds: o.appIds, envId: o.envId ?? null })
    if (archived) return archived
  }
  let rows = o.rows
  if (!rows) {
    try {
      rows = await listFreezes()
    } catch {
      return (await tableMissing()) ? null : freezeUnknown()
    }
  }
  const now = o.now ?? Date.now()
  if (o.ignoreSource) {
    const skip = o.ignoreSource
    rows = rows.filter((f) => !(f.source && skip(f.source)))
  }
  const ids = o.appIds.length ? o.appIds : [null]
  for (const appId of ids) {
    const r = refusalFor(
      o.action,
      activeFreezes(rows, appId, now)[0],
      appId == null ? null : (o.appKeys?.get(appId) ?? null)
    )
    if (r) return r
  }
  // The same engine's other half: deploy windows (allowed times), windows.ts decides which
  // actions they judge.
  if (o.skipWindows) return null
  if (o.rows && !o.windows) return null
  const { windowRefusal } = await import('./windows.js')
  return windowRefusal({
    appIds: o.appIds,
    action: o.action,
    now,
    ...(o.envId != null ? { envId: o.envId } : {}),
    ...(o.windows ? { rows: o.windows } : {})
  })
}

/**
 * A rollback is exempt from a freeze only when it goes back to an OLDER version than the one
 * running (the last known good). A "rollback" to the running version or a newer one deploys
 * something new, so it is judged as a promotion. An unknown running version is not exempt.
 */
export function rollbackExempt(target: string, running: string | null | undefined): boolean {
  if (!running) return false
  const p = (v: string) => v.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const [a, b] = [p(target), p(running)]
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d < 0
  }
  return false
}

/** The app an environment belongs to (null = no such environment). */
export async function appOfEnvironment(envId: number): Promise<number | null> {
  const row = (await db('nivaro_hub_environments').where({ id: envId }).first('app_id')) as
    | { app_id: number }
    | undefined
  return row ? Number(row.app_id) : null
}

/** The apps placed on a shared deployment (an upgrade of it changes every one of them). */
export async function appsOnShared(sharedId: number): Promise<number[]> {
  const rows = (await db('nivaro_hub_environments as e')
    .join('nivaro_hub_placements as p', 'p.id', 'e.placement_id')
    .where('p.shared_deployment_id', sharedId)
    .distinct('e.app_id')) as Array<{ app_id: number }>
  return rows.map((r) => Number(r.app_id))
}

/** Route helper: the refusal for an environment's app (promote, apply, move). Fails closed. */
export async function environmentFreezeRefusal(
  envId: number,
  action: FrozenAction,
  o: { skipWindows?: boolean } = {}
): Promise<FreezeRefusal | null> {
  let appId: number | null
  try {
    appId = await appOfEnvironment(envId)
  } catch {
    return freezeUnknown()
  }
  if (appId == null) return null
  return freezeRefusal({
    appIds: [appId],
    action,
    envId,
    ...(o.skipWindows ? { skipWindows: true } : {})
  })
}

/**
 * Route helper: the refusal for a shared deployment's upgrade (any app on it, or Hub-wide). A
 * rollback to an older version than the deployment runs is exempt; any other target is an
 * upgrade. Fails closed.
 */
export async function sharedFreezeRefusal(
  sharedId: number,
  o: {
    kind?: 'upgrade' | 'rollback'
    version?: string
    running?: string | null
    skipWindows?: boolean
  } = {}
): Promise<FreezeRefusal | null> {
  if (o.kind === 'rollback' && o.version && rollbackExempt(o.version, o.running)) return null
  let apps: number[]
  let keys: Map<number, string>
  try {
    apps = await appsOnShared(sharedId)
    const rows = (await db('nivaro_hub_apps')
      .whereIn('id', apps.length ? apps : [-1])
      .select('id', 'key')) as Array<{ id: number; key: string }>
    keys = new Map(rows.map((r) => [Number(r.id), String(r.key)]))
  } catch {
    return freezeUnknown()
  }
  // Every placed app's freezes (the frozen app is named) and the Hub-wide windows (windows.ts).
  return freezeRefusal({
    appIds: apps,
    action: 'upgrade',
    appKeys: keys,
    // A retiring app's own freeze (`retire:<id>`) is app-scoped: it holds that app's starts,
    // never the upgrade of the shared deployment the retirement is taking it off.
    ignoreSource: (source) => source.startsWith('retire:'),
    ...(o.skipWindows ? { skipWindows: true } : {})
  })
}

/**
 * The version a shared deployment runs, for the rollback exemption: what its link reports (the
 * live status, passed in), else the Hub's record — but only when the NEWEST run of it (any
 * status) is a successful one (a Hub run, or a registered deployment's observed version). A
 * later run that failed, was interrupted, cancelled or is still running leaves what runs
 * unknown. Unknown = null = gated. Never the stored pin alone.
 */
export async function sharedRunningVersion(
  sharedId: number,
  reported?: string | null
): Promise<string | null> {
  if (reported) return reported
  try {
    const row = (await db('nivaro_hub_shared_deploys')
      .where({ shared_deployment_id: sharedId })
      .orderBy('id', 'desc')
      .first('version', 'status')) as { version: string; status: string } | undefined
    return row && row.status === 'success' && row.version ? String(row.version) : null
  } catch {
    return null
  }
}

/**
 * The version an environment runs for the rollback exemption when its live status is unknown:
 * the Hub's own record, trusted only when
 *   - the NEWEST Hub deploy row of the environment (any status) is a successful one — a later
 *     run that failed, was interrupted, cancelled or is still running leaves what runs unknown;
 *   - and the environment's last status sample (nivaro_hub_fleet_status, when there is one)
 *     does not name another version — a version changed outside the Hub.
 * An automatic rollback reverts that newest successful deploy, so its target (the build before
 * it) is a real downgrade by this record. Anything else = null = unknown = gated.
 */
export async function recordedRunningVersion(envId: number): Promise<string | null> {
  try {
    const row = (await db('nivaro_hub_deploys')
      .where({ environment_id: envId })
      .orderBy('id', 'desc')
      .first('version', 'status')) as { version: string; status: string } | undefined
    if (!row || row.status !== 'success' || !row.version) return null
    const recorded = String(row.version)
    let sampled: string | null = null
    try {
      const st = (await db('nivaro_hub_fleet_status')
        .where({ environment_id: envId })
        .first('version')) as { version: string | null } | undefined
      sampled = st?.version ? String(st.version) : null
    } catch {
      // No fleet table (an install behind 566): nothing sampled to disagree.
    }
    return sampled && sampled !== recorded ? null : recorded
  } catch {
    return null
  }
}

export interface FreezeInput {
  app_id: number | null
  name: string
  recurrence: FreezeRecurrence
  starts_at: Date | null
  ends_at: Date | null
  days_before: number | null
  days_after: number | null
  time_zone: string | null
}

/** Validates a freeze body; answers the row to write or a message. */
export function validateFreeze(b: Record<string, unknown>): FreezeInput | { error: string } {
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name || name.length > 120) return { error: 'name is required (at most 120 characters)' }
  let appId: number | null = null
  if (b.app_id != null && b.app_id !== '') {
    const n = Number(b.app_id)
    if (!Number.isSafeInteger(n) || n <= 0) return { error: 'app_id must be an app id or null' }
    appId = n
  }
  const recurrence =
    b.recurrence === 'month_end'
      ? 'month_end'
      : b.recurrence == null || b.recurrence === 'none'
        ? 'none'
        : null
  if (!recurrence) return { error: 'recurrence is none or month_end' }
  if (recurrence === 'none') {
    const s = typeof b.starts_at === 'string' ? new Date(b.starts_at) : null
    const e = typeof b.ends_at === 'string' ? new Date(b.ends_at) : null
    if (!s || Number.isNaN(s.getTime()) || !e || Number.isNaN(e.getTime()))
      return { error: 'starts_at and ends_at are ISO times' }
    if (e.getTime() <= s.getTime()) return { error: 'ends_at must be after starts_at' }
    if (e.getTime() - s.getTime() > 366 * 86_400_000)
      return { error: 'a freeze lasts at most a year' }
    return {
      app_id: appId,
      name,
      recurrence,
      starts_at: s,
      ends_at: e,
      days_before: null,
      days_after: null,
      time_zone: null
    }
  }
  const before = Number(b.days_before ?? 0)
  const after = Number(b.days_after ?? 0)
  if (!Number.isInteger(before) || before < 0 || before > 10)
    return { error: 'days_before is 0 to 10' }
  if (!Number.isInteger(after) || after < 0 || after > 10) return { error: 'days_after is 0 to 10' }
  if (before + after === 0) return { error: 'a month-end freeze covers at least one day' }
  const tz = b.time_zone == null || b.time_zone === '' ? 'UTC' : b.time_zone
  if (!isTimeZone(tz))
    return { error: 'time_zone must be an IANA time zone (e.g. America/New_York)' }
  return {
    app_id: appId,
    name,
    recurrence,
    starts_at: null,
    ends_at: null,
    days_before: before,
    days_after: after,
    time_zone: tz
  }
}
