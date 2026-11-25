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
  const admins = (await db('nivaro_users as u')
    .join('nivaro_roles as r', 'r.id', 'u.role')
    .where('r.admin_access', true)
    .where('u.status', 'active')
    .whereNull('u.account_kind')
    .select('u.id')) as Array<{ id: unknown }>
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

export interface NotifyDeps {
  notify?: (userId: string, opts: Record<string, unknown>) => Promise<unknown>
  adminBase?: () => string
}

/** Sends one event to everyone who looks after the app. Answers how many were asked. */
export async function sendHubEvent(e: HubEvent, deps: NotifyDeps = {}): Promise<number> {
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
  const text = hubEventText(e, { app: String(app.name || app.key), env: env?.key ?? null })
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
  const url = `${base.replace(/\/+$/, '')}/hub?app=${Number(app.id)}`
  const people = await hubEventRecipients(Number(app.id))
  for (const userId of people) {
    await notify(userId, {
      subject: text.subject,
      message: text.message,
      category: 'system',
      urgent: URGENT.has(e.kind),
      ...(URGENT.has(e.kind) ? {} : { lane: 'fyi' }),
      target: { kind: 'external', url },
      source: { kind: 'hub', label: e.kind, id: e.deployId ?? e.envId ?? appId },
      why: 'You are a Hub administrator or an owner of this app.'
    }).catch(() => null)
  }
  return people.length
}

/** Fire-and-forget: never throws, never waits. */
export function notifyHubEvent(e: HubEvent, deps: NotifyDeps = {}): void {
  void sendHubEvent(e, deps).catch(() => 0)
}
