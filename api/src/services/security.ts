import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
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
    await db('nivaro_login_events').insert({
      user: userId,
      method,
      ip: ip || null,
      user_agent: agent || null,
      new_ip: newIp,
      created_at: new Date()
    })
    // Masquerade "logins" are an admin acting deliberately — notifying the
    // target that "you" signed in would be confusing, not protective.
    if (newIp && app && method !== 'masquerade') {
      const priorLogins = await db('nivaro_login_events').where('user', userId).count({ c: '*' }).first()
      // A user's very FIRST login is always a new IP — don't greet them with
      // a security alert.
      if (Number((priorLogins as { c?: number } | undefined)?.c ?? 0) > 1) {
        await notifyUser(app, userId, {
          subject: 'New sign-in to your account',
          message: `A sign-in from a new location (${ip || 'unknown IP'}) just occurred. If this was you, no action is needed — otherwise contact an administrator.`
        }).catch(() => {})
      }
    }
  } catch {
    // never block auth
  }
}

/** Maintenance-mode flag, cached 15s — read on every write request. */
let maintCache: { at: number; on: boolean; message: string | null } | null = null

export function bustMaintenanceCache(): void {
  maintCache = null
}

export async function maintenanceState(): Promise<{ on: boolean; message: string | null }> {
  if (!maintCache || Date.now() - maintCache.at > 15_000) {
    try {
      const row = (await db('nivaro_settings').where({ id: 1 }).first('maintenance_mode', 'maintenance_message')) as
        | { maintenance_mode?: boolean; maintenance_message?: string | null }
        | undefined
      maintCache = { at: Date.now(), on: !!row?.maintenance_mode, message: row?.maintenance_message ?? null }
    } catch {
      maintCache = { at: Date.now(), on: false, message: null }
    }
  }
  return { on: maintCache.on, message: maintCache.message }
}
