import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { runInBackgroundPool } from '../../../db/pool-context.js'
import { getApp } from '../../io-holder.js'
import { contextFor, openConnection, regionFor } from './engine/plan.js'
import { type HubResourceRow, readResource } from './store.js'
import type { NotifySeverity, OutboundMessage } from './types.js'

/**
 * Hub providers, Wave 2 framework (Task 13): Hub events going OUT through a sending resource (a
 * Slack channel, a Teams webhook, a PagerDuty service, a SendGrid sender, a Twilio number). A
 * notify route maps events to one resource, for the whole Hub (admins) or one app (its owners or
 * admins). `notifyHub(event, payload)` is the one call the deploy / incident / approval / drift /
 * backup / certificate code makes: it never throws and never waits — the sends run in the
 * background pool, side by side, each at most 10 s, and the outcome lands on the route
 * (last_sent_at, or last_error + last_error_at, scrubbed by the connection's own scrub).
 *
 * This is NOT the in-app notice path (services/hub/notify-events.ts → notifyUser): that one tells
 * people inside the Hub; this one tells a channel outside it. Both may fire for one event.
 */

export const NOTIFY_ROUTES = 'nivaro_hub_notify_routes'

export type HubNotifyEvent =
  | 'deploy.started'
  | 'deploy.finished'
  | 'deploy.failed'
  | 'incident.opened'
  | 'incident.resolved'
  | 'approval.needed'
  | 'drift.found'
  | 'backup.failed'
  | 'cert.expiring'
  | 'domain.expiring'
  | 'cost.over_budget'

export const HUB_NOTIFY_EVENTS: readonly HubNotifyEvent[] = [
  'deploy.started',
  'deploy.finished',
  'deploy.failed',
  'incident.opened',
  'incident.resolved',
  'approval.needed',
  'drift.found',
  'backup.failed',
  'cert.expiring',
  'domain.expiring',
  'cost.over_budget'
]

export const NOTIFY_EVENT_LABELS: Record<HubNotifyEvent, string> = {
  'deploy.started': 'Deploy started',
  'deploy.finished': 'Deploy finished',
  'deploy.failed': 'Deploy failed',
  'incident.opened': 'Incident opened',
  'incident.resolved': 'Incident resolved',
  'approval.needed': 'Approval needed',
  'drift.found': 'Drift found',
  'backup.failed': 'Backup failed',
  'cert.expiring': 'Certificate expiring',
  'domain.expiring': 'Domain expiring',
  'cost.over_budget': 'Over budget'
}

const SEVERITY: Record<HubNotifyEvent, NotifySeverity> = {
  'deploy.started': 'info',
  'deploy.finished': 'info',
  'deploy.failed': 'critical',
  'incident.opened': 'critical',
  'incident.resolved': 'info',
  'approval.needed': 'warning',
  'drift.found': 'warning',
  'backup.failed': 'critical',
  'cert.expiring': 'warning',
  'domain.expiring': 'warning',
  'cost.over_budget': 'warning'
}

export interface HubNotifyPayload {
  /** The app; looked up from envId when only the environment is known. */
  appId?: number | null
  envId?: number | null
  /** Short text after the standard title ("0.3.215 on staging"). */
  detail?: string | null
  /** Replaces the standard title / body. */
  title?: string
  body?: string
  /** In-Hub path (`/hub/incidents?incident=4`) or an absolute URL. */
  link?: string
  severity?: NotifySeverity
  /** Same key = the same item at the provider (incident:4). */
  dedupKey?: string
  action?: OutboundMessage['action']
}

export type NotifyScope = 'hub' | 'app'

export interface NotifyRouteRow {
  id: number
  name: string | null
  scope: NotifyScope
  app_id: number | null
  events: HubNotifyEvent[]
  resource_id: number
  enabled: boolean
  last_sent_at: string | null
  last_error_at: string | null
  last_error: string | null
  created_by: string | null
  created_at: string | null
  updated_at: string | null
}

export class NotifyRouteError extends Error {
  code: string
  status: number
  constructor(code: string, status: number, message: string) {
    super(message)
    this.name = 'NotifyRouteError'
    this.code = code
    this.status = status
  }
}

// Hub-only (HUB=on, never a shared deployment): the send timeout tests shorten.
let seams = { timeoutMs: 10_000 }

/** Tests: a shorter send timeout (null = back to 10 s). */
export function configureNotifyForTest(over: Partial<typeof seams> | null): void {
  seams = over ? { ...seams, ...over } : { timeoutMs: 10_000 }
}

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const t =
    v instanceof Date
      ? v.getTime()
      : typeof v === 'number' || /^\d{12,}$/.test(String(v))
        ? Number(v)
        : Date.parse(String(v))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

