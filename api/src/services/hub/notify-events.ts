import { db } from '../../db/index.js'
import { getApp } from '../io-holder.js'

/**
 * Nivaro Hub events → the people who look after the app, through the ONE notification path
 * (notifyUser: inbox row, socket, browser AND phone push via sendDevicePush, Profile →
 * Notification rules, quiet hours). Recipients: every active Hub administrator and the app's
 * owners (nivaro_hub_app_owners), each once. Category 'system'; a click opens the app's page in
 * the Hub (`/hub?app=<id>`), which the Nivaro phone app opens in its web view.
 *
 * Events (others wire theirs with one call):
 *   promote_done / promote_failed   a promotion, rollback or Apply now finished / failed
 *                                   (services/hub/promote-run.ts, after the closing write)
 *   auto_rollback                   the Hub rolled an environment back by itself
 *   uptime_down / uptime_up         an environment stopped / started answering
 *   drift                           a stack or pin no longer matches what the Hub recorded
 *
 * On-call (Hub enhancement 33): an URGENT event for an app with an enabled on-call rota goes to
 * the person on call first and escalates from there (services/hub/incident/paging.ts); an app
 * without a rota keeps the fan-out above.
 *
 * Never throws and never holds the caller: notifyHubEvent is fire-and-forget (`void`).
 * Hub only (hub mode is never multi-tenant), so no tenant context is needed.
 */

export type HubEventKind =
  | 'promote_done'
  | 'promote_failed'
  | 'auto_rollback'
  | 'uptime_down'
  | 'uptime_up'
  | 'drift'

export interface HubEvent {
  kind: HubEventKind
  /** The app; looked up from envId when only the environment is known. */
  appId?: number | null
  envId?: number | null
  /** Short text after the standard subject, e.g. "0.3.215 on staging". */
  detail?: string | null
  deployId?: number | null
  /** The producer's own words, instead of the standard subject + message for the kind. */
  text?: { subject: string; message: string } | null
  /** Overrides the kind's default (failures, rollbacks and outages are urgent). */
  urgent?: boolean
  /** Where a click goes instead of the app's page (e.g. `/hub/releases`). */
  path?: string
}

const URGENT: ReadonlySet<HubEventKind> = new Set([
  'promote_failed',
  'auto_rollback',
  'uptime_down'
])

/** Subject + message for an event. Pure. */
export function hubEventText(
  e: HubEvent,
  names: { app: string; env: string | null }
): { subject: string; message: string } {
  const where = names.env ? `${names.app} · ${names.env}` : names.app
  const d = e.detail ? ` — ${e.detail}` : ''
  switch (e.kind) {
    case 'promote_done':
      return { subject: `Deploy finished: ${where}`, message: `The deploy finished${d}.` }
    case 'promote_failed':
      return { subject: `Deploy failed: ${where}`, message: `The deploy did not finish${d}.` }
    case 'auto_rollback':
      return {
        subject: `Rolled back: ${where}`,
        message: `The Hub rolled this back by itself${d}.`
      }
    case 'uptime_down':
      return { subject: `Down: ${where}`, message: `The environment stopped answering${d}.` }
    case 'uptime_up':
      return { subject: `Back up: ${where}`, message: `The environment answers again${d}.` }
    case 'drift':
      return {
        subject: `Drift: ${where}`,
        message: `What runs no longer matches what the Hub recorded${d}.`
      }
  }
}

/** Active Hub admins + the app's active owners, each once (upper-cased compare). */
export async function hubEventRecipients(appId: number): Promise<string[]> {
  // Break-glass grantees are not Hub administrators (their admin access is borrowed).
  const { withoutLiveGrantees } = await import('../break-glass-grants.js')
  const admins = (await withoutLiveGrantees(
    db('nivaro_users as u')
      .join('nivaro_roles as r', 'r.id', 'u.role')
      .where('r.admin_access', true)
      .where('u.status', 'active')
      .whereNull('u.account_kind')
      .select('u.id')
  )) as Array<{ id: unknown }>
  const owners = (await db('nivaro_hub_app_owners as o')
    .join('nivaro_users as u', 'u.id', 'o.user_id')
    .where('o.app_id', appId)
    .where('u.status', 'active')
    .select('u.id')) as Array<{ id: unknown }>
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of [...admins, ...owners]) {
    const id = String(r.id)
    if (seen.has(id.toUpperCase())) continue
    seen.add(id.toUpperCase())
    out.push(id)
  }
  return out
}

export interface OnCallPage {
  appId: number
  envId: number | null
  kind: string
  subject: string
  message: string
  path: string
}

export interface NotifyDeps {
  notify?: (userId: string, opts: Record<string, unknown>) => Promise<unknown>
  adminBase?: () => string
  /**
   * The on-call route for an URGENT event (services/hub/incident/paging.ts routeToOnCall):
   * answers how many people were paged, or null when the app has no on-call rota (then the
   * event goes to admins + owners as before). Default: that route — except when `notify` is
   * injected (a test or a one-off sender), which keeps the plain fan-out. null = off.
   */
  page?: ((p: OnCallPage) => Promise<number | null>) | null
}

