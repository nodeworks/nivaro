import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { getApp } from './io-holder.js'
import { notifyUser } from './notification-channels.js'

/**
 * Login-event capture. Called from every successful sign-in path; a sign-in
 * from an IP unseen for this user in 90 days is flagged and the USER is
 * notified ("new sign-in from …") — the cheap, honest tier of unusual-login
 * detection. Best-effort: auth must never fail because bookkeeping did.
 */
export async function recordLogin(
  app: FastifyInstance | null,
  userId: string,
  method: 'oidc' | 'password' | 'saml' | 'masquerade' | 'static_token',
  req: FastifyRequest
): Promise<void> {
  try {
    const ip = String(req.headers['x-forwarded-for'] ?? req.ip ?? '')
      .split(',')[0]
      .trim()
      .slice(0, 100)
    const agent = String(req.headers['user-agent'] ?? '').slice(0, 500)
    let newIp = false
    if (ip) {
      const seen = await db('nivaro_login_events')
        .where('user', userId)
        .where('ip', ip)
        .where('created_at', '>=', new Date(Date.now() - 90 * 86_400_000))
        .first('id')
      newIp = !seen
    }
    const inserted = (await db('nivaro_login_events')
      .insert({
        user: userId,
        method,
        ip: ip || null,
        user_agent: agent || null,
        new_ip: newIp,
        created_at: new Date()
      })
      .returning('id')) as Array<{ id: number } | number>
    const eventId = typeof inserted[0] === 'object' ? inserted[0]?.id : inserted[0]
    // Masquerade "logins" are an admin acting deliberately — notifying the
    // target that "you" signed in would be confusing, not protective.
    if (newIp && app && method !== 'masquerade') {
      const priorLogins = await db('nivaro_login_events')
        .where('user', userId)
        .count({ c: '*' })
        .first()
      // A user's very FIRST login is always a new IP — don't greet them with
      // a security alert.
      if (Number((priorLogins as { c?: number } | undefined)?.c ?? 0) > 1) {
        const { buildSignInMail } = await import('./mail-builders.js')
        const built =
          eventId != null ? await buildSignInMail(eventId, userId).catch(() => null) : null
        await notifyUser(app, userId, {
          subject: 'New sign-in to your account',
          category: 'system',
          message: `A sign-in from a new location (${ip || 'unknown IP'}) just occurred. If this was you, no action is needed — otherwise contact an administrator.`,
          ...(built ? { template: built.template, template_data: built.data } : {})
        }).catch(() => {})
      }
    }
  } catch {
    // never block auth
  }
}

/** Maintenance-mode flag, cached 15s — read on every write request. */
export type MaintenanceDisplay = 'banner' | 'page'

/** What the freeze means for the person reading the STRIP: exempt admins, and
 *  any client that only knows the banner (it can still browse). Reused by the
 *  write refusal — the caller who hit it was, by definition, still reading. */
export const MAINTENANCE_EXPLAINER =
  'You can keep reading and browsing, but saving changes is paused until maintenance ends. Anything you saved earlier is unaffected.'

/** What the freeze means on the FULL PAGE, where nothing can be browsed. */
export const MAINTENANCE_PAGE_EXPLAINER =
  'The portal is unavailable until maintenance ends. Anything you saved earlier is safe and will be here when it is back.'

export function maintenanceExplainer(display: MaintenanceDisplay): string {
  return display === 'page' ? MAINTENANCE_PAGE_EXPLAINER : MAINTENANCE_EXPLAINER
}

export const MAINTENANCE_DEFAULT_MESSAGE = 'Maintenance in progress.'

export interface MaintenanceState {
  on: boolean
  message: string | null
  /** How non-exempt people see the freeze: a strip above the app, or a page
   *  that replaces it. Admins always get the strip — they stay exempt. */
  display: MaintenanceDisplay
  /** When the freeze is expected to lift (ISO), or null when nobody said. */
  until: string | null
  /** 'settings' = the nivaro_settings row; 'override' = the Redis flag an
   *  operator or a rebuild job set (`MAINTENANCE_OVERRIDE_KEY`), which wins
   *  while present — it is the one thing that survives a database restore. */
  source: 'settings' | 'override'
}

