import type { FastifyReply, FastifyRequest } from 'fastify'
import { adminRefusal, requireAuth } from '../../middleware/authenticate.js'
import { notePrincipalKind } from '../permission-cache.js'
import { type KioskPrincipal, resolveKiosk } from './kiosk.js'
import { readableRegionIds } from './scope-guard.js'

const httpError = (statusCode: number, message: string, code: string) =>
  Object.assign(new Error(message), { statusCode, code })

/**
 * Command Center sign-in gates.
 *   ccReadAuth  — every Command Center GET. A signed-in person, or a wallboard (kiosk) link:
 *                 `?kiosk=<token>` resolves to the link's CREATOR for this one request
 *                 (req.user / req.userRole / req.isAdmin as the creator would have them), and
 *                 only for GET/HEAD routes under /api/command-center/ that do not opt out with
 *                 route config `ccNoKiosk: true`. Anything else carrying `kiosk` is refused —
 *                 it never falls through to a session.
 *   ccWriteAuth — every Command Center write (nudges, actions, prefs): always a real signed-in
 *                 person, never a kiosk link.
 * The token is redacted from logged query strings (services/secret-mask.ts maskQueryString).
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Set when this request reads through a Command Center wallboard link. */
    ccKiosk?: Pick<KioskPrincipal, 'linkId' | 'meta' | 'expires_at'>
  }
  interface FastifyContextConfig {
    /** A Command Center route a wallboard link may never reach (own prefs, link admin). */
    ccNoKiosk?: boolean
  }
}

const CC_PREFIX = '/api/command-center/'

/** The `kiosk` query value, '' when present but unusable, null when absent. */
export function kioskParam(req: Pick<FastifyRequest, 'query'>): string | null {
  const q = (req.query ?? {}) as Record<string, unknown>
  if (!Object.hasOwn(q, 'kiosk')) return null
  const v = q.kiosk
  return typeof v === 'string' ? v : ''
}

/** Why a request carrying `kiosk` may not use it here, or null when it may. */
export function kioskRefusal(req: FastifyRequest): string | null {
  if (req.method !== 'GET' && req.method !== 'HEAD') return 'A wallboard link is read-only'
  const route = req.routeOptions?.url ?? ''
  if (!route.startsWith(CC_PREFIX)) return 'A wallboard link only opens the Command Center'
  if (req.routeOptions?.config?.ccNoKiosk) return 'A wallboard link cannot open this'
  return null
}

/**
 * Whether this request may use administrator-only Command Center blocks (system health, deploy
 * and incident markers, integration problems, partners, everyone's workload…). Honours API key
 * scopes (a scoped key is never an administrator here) and is never true for a wallboard link.
 */
export function ccIsAdmin(req: FastifyRequest): boolean {
  if (req.ccKiosk) return false
  return !adminRefusal(req)
}

/** What a cache key must carry so one credential never reads another's cached answer. */
export function ccCredKey(req: FastifyRequest): string {
  if (req.ccKiosk) return `k${req.ccKiosk.linkId}`
  const key = req.apiKeyId ?? req.apiKeySimulatedId
  if (key != null) return `a${key}`
  return req.authMethod === 'masquerade' ? 'm' : 's'
}

/**
 * A `region` the caller cannot read is dropped (no region = everywhere) so a free-form value can
 * never fan out into per-region work. Runs after sign-in on every Command Center read and write.
 */
async function limitRegion(req: FastifyRequest, pinned = false): Promise<void> {
  for (const bag of [req.query, req.body]) {
    if (!bag || typeof bag !== 'object') continue
    const o = bag as Record<string, unknown>
    if (typeof o.region !== 'string' || !o.region) continue
    const readable = await readableRegionIds(req.user!)
    if (readable?.has(o.region.toUpperCase())) continue
    // A signed-in person's region is only a narrowing lens: dropping one we cannot confirm
    // answers for everywhere they may read anyway. A wallboard pinned to a region must never
    // widen to everywhere — refuse instead (the region is gone or the lookup failed).
    if (pinned) {
      throw httpError(
        403,
        'This wallboard link shows a region that is no longer available. Ask an administrator for a new link.',
        'KIOSK_REGION_UNAVAILABLE'
      )
    }
    delete o.region
  }
}

export async function ccReadAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const kiosk = kioskParam(req)
  if (kiosk === null) {
    await requireAuth(req, reply)
    if (req.user) await limitRegion(req)
    return
  }
  const refusal = kioskRefusal(req)
  if (refusal) throw httpError(403, refusal, 'KIOSK_NOT_ALLOWED')
  const p = await resolveKiosk(kiosk)
  if (!p) {
    throw httpError(
      401,
      'This wallboard link has expired or was turned off. Ask an administrator for a new one.',
      'KIOSK_LINK_INVALID'
    )
  }
  req.user = p.user
  req.userRole = p.role
  // A wallboard is a BUSINESS board, never an admin console: the link reads as its creator for
  // record permissions, but every administrator-only block stays off (ccIsAdmin is false).
  req.isAdmin = false
  req.ccKiosk = { linkId: p.linkId, meta: p.meta, expires_at: p.expires_at }
  // The board the link opens on is the link's, whatever the query says.
  if (!req.query || typeof req.query !== 'object') (req as { query: unknown }).query = {}
  const q = req.query as Record<string, unknown>
  if (p.meta.region) q.region = p.meta.region
  else delete q.region
  // The compiled permission cache keys entries by how the request signed in.
  notePrincipalKind(p.user, `kiosk:${p.linkId}`)
  await limitRegion(req, !!p.meta.region)
}

export async function ccWriteAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (kioskParam(req) !== null || req.ccKiosk) {
    throw httpError(403, 'A wallboard link is read-only', 'KIOSK_NOT_ALLOWED')
  }
  return requireAuth(req, reply)
}
