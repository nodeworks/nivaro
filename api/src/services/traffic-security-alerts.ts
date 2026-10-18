/**
 * #2235 — raise "one session from two places" to admins, never to the person whose session it
 * is. A confident flag only (different browsers or countries on the two sides), through the
 * ordinary notification path (notifyUser, category `system`), deduped: once per session, once
 * per person per DEDUPE_MS, at most HOURLY_CAP raises per process an hour. Deployed instances
 * only (cronTicksEnabled — a dev API on the shared database must not message staging's admins),
 * never in cloud mode (one process serves many tenants).
 *
 * The notification names the person and links to their caller node on the Traffic Map; the
 * addresses and browsers are in the map's Security panel (admin only), not in the message.
 */
import type { FastifyInstance } from 'fastify'
import { adminBaseUrl } from '../admin-base.js'
import { db } from '../db/index.js'
import { cronTicksEnabled } from './cron-ticks.js'
import { notifyUser } from './notification-channels.js'
import {
  type Sess,
  setTwoPlacesListener,
  type TwoPlacesFlag
} from './traffic-taps/session-guard.js'

export const DEDUPE_MS = 6 * 3600_000
export const HOURLY_CAP = 20
const ADMIN_CAP = 25

let app: FastifyInstance | null = null
const raisedPeople = new Map<string, number>()
let hour = { at: 0, n: 0 }

/** Should this flag be raised now? Records the raise when it says yes (exported for tests). */
export function claimRaise(caller: string, flag: TwoPlacesFlag, now = Date.now()): boolean {
  if (flag.confidence !== 'high') return false
  if (!/^u[0-9A-F-]{36}$/i.test(caller)) return false
  const prev = raisedPeople.get(caller)
  if (prev != null && now - prev < DEDUPE_MS) return false
  if (now - hour.at >= 3600_000) hour = { at: now, n: 0 }
  if (hour.n >= HOURLY_CAP) return false
  hour.n++
  raisedPeople.set(caller, now)
  if (raisedPeople.size > 500) {
    for (const [k, t] of raisedPeople) if (now - t >= DEDUPE_MS) raisedPeople.delete(k)
  }
  return true
}

/** Active administrators, except `exceptUserId`. */
async function adminRecipients(exceptUserId: string): Promise<string[]> {
  const rows = (await db('nivaro_users as u')
    .join('nivaro_roles as r', 'r.id', 'u.role')
    .where('r.admin_access', true)
    .where('u.status', 'active')
    .whereNot('u.id', exceptUserId)
    .limit(ADMIN_CAP)
    .select('u.id')
    .catch(() => [])) as Array<{ id: string }>
  return rows.map((r) => String(r.id))
}

async function raise(s: Sess): Promise<void> {
  if (!app) return
  const userId = s.caller.slice(1)
  const person = (await db('nivaro_users')
    .where({ id: userId })
    .first('first_name', 'last_name', 'email')
    .catch(() => null)) as { first_name?: string; last_name?: string; email?: string } | null
  const name =
    [person?.first_name, person?.last_name].filter(Boolean).join(' ') || person?.email || 'Someone'
  const base = adminBaseUrl() ?? ''
  const url = `${base}/traffic-map?inspect=${encodeURIComponent(`caller:${s.caller}`)}`
  for (const admin of await adminRecipients(userId)) {
    await notifyUser(app, admin, {
      subject: `Security: ${name}'s session was used from two places`,
      message:
        'The same sign-in session made requests from two different networks at the same time, ' +
        'with different browsers or countries. It may be a copied session cookie. The Traffic ' +
        "Map's Security panel shows both addresses.",
      category: 'system',
      target: { kind: 'external', url, action: 'review' },
      source: { kind: 'traffic-security', label: 'Traffic Map', id: s.id },
      why: 'You are an administrator.'
    }).catch(() => undefined)
  }
}

/** Wire the listener (called once by the security route plugin). */
export function enableTwoPlacesAlerts(instance: FastifyInstance): void {
  app = instance
  setTwoPlacesListener((s, flag) => {
    if (process.env.CLOUD_META_DB_URL || !cronTicksEnabled()) return
    if (!claimRaise(s.caller, flag)) return
    void raise(s).catch(() => undefined)
  })
}

/** Tests only. */
export function resetRaisesForTests(): void {
  raisedPeople.clear()
  hour = { at: 0, n: 0 }
}
