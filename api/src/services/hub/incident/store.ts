import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { appEnvironments, isProductionEnv, reportedEnvironment } from '../owner-access.js'
import { type Override, overrideFromRow, type Rota, rotaFromRow } from './rota.js'

/**
 * Hub incident tables (migration 576): incidents and their timeline, on-call rotas and
 * overrides, pages. Raw knex on the Hub's own tables only — never an app's data.
 */

export const INCIDENTS = 'nivaro_hub_incidents'
export const EVENTS = 'nivaro_hub_incident_events'
export const ROTAS = 'nivaro_hub_oncall_rotas'
export const OVERRIDES = 'nivaro_hub_oncall_overrides'
export const PAGES = 'nivaro_hub_pages'
export const STATUS_PAGES = 'nivaro_hub_status_pages'

export const SEVERITIES = ['sev1', 'sev2', 'sev3'] as const
export type Severity = (typeof SEVERITIES)[number]
export type IncidentStatus = 'open' | 'resolved'

export type EventKind =
  | 'opened'
  | 'note'
  | 'changed'
  | 'banner'
  | 'freeze'
  | 'page'
  | 'escalated'
  | 'acknowledged'
  | 'resolved'
  | 'postmortem'

export interface BannerEnvState {
  state: string
  at: string
  /** How many pushes failed in a row (retries stop after MAX_BANNER_TRIES). */
  tries?: number
}

export interface Incident {
  id: number
  app_id: number
  environment_id: number | null
  title: string
  severity: Severity
  status: IncidentStatus
  summary: string | null
  banner_text: string | null
  banner_tone: string | null
  banner_state: Record<string, BannerEnvState>
  banner_next_at: string | null
  freeze_id: number | null
  page_id: number | null
  opened_by: string | null
  opened_at: string
  acknowledged_by: string | null
  acknowledged_at: string | null
  resolved_by: string | null
  resolved_at: string | null
  postmortem: unknown
  postmortem_by: string | null
  postmortem_at: string | null
}

export interface IncidentEvent {
  id: number
  incident_id: number
  at: string
  kind: EventKind
  text: string | null
  user_id: string | null
}

export const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function jsonOf<T>(v: unknown, fallback: T): T {
  if (v == null || v === '') return fallback
  if (typeof v !== 'string') return v as T
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}

export function incidentFromRow(r: Record<string, unknown>): Incident {
  const sev = String(r.severity)
  return {
    id: Number(r.id),
    app_id: Number(r.app_id),
    environment_id: r.environment_id == null ? null : Number(r.environment_id),
    title: String(r.title ?? ''),
    severity: (SEVERITIES as readonly string[]).includes(sev) ? (sev as Severity) : 'sev2',
    status: r.status === 'resolved' ? 'resolved' : 'open',
    summary: (r.summary as string | null) ?? null,
    banner_text: (r.banner_text as string | null) ?? null,
    banner_tone: (r.banner_tone as string | null) ?? null,
    banner_state: jsonOf<Record<string, BannerEnvState>>(r.banner_state, {}),
    banner_next_at: iso(r.banner_next_at),
    freeze_id: r.freeze_id == null ? null : Number(r.freeze_id),
    page_id: r.page_id == null ? null : Number(r.page_id),
    opened_by: (r.opened_by as string | null) ?? null,
    opened_at: iso(r.opened_at) ?? '',
    acknowledged_by: (r.acknowledged_by as string | null) ?? null,
    acknowledged_at: iso(r.acknowledged_at),
    resolved_by: (r.resolved_by as string | null) ?? null,
    resolved_at: iso(r.resolved_at),
    postmortem: jsonOf<unknown>(r.postmortem, null),
    postmortem_by: (r.postmortem_by as string | null) ?? null,
    postmortem_at: iso(r.postmortem_at)
  }
}

export async function readIncident(id: number): Promise<Incident | null> {
  const r = (await db(INCIDENTS).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? incidentFromRow(r) : null
}

export async function listIncidents(o: {
  appIds: number[] | null
  status?: IncidentStatus
  limit?: number
}): Promise<Incident[]> {
  const q = db(INCIDENTS)
    .orderBy('id', 'desc')
    .limit(Math.min(o.limit ?? 100, 500))
  if (o.appIds) q.whereIn('app_id', o.appIds.length ? o.appIds : [-1])
  if (o.status) q.where({ status: o.status })
  return ((await q) as Array<Record<string, unknown>>).map(incidentFromRow)
}

export async function openIncidents(): Promise<Incident[]> {
  return listIncidents({ appIds: null, status: 'open', limit: 500 })
}

export async function patchIncident(id: number, patch: Record<string, unknown>): Promise<void> {
  const row: Record<string, unknown> = { ...patch, updated_at: new Date() }
  if ('banner_state' in row && typeof row.banner_state !== 'string')
    row.banner_state = JSON.stringify(row.banner_state ?? {})
  if ('postmortem' in row && row.postmortem != null && typeof row.postmortem !== 'string')
    row.postmortem = JSON.stringify(row.postmortem)
  await db(INCIDENTS).where({ id }).update(row)
}

export async function insertIncident(row: Record<string, unknown>): Promise<number> {
  return Number(
    await insertReturningId(db, INCIDENTS, {
      ...row,
      banner_state: JSON.stringify(row.banner_state ?? {}),
      updated_at: new Date()
    })
  )
}

export async function addEvent(
  incidentId: number,
  kind: EventKind,
  text: string | null,
  userId: string | null,
  at = new Date()
): Promise<void> {
  await db(EVENTS).insert({
    incident_id: incidentId,
    at,
    kind,
    text: text == null ? null : text.slice(0, 2000),
    user_id: userId || null
  })
}

export async function listEvents(incidentId: number): Promise<IncidentEvent[]> {
  const rows = (await db(EVENTS)
    .where({ incident_id: incidentId })
    .orderBy([
      { column: 'at', order: 'asc' },
      { column: 'id', order: 'asc' }
    ])
    .limit(2000)
    .select('*')) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: Number(r.id),
    incident_id: Number(r.incident_id),
    at: iso(r.at) ?? '',
    kind: String(r.kind) as EventKind,
    text: (r.text as string | null) ?? null,
    user_id: (r.user_id as string | null) ?? null
  }))
}