function eventsOf(raw: unknown): HubNotifyEvent[] {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      v = []
    }
  }
  return Array.isArray(v)
    ? v.filter((e): e is HubNotifyEvent => HUB_NOTIFY_EVENTS.includes(e as HubNotifyEvent))
    : []
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1'

function routeOf(r: Record<string, unknown>): NotifyRouteRow {
  return {
    id: Number(r.id),
    name: r.name == null ? null : String(r.name),
    scope: r.scope === 'app' ? 'app' : 'hub',
    app_id: r.app_id == null ? null : Number(r.app_id),
    events: eventsOf(r.events),
    resource_id: Number(r.resource_id),
    enabled: truthy(r.enabled),
    last_sent_at: iso(r.last_sent_at),
    last_error_at: iso(r.last_error_at),
    last_error: r.last_error == null ? null : String(r.last_error),
    created_by: r.created_by == null ? null : String(r.created_by),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at)
  }
}

// ── Routes (the rows) ──

export async function listNotifyRoutes(
  filter: { appIds?: number[]; resourceId?: number } = {}
): Promise<NotifyRouteRow[]> {
  const q = db(NOTIFY_ROUTES).select('*').orderBy('id', 'asc')
  if (filter.appIds) {
    if (!filter.appIds.length) return []
    q.where('scope', 'app').whereIn('app_id', filter.appIds)
  }
  if (filter.resourceId !== undefined) q.where('resource_id', filter.resourceId)
  return ((await q) as Array<Record<string, unknown>>).map(routeOf)
}