async function defaultOnCall(p: OnCallPage): Promise<number | null> {
  const { routeToOnCall } = await import('./incident/paging.js')
  return routeToOnCall(p)
}

export interface HubNotice {
  subject: string
  message: string
  /** In-app path the notice opens (`/hub?app=3`, `/hub/releases`). */
  path: string
  urgent?: boolean
  source: { kind: string; label?: string | null; id?: string | number | null }
  why: string
  /** Default 'system' (a report may use 'reports'). */
  category?: 'system' | 'reports'
  /** Also by email (the person's rules still decide). */
  email?: boolean
  /** What a click offers (default open). */
  action?: 'review'
}

/**
 * THE delivery of every Hub notice (events here, release operations, ops warnings): each person
 * once (case-insensitive ids), through notifyUser — inbox, socket, browser and phone push, their
 * Profile → Notification rules — category `system`, an `external` target on the admin origin.
 * Never throws; answers how many were handed to notifyUser.
 */
export async function deliverHubNotice(
  userIds: Array<string | null | undefined>,
  notice: HubNotice,
  deps: NotifyDeps = {}
): Promise<number> {
  const notify =
    deps.notify ??
    (async (userId: string, opts: Record<string, unknown>) => {
      const fastify = getApp()
      if (!fastify) return null
      const { notifyUser } = await import('../notification-channels.js')
      return notifyUser(fastify, userId, opts as never)
    })
  let base = ''
  try {
    base = deps.adminBase
      ? deps.adminBase()
      : ((await import('../../admin-base.js')).adminBaseUrl() ?? '')
  } catch {
    base = ''
  }
  const url = /^https?:\/\//i.test(notice.path)
    ? notice.path
    : `${base.replace(/\/+$/, '')}${notice.path.startsWith('/') ? '' : '/'}${notice.path}`
  const seen = new Set<string>()
  let n = 0
  for (const raw of userIds) {
    if (typeof raw !== 'string' || !raw) continue
    if (seen.has(raw.toUpperCase())) continue
    seen.add(raw.toUpperCase())
    try {
      await notify(raw, {
        subject: notice.subject.slice(0, 200),
        message: notice.message.slice(0, 1000),
        category: notice.category ?? 'system',
        ...(notice.urgent ? { urgent: true } : { lane: 'fyi' }),
        ...(notice.email ? { channels: { inapp: true, email: true } } : {}),
        target: { kind: 'external', url, ...(notice.action ? { action: notice.action } : {}) },
        source: notice.source,
        why: notice.why
      })
      n++
    } catch {
      // One person's delivery never stops the others.
    }
  }
  return n
}

/** Sends one event to everyone who looks after the app. Answers how many were asked. */
export async function sendHubEvent(e: HubEvent, deps: NotifyDeps = {}): Promise<number> {
  try {
    let appId = e.appId ?? null
    if (appId == null && e.envId != null) {
      const row = (await db('nivaro_hub_environments').where({ id: e.envId }).first('app_id')) as
        | { app_id: number }
        | undefined
      appId = row ? Number(row.app_id) : null
    }
    if (appId == null) return 0
    const app = (await db('nivaro_hub_apps').where({ id: appId }).first('id', 'key', 'name')) as
      | { id: number; key: string; name: string }
      | undefined
    if (!app) return 0
    const env =
      e.envId == null
        ? undefined
        : ((await db('nivaro_hub_environments').where({ id: e.envId }).first('key')) as
            | { key: string }
            | undefined)
    const text =
      e.text ?? hubEventText(e, { app: String(app.name || app.key), env: env?.key ?? null })
    const urgent = e.urgent ?? URGENT.has(e.kind)
    // Urgent: the person on call first, when the app has an on-call rota (Hub enhancement 33).
    const page = deps.page !== undefined ? deps.page : deps.notify ? null : defaultOnCall
    if (urgent && page) {
      const paged = await page({
        appId: Number(app.id),
        envId: e.envId ?? null,
        kind: e.kind,
        subject: text.subject,
        message: text.message,
        path: e.path ?? `/hub?app=${Number(app.id)}`
      }).catch(() => null)
      if (paged != null) return paged
    }
    return await deliverHubNotice(
      await hubEventRecipients(Number(app.id)),
      {
        subject: text.subject,
        message: text.message,
        path: e.path ?? `/hub?app=${Number(app.id)}`,
        urgent,
        source: { kind: 'hub', label: e.kind, id: e.deployId ?? e.envId ?? appId },
        why: 'You are a Hub administrator or an owner of this app.'
      },
      deps
    )
  } catch {
    return 0
  }
}

/** Fire-and-forget: never throws, never waits. */
export function notifyHubEvent(e: HubEvent, deps: NotifyDeps = {}): void {
  void sendHubEvent(e, deps).catch(() => 0)
}