/**
 * Redis key holding an out-of-band maintenance flag: JSON
 * `{on, message?, display?, until?, set_by?}`. A rebuild that restores
 * production over the database (wiping nivaro_settings) or copies another
 * instance's settings over it cannot keep a flag in the database — the
 * golive chain sets this key in the API's own Redis instead, and clears it
 * when it finishes. An admin's "End maintenance" clears it too.
 */
export const MAINTENANCE_OVERRIDE_KEY = 'nvr:maintenance'

let maintCache: ({ at: number } & MaintenanceState) | null = null

export function bustMaintenanceCache(): void {
  maintCache = null
}

// The ioredis client off the app holder, best-effort — null before boot.
function redisClient(): any {
  try {
    return getApp()?.redis ?? null
  } catch {
    return null
  }
}

async function readOverride(): Promise<Omit<MaintenanceState, 'source'> | null> {
  const redis = redisClient()
  if (!redis) return null
  try {
    const raw = (await redis.get(MAINTENANCE_OVERRIDE_KEY)) as string | null
    if (!raw) return null
    const j = JSON.parse(raw) as {
      on?: unknown
      message?: unknown
      display?: unknown
      until?: unknown
    }
    if (j?.on !== true) return null
    const until = typeof j.until === 'string' && j.until ? new Date(j.until) : null
    return {
      on: true,
      message: typeof j.message === 'string' && j.message.trim() ? j.message.trim() : null,
      display: normalizeMaintenanceDisplay(j.display),
      until: until && !Number.isNaN(until.getTime()) ? until.toISOString() : null
    }
  } catch {
    return null
  }
}

/** Remove the out-of-band flag (an admin ending maintenance, a finished rebuild). */
export async function clearMaintenanceOverride(): Promise<void> {
  const redis = redisClient()
  if (!redis) return
  try {
    await redis.del(MAINTENANCE_OVERRIDE_KEY)
  } catch {
    /* best-effort */
  }
  bustMaintenanceCache()
}

export function normalizeMaintenanceDisplay(v: unknown): MaintenanceDisplay {
  return v === 'page' ? 'page' : 'banner'
}

export async function maintenanceState(): Promise<MaintenanceState> {
  if (!maintCache || Date.now() - maintCache.at > 15_000) {
    const override = await readOverride()
    if (override) {
      maintCache = { at: Date.now(), ...override, source: 'override' }
      const { at: _o, ...state } = maintCache
      return state
    }
    try {
      const row = (await db('nivaro_settings')
        .where({ id: 1 })
        .first(
          'maintenance_mode',
          'maintenance_message',
          'maintenance_display',
          'maintenance_until'
        )
        // A tenant behind migration 405 has no display/until columns yet —
        // the freeze itself must keep working, so fall back to the two
        // columns every database has.
        .catch(() =>
          db('nivaro_settings').where({ id: 1 }).first('maintenance_mode', 'maintenance_message')
        )) as
        | {
            maintenance_mode?: boolean
            maintenance_message?: string | null
            maintenance_display?: string | null
            maintenance_until?: Date | string | null
          }
        | undefined
      const until = row?.maintenance_until ? new Date(row.maintenance_until) : null
      maintCache = {
        at: Date.now(),
        on: !!row?.maintenance_mode,
        message: row?.maintenance_message ?? null,
        display: normalizeMaintenanceDisplay(row?.maintenance_display),
        until: until && !Number.isNaN(until.getTime()) ? until.toISOString() : null,
        source: 'settings'
      }
    } catch {
      maintCache = {
        at: Date.now(),
        on: false,
        message: null,
        display: 'banner',
        until: null,
        source: 'settings'
      }
    }
  }
  const { at: _at, ...state } = maintCache
  return state
}