export async function readNotifyRoute(id: number): Promise<NotifyRouteRow | null> {
  const r = (await db(NOTIFY_ROUTES).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? routeOf(r) : null
}

export interface NotifyRouteInput {
  name?: string | null
  scope: NotifyScope
  appId: number | null
  events: string[]
  resourceId: number
  enabled?: boolean
}

/** Whether a resource can send (its adapter has notify, it exists at the provider). */
async function sender(resourceId: number): Promise<HubResourceRow | null> {
  const row = await readResource(resourceId)
  if (!row || row.deleted_at || !row.external_id) return null
  try {
    const { ensureCoreProviders, getProvider } = await import('./index.js')
    ensureCoreProviders()
    const adapter = getProvider(row.provider)
    const type = adapter?.types.find((t) => t.key === row.type)
    return adapter?.notify && type?.sends === true ? row : null
  } catch {
    return null
  }
}

/**
 * Checks a route (who may make it, which resource may send it). Admins: any scope, any sending
 * resource. Owners: scope app, an app they own, a sending resource of that same app.
 */
async function judgeRoute(
  input: NotifyRouteInput,
  actor: { id: string; isAdmin: boolean }
): Promise<{ events: HubNotifyEvent[] }> {
  const events = [...new Set(input.events)]
  if (!events.length || events.some((e) => !HUB_NOTIFY_EVENTS.includes(e as HubNotifyEvent)))
    throw new NotifyRouteError(
      'INVALID_FIELDS',
      400,
      `events must list one or more of ${HUB_NOTIFY_EVENTS.join(', ')}.`
    )
  if (input.scope !== 'hub' && input.scope !== 'app')
    throw new NotifyRouteError('INVALID_FIELDS', 400, 'scope must be hub or app.')
  if (input.scope === 'hub') {
    if (!actor.isAdmin)
      throw new NotifyRouteError(
        'ADMIN_ONLY',
        403,
        'Hub-wide routes are set by Hub administrators.'
      )
    if (input.appId != null)
      throw new NotifyRouteError('INVALID_FIELDS', 400, 'A Hub-wide route names no app.')
  } else {
    if (input.appId == null)
      throw new NotifyRouteError('INVALID_FIELDS', 400, 'An app route needs the app.')
    const app = await db('nivaro_hub_apps').where({ id: input.appId }).first('id')
    if (!app) throw new NotifyRouteError('NOT_FOUND', 404, 'No such app.')
    if (!actor.isAdmin) {
      const own = await db('nivaro_hub_app_owners')
        .where({ app_id: input.appId, user_id: actor.id })
        .first('id')
      if (!own) throw new NotifyRouteError('NOT_FOUND', 404, 'No such app.')
    }
  }
  const res = await sender(input.resourceId)
  if (!res)
    throw new NotifyRouteError(
      'NOT_A_SENDER',
      400,
      'That resource cannot send messages (not a sending type, or not created yet).'
    )
  if (!actor.isAdmin && (res.scope !== 'app' || res.app_id !== input.appId))
    throw new NotifyRouteError(
      'NOT_A_SENDER',
      400,
      'Owners send through a resource of their own app only.'
    )
  if (input.name != null && String(input.name).length > 120)
    throw new NotifyRouteError('INVALID_FIELDS', 400, 'name is at most 120 characters.')
  return { events: events as HubNotifyEvent[] }
}

export async function createNotifyRoute(
  input: NotifyRouteInput,
  actor: { id: string; isAdmin: boolean }
): Promise<NotifyRouteRow> {
  const { events } = await judgeRoute(input, actor)
  const now = new Date()
  const id = await insertReturningId(db, NOTIFY_ROUTES, {
    name: input.name?.trim() || null,
    scope: input.scope,
    app_id: input.scope === 'app' ? input.appId : null,
    events: JSON.stringify(events),
    resource_id: input.resourceId,
    enabled: input.enabled !== false,
    created_by: actor.id || null,
    created_at: now,
    updated_at: now
  })
  return (await readNotifyRoute(Number(id))) as NotifyRouteRow
}

/** Whether the actor may change (or test, or delete) this route. */
export async function mayEditRoute(
  route: NotifyRouteRow,
  actor: { id: string; isAdmin: boolean }
): Promise<boolean> {
  if (actor.isAdmin) return true
  if (route.scope !== 'app' || route.app_id == null) return false
  return !!(await db('nivaro_hub_app_owners')
    .where({ app_id: route.app_id, user_id: actor.id })
    .first('id'))
}

export async function updateNotifyRoute(
  route: NotifyRouteRow,
  patch: Partial<NotifyRouteInput>,
  actor: { id: string; isAdmin: boolean }
): Promise<NotifyRouteRow> {
  const next: NotifyRouteInput = {
    name: patch.name !== undefined ? patch.name : route.name,
    scope: patch.scope ?? route.scope,
    appId: patch.appId !== undefined ? patch.appId : route.app_id,
    events: patch.events ?? route.events,
    resourceId: patch.resourceId ?? route.resource_id,
    enabled: patch.enabled ?? route.enabled
  }
  const { events } = await judgeRoute(next, actor)
  await db(NOTIFY_ROUTES)
    .where({ id: route.id })
    .update({
      name: next.name?.trim() || null,
      scope: next.scope,
      app_id: next.scope === 'app' ? next.appId : null,
      events: JSON.stringify(events),
      resource_id: next.resourceId,
      enabled: next.enabled !== false,
      updated_at: new Date()
    })
  return (await readNotifyRoute(route.id)) as NotifyRouteRow
}

export async function deleteNotifyRoute(id: number): Promise<void> {
  await db(NOTIFY_ROUTES).where({ id }).del()
}

// ── Sending ──

export interface SendOutcome {
  routeId: number
  ok: boolean
  code?: string
  error?: string
}

async function names(p: HubNotifyPayload): Promise<{
  appId: number | null
  app: string | null
  env: string | null
}> {
  let appId = p.appId ?? null
  let env: string | null = null
  if (p.envId != null) {
    const e = (await db('nivaro_hub_environments').where({ id: p.envId }).first('app_id', 'key')) as
      | { app_id: number; key: string }
      | undefined
    if (e) {
      env = String(e.key)
      if (appId == null) appId = Number(e.app_id)
    }
  }
  const a =
    appId == null
      ? undefined
      : ((await db('nivaro_hub_apps').where({ id: appId }).first('key', 'name')) as
          | { key: string; name: string | null }
          | undefined)
  return { appId, app: a ? String(a.name || a.key) : null, env }
}

async function absolute(link: string | undefined): Promise<string | undefined> {
  if (!link) return undefined
  if (/^https:\/\//i.test(link)) return link
  if (!link.startsWith('/')) return undefined
  try {
    const base = (await import('../../../admin-base.js')).adminBaseUrl() ?? ''
    return base ? `${base.replace(/\/+$/, '')}${link}` : undefined
  } catch {
    return undefined
  }
}

/** The message one event makes (pure apart from the names it was given). */
export function messageFor(
  event: HubNotifyEvent,
  p: HubNotifyPayload,
  where: { app: string | null; env: string | null },
  link?: string
): OutboundMessage {
  const place = where.app ? (where.env ? `${where.app} · ${where.env}` : where.app) : 'the Hub'
  const d = p.detail ? ` — ${p.detail}` : ''
  return {
    kind: 'text',
    title: (p.title ?? `${NOTIFY_EVENT_LABELS[event]}: ${place}`).slice(0, 200),
    body: (p.body ?? `${NOTIFY_EVENT_LABELS[event]} on ${place}${d}.`).slice(0, 2000),
    severity: p.severity ?? SEVERITY[event],
    ...(link ? { link } : {}),
    ...(p.dedupKey ? { dedupKey: p.dedupKey.slice(0, 200) } : {}),
    ...(p.action ? { action: p.action } : {})
  }
}

/** One send through one route's resource, at most the send timeout; the outcome lands on the route. */
export async function sendToRoute(
  route: NotifyRouteRow,
  msg: OutboundMessage
): Promise<SendOutcome> {
  const ctl = new AbortController()
  let timer: NodeJS.Timeout | undefined
  let scrub = (t: string) => t
  const done = async (out: SendOutcome): Promise<SendOutcome> => {
    const error = out.error ? scrub(out.error).slice(0, 1000) : undefined
    await db(NOTIFY_ROUTES)
      .where({ id: route.id })
      .update(
        out.ok
          ? { last_sent_at: new Date(), last_error: null, updated_at: new Date() }
          : { last_error: error ?? 'Not sent.', last_error_at: new Date(), updated_at: new Date() }
      )
      .catch(() => undefined)
    return { ...out, ...(error ? { error } : {}) }
  }
  try {
    const res = await sender(route.resource_id)
    if (!res)
      return done({
        routeId: route.id,
        ok: false,
        code: 'NOT_A_SENDER',
        error: 'The resource of this route can no longer send messages.'
      })
    const conn = await openConnection(res.connection_id)
    const ctx = contextFor(conn, regionFor(conn.row.config, res.desired, res.observed), {
      signal: ctl.signal
    })
    scrub = ctx.scrub
    const send = conn.adapter.notify
    if (!send)
      return done({ routeId: route.id, ok: false, code: 'NOT_A_SENDER', error: 'Not a sender.' })
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        ctl.abort()
        resolve('timeout')
      }, seams.timeoutMs)
    })
    const answer = await Promise.race([send.call(conn.adapter, ctx, res, msg), timeout])
    if (answer === 'timeout')
      return done({
        routeId: route.id,
        ok: false,
        code: 'TIMEOUT',
        error: `The provider did not answer within ${Math.round(seams.timeoutMs / 1000)} s.`
      })
    if (!answer?.ok)
      return done({
        routeId: route.id,
        ok: false,
        code: answer?.error?.code ?? 'PROVIDER_ERROR',
        error: answer?.error?.message ?? 'The provider refused the message.'
      })
    return done({ routeId: route.id, ok: true })
  } catch (e) {
    const code =
      e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string'
        ? String((e as { code: string }).code)
        : 'PROVIDER_ERROR'
    return done({
      routeId: route.id,
      ok: false,
      code,
      error: e instanceof Error ? e.message : 'The message could not be sent.'
    })
  } finally {
    clearTimeout(timer)
  }
}

