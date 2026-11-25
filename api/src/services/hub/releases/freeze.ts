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
 * route or a runner sends (409 FROZEN), or null.
 */

export const FREEZES = 'nivaro_hub_freezes'

export type FreezeRecurrence = 'none' | 'month_end'
/** What a freeze stops. A rollback is never one of them. */
export type FrozenAction = 'promote' | 'upgrade' | 'move' | 'apply'

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
    time_zone: r.time_zone == null ? null : String(r.time_zone)
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
  move: 'Moves'
}

export interface FreezeRefusal {
  status: 409
  code: 'FROZEN'
  message: string
  freeze: { id: number; name: string; app_id: number | null; ends_at: string }
}

/** The refusal for `action` under an active freeze (pure). */
export function refusalFor(
  action: FrozenAction,
  active: ActiveFreeze | undefined
): FreezeRefusal | null {
  if (!active) return null
  const ends = new Date(active.window.end).toISOString()
  const scope = active.freeze.app_id == null ? 'Hub-wide' : 'for this app'
  return {
    status: 409,
    code: 'FROZEN',
    message: `${ACTION_WORDS[action]} are frozen ${scope} until ${ends} (${active.freeze.name}). A rollback is still allowed.`,
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

/**
 * Whether a freeze stops `action` for any of these apps now. A table that cannot be read (an
 * install behind migration 565) freezes nothing — the freeze is a guard rail, not a lock.
 */
export async function freezeRefusal(o: {
  appIds: number[]
  action: FrozenAction
  now?: number
  rows?: HubFreeze[]
}): Promise<FreezeRefusal | null> {
  let rows = o.rows
  if (!rows) {
    try {
      rows = await listFreezes()
    } catch {
      return null
    }
  }
  const now = o.now ?? Date.now()
  const ids = o.appIds.length ? o.appIds : [null]
  for (const appId of ids) {
    const r = refusalFor(o.action, activeFreezes(rows, appId, now)[0])
    if (r) return r
  }
  return null
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

/** Route helper: the refusal for an environment's app (promote, apply, move). */
export async function environmentFreezeRefusal(
  envId: number,
  action: FrozenAction
): Promise<FreezeRefusal | null> {
  try {
    const appId = await appOfEnvironment(envId)
    if (appId == null) return null
    return await freezeRefusal({ appIds: [appId], action })
  } catch {
    return null
  }
}

/** Route helper: the refusal for an upgrade of a shared deployment (any app on it, or Hub-wide). */
export async function sharedFreezeRefusal(sharedId: number): Promise<FreezeRefusal | null> {
  try {
    return await freezeRefusal({ appIds: await appsOnShared(sharedId), action: 'upgrade' })
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
