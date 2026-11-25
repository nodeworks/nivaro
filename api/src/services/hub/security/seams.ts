import { db } from '../../../db/index.js'

/**
 * Seams to Hub features built beside this one (wave 2): the change calendar (hub-enh/change,
 * services/hub/changes/calendar.ts `upsertCalendarEntry`) and incidents + on-call
 * (hub-enh/incident, services/hub/incident/*, tables nivaro_hub_incidents / _oncall_*). Each seam
 * does nothing until its feature is in this build: the module is loaded by URL at run time (so
 * this file compiles without it) and its table must exist. Any failure — module missing, a
 * changed shape, a read error — reads as "not there": nothing written, and for on-call, NO
 * self-approval (fails closed).
 */

type Loader = (spec: string) => Promise<Record<string, unknown>>

/** Loads a sibling Hub module by URL (tests inject their own). */
const defaultLoader: Loader = async (spec) =>
  (await import(/* @vite-ignore */ new URL(spec, import.meta.url).href)) as Record<string, unknown>

export interface SeamDeps {
  load?: Loader
  hasTable?: (name: string) => Promise<boolean>
}

const hasTableOf = (deps: SeamDeps) => deps.hasTable ?? ((n: string) => db.schema.hasTable(n))

export interface CalendarEntry {
  source: string
  key: string
  kind: string
  title: string
  description?: string | null
  app_id?: number | null
  environment_id?: number | null
  starts_at: Date
  ends_at?: Date | null
}

/** Puts one change-calendar entry; false when the calendar is not in this build. Never throws. */
export async function putCalendarEntry(e: CalendarEntry, deps: SeamDeps = {}): Promise<boolean> {
  try {
    if (!(await hasTableOf(deps)('nivaro_hub_calendar_entries'))) return false
    const mod = await (deps.load ?? defaultLoader)('../changes/calendar.js')
    const fn = mod.upsertCalendarEntry
    if (typeof fn !== 'function') return false
    await (fn as (x: CalendarEntry) => Promise<void>)(e)
    return true
  } catch {
    return false
  }
}

/** Takes one entry off the calendar (the certificate was renewed). Never throws. */
export async function dropCalendarEntry(
  source: string,
  key: string,
  deps: SeamDeps = {}
): Promise<boolean> {
  try {
    if (!(await hasTableOf(deps)('nivaro_hub_calendar_entries'))) return false
    const mod = await (deps.load ?? defaultLoader)('../changes/calendar.js')
    const fn = mod.removeCalendarEntry
    if (typeof fn !== 'function') return false
    await (fn as (s: string, k: string) => Promise<void>)(source, key)
    return true
  } catch {
    return false
  }
}

export interface IncidentRow {
  id: number
  app_id: number
  environment_id: number | null
  title: string
  severity: string
  status: string
  opened_at: string | null
  resolved_at: string | null
}

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

/** The app's incidents opened since `since` (compliance pack); [] without the incidents table. */
export async function incidentsOf(
  appId: number,
  since: Date,
  deps: SeamDeps = {}
): Promise<IncidentRow[]> {
  try {
    if (!(await hasTableOf(deps)('nivaro_hub_incidents'))) return []
    const rows = (await db('nivaro_hub_incidents')
      .where({ app_id: appId })
      .where('opened_at', '>=', since)
      .orderBy('opened_at', 'desc')
      .limit(500)
      .select(
        'id',
        'app_id',
        'environment_id',
        'title',
        'severity',
        'status',
        'opened_at',
        'resolved_at'
      )) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: Number(r.id),
      app_id: Number(r.app_id),
      environment_id: r.environment_id == null ? null : Number(r.environment_id),
      title: String(r.title ?? '').slice(0, 200),
      severity: String(r.severity ?? ''),
      status: String(r.status ?? ''),
      opened_at: iso(r.opened_at),
      resolved_at: iso(r.resolved_at)
    }))
  } catch {
    return []
  }
}

/**
 * The open incident of the app during which `userId` is on call (break-glass self-approval), or
 * null. Needs the incident feature (its tables and its rota module); anything missing or odd
 * answers null, so self-approval stays closed.
 */
export async function onCallIncident(
  appId: number,
  userId: string,
  deps: SeamDeps & { nowMs?: number } = {}
): Promise<{ incident_id: number } | null> {
  try {
    const has = hasTableOf(deps)
    if (!(await has('nivaro_hub_incidents')) || !(await has('nivaro_hub_oncall_rotas'))) return null
    const open = (await db('nivaro_hub_incidents')
      .where({ app_id: appId, status: 'open' })
      .orderBy('opened_at', 'desc')
      .first('id')) as { id: unknown } | undefined
    if (!open) return null
    const load = deps.load ?? defaultLoader
    const store = await load('../incident/store.js')
    const rota = await load('../incident/rota.js')
    const readRota = store.readRota as ((id: number) => Promise<unknown>) | undefined
    const listOverrides = store.listOverrides as ((id: number) => Promise<unknown[]>) | undefined
    const onCallAt = rota.onCallAt as
      | ((r: unknown, o: unknown[], now: number) => { user_id?: unknown })
      | undefined
    if (
      typeof readRota !== 'function' ||
      typeof listOverrides !== 'function' ||
      typeof onCallAt !== 'function'
    )
      return null
    const who = onCallAt(await readRota(appId), await listOverrides(appId), deps.nowMs ?? Date.now())
    const onCall = typeof who?.user_id === 'string' ? who.user_id : null
    if (!onCall || onCall.toUpperCase() !== userId.toUpperCase()) return null
    return { incident_id: Number(open.id) }
  } catch {
    return null
  }
}