/** The enabled routes an event of this app goes to. */
export async function routesFor(
  event: HubNotifyEvent,
  appId: number | null
): Promise<NotifyRouteRow[]> {
  const q = db(NOTIFY_ROUTES)
    .where('enabled', true)
    .where((w) => {
      w.where('scope', 'hub')
      if (appId != null) w.orWhere((x) => x.where('scope', 'app').where('app_id', appId))
    })
    .select('*')
  const rows = ((await q) as Array<Record<string, unknown>>).map(routeOf)
  return rows.filter((r) => r.events.includes(event))
}

/** Every send of one event, side by side; answers each route's outcome (tests, the test button). */
export async function fanOut(
  event: HubNotifyEvent,
  payload: HubNotifyPayload
): Promise<SendOutcome[]> {
  const where = await names(payload)
  const routes = await routesFor(event, where.appId)
  if (!routes.length) return []
  const msg = messageFor(event, payload, where, await absolute(payload.link))
  return Promise.all(routes.map((r) => sendToRoute(r, msg)))
}

/**
 * THE call Hub code makes for an outbound event: never throws, never waits (the sends start on
 * the next tick in the background pool). Answers the background work's promise (never rejects)
 * for a caller that wants to wait on it (tests); Hub code calls it as `void notifyHub(…)`.
 */
export function notifyHub(
  event: HubNotifyEvent,
  payload: HubNotifyPayload = {}
): Promise<SendOutcome[]> {
  return new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => runInBackgroundPool(() => fanOut(event, payload)))
    .catch((err) => {
      getApp()?.log?.warn?.(
        { event, err: (err as Error | null)?.name ?? 'Error' },
        'hub notify fan-out failed'
      )
      return []
    })
}

/** A test message through one route now (the route's Test button): waits for the outcome. */
export async function testNotifyRoute(route: NotifyRouteRow): Promise<SendOutcome> {
  const where =
    route.app_id == null ? { app: null, env: null } : await names({ appId: route.app_id })
  const link = await absolute('/hub/connections')
  return sendToRoute(route, {
    kind: 'text',
    title: 'Test message from the Nivaro Hub',
    body: `This route sends ${route.events.map((e) => NOTIFY_EVENT_LABELS[e]).join(', ')} for ${where.app ?? 'every app'}.`,
    severity: 'info',
    ...(link ? { link } : {})
  })
}
