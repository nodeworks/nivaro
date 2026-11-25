import { db } from '../../../db/index.js'
import { removeCalendarEntry, upsertCalendarEntry } from '../changes/calendar.js'
import { onCallAt } from '../incident/rota.js'
import { INCIDENTS, listOverrides, OVERRIDES, readRota } from '../incident/store.js'

/**
 * Where Hub security meets the Hub features built beside it: the change calendar
 * (services/hub/changes/calendar.ts) for certificate expiries, and incidents + on-call
 * (services/hub/incident/*) for the compliance pack and break-glass self-approval.
 */

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

/** Puts one change-calendar entry. Never throws (a calendar write never stops the watch). */
export async function putCalendarEntry(e: CalendarEntry): Promise<boolean> {
  try {
    await upsertCalendarEntry(e)
    return true
  } catch {
    return false
  }
}

/** Takes one entry off the calendar (the name is gone). Never throws. */
export async function dropCalendarEntry(source: string, key: string): Promise<boolean> {
  try {
    await removeCalendarEntry(source, key)
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

/** The app's incidents opened since `since` (compliance pack). */
export async function incidentsOf(appId: number, since: Date): Promise<IncidentRow[]> {
  const rows = (await db(INCIDENTS)
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
}

/** Severities during which the person on call may approve their own break-glass. */
export const SELF_APPROVAL_SEVERITIES = ['sev1', 'sev2'] as const
/** An override this young does not make anyone "on call" for self-approval. */
export const OVERRIDE_SETTLE_MS = 24 * 3_600_000

const upper = (v: unknown) => String(v ?? '').toUpperCase()

/**
 * The open incident during which `userId` may approve their own break-glass for this app, or
 * null (ruling M5). All must hold:
 *  - an OPEN incident of the app with severity SEV 1 or SEV 2, opened by someone else;
 *  - `userId` is on call by the rota schedule — overrides created in the last 24 hours do not
 *    count (an override made now cannot put its maker on call to approve themselves).
 * Any read error answers null (self-approval stays closed).
 */
export async function onCallIncident(
  appId: number,
  userId: string,
  deps: { nowMs?: number } = {}
): Promise<{ incident_id: number; severity: string } | null> {
  try {
    const now = deps.nowMs ?? Date.now()
    const open = (await db(INCIDENTS)
      .where({ app_id: appId, status: 'open' })
      .whereIn('severity', [...SELF_APPROVAL_SEVERITIES])
      .orderBy('opened_at', 'desc')
      .select('id', 'severity', 'opened_by')) as Array<{
      id: unknown
      severity: unknown
      opened_by: unknown
    }>
    const theirs = open.find((i) => i.opened_by == null || upper(i.opened_by) !== upper(userId))
    if (!theirs) return null
    const rota = await readRota(appId)
    if (!rota) return null
    const settled = new Date(now - OVERRIDE_SETTLE_MS)
    const fresh = new Set(
      (
        (await db(OVERRIDES)
          .where({ app_id: appId })
          .where('created_at', '>', settled)
          .select('id')) as Array<{ id: unknown }>
      ).map((r) => Number(r.id))
    )
    const overrides = (await listOverrides(appId, new Date(now))).filter((o) => !fresh.has(o.id))
    const who = onCallAt(rota, overrides, now)
    if (!who.user_id || upper(who.user_id) !== upper(userId)) return null
    return { incident_id: Number(theirs.id), severity: String(theirs.severity) }
  } catch {
    return null
  }
}

/** Whether the incident a self-approved grant rides on is still open (false = end the grant). */
export async function incidentStillOpen(incidentId: number): Promise<boolean> {
  try {
    const r = (await db(INCIDENTS).where({ id: incidentId }).first('status')) as
      | { status: unknown }
      | undefined
    return r?.status === 'open'
  } catch {
    // Unreadable: keep it; the hours cap still ends it.
    return true
  }
}