// ─── Rotas ──────────────────────────────────────────────────────────────────

export async function readRota(appId: number): Promise<Rota | null> {
  const r = (await db(ROTAS).where({ app_id: appId }).first()) as
    | Record<string, unknown>
    | undefined
  return r ? rotaFromRow(r) : null
}

export async function listRotas(appIds: number[] | null): Promise<Rota[]> {
  const q = db(ROTAS).orderBy('app_id', 'asc')
  if (appIds) q.whereIn('app_id', appIds.length ? appIds : [-1])
  return ((await q) as Array<Record<string, unknown>>).map(rotaFromRow)
}

/** Overrides of one app that have not ended by `now` (or every one from `since`). */
export async function listOverrides(appId: number, since = new Date()): Promise<Override[]> {
  const rows = (await db(OVERRIDES)
    .where({ app_id: appId })
    .where('ends_at', '>', since)
    .orderBy('starts_at', 'asc')
    .limit(200)) as Array<Record<string, unknown>>
  return rows.map(overrideFromRow)
}

// ─── People the escalation steps name ───────────────────────────────────────

/** An app's owners who are active Hub people (never machine accounts). */
export async function activeOwnerIds(appId: number): Promise<string[]> {
  const rows = (await db('nivaro_hub_app_owners as o')
    .join('nivaro_users as u', 'u.id', 'o.user_id')
    .where('o.app_id', appId)
    .where('u.status', 'active')
    .whereNull('u.account_kind')
    .select('u.id')) as Array<{ id: unknown }>
  return rows.map((r) => String(r.id))
}

/** Active Hub administrators (people, never machine accounts). */
export async function activeAdminIds(): Promise<string[]> {
  const rows = (await db('nivaro_users as u')
    .join('nivaro_roles as r', 'r.id', 'u.role')
    .where('r.admin_access', true)
    .where('u.status', 'active')
    .whereNull('u.account_kind')
    .limit(100)
    .select('u.id')) as Array<{ id: unknown }>
  return rows.map((r) => String(r.id))
}

/** Which of `ids` are active Hub accounts (people), upper-cased compare; answers the found ids. */
export async function activeAccounts(ids: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  if (!ids.length) return out
  const rows = (await db('nivaro_users')
    .whereIn('id', ids.slice(0, 200))
    .where('status', 'active')
    .whereNull('account_kind')
    .select('id')) as Array<{ id: unknown }>
  for (const r of rows) out.add(String(r.id).toUpperCase())
  return out
}

// ─── Environments ───────────────────────────────────────────────────────────

export interface EnvRow {
  id: number
  app_id: number
  key: string
  base_url: string
  hub_token: string | null
  placement_id: number | null
  status: string
}

export async function envRows(appId: number): Promise<EnvRow[]> {
  const rows = (await db('nivaro_hub_environments')
    .where({ app_id: appId })
    .orderBy([
      { column: 'position', order: 'asc' },
      { column: 'id', order: 'asc' }
    ])
    .select('id', 'app_id', 'key', 'base_url', 'hub_token', 'placement_id', 'status')) as Array<
    Record<string, unknown>
  >
  return rows.map((r) => ({
    id: Number(r.id),
    app_id: Number(r.app_id),
    key: String(r.key),
    base_url: String(r.base_url ?? ''),
    hub_token: (r.hub_token as string | null) ?? null,
    placement_id: r.placement_id == null ? null : Number(r.placement_id),
    status: String(r.status ?? '')
  }))
}

/**
 * The app's production environments by THE production rule (owner-access isProductionEnv, the
 * one helper the owner gate, the people lookup and the phone summary use). Archived ones are left
 * out (nothing runs there).
 */
export async function productionEnvIds(appId: number): Promise<number[]> {
  const list = await appEnvironments(appId)
  for (const e of list) e.reported = await reportedEnvironment(e.id).catch(() => null)
  return list
    .filter((e) => String(e.status ?? '').toLowerCase() !== 'archived')
    .filter((e) => isProductionEnv(e, list))
    .map((e) => e.id)
}
