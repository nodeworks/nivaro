import type { FastifyReply, FastifyRequest } from 'fastify'
import { requireAuth } from '../../middleware/authenticate.js'
import { notePrincipalKind } from '../permission-cache.js'
import { type KioskPrincipal, resolveKiosk } from './kiosk.js'

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

export async function ccReadAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const kiosk = kioskParam(req)
  if (kiosk === null) return requireAuth(req, reply)
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
  req.isAdmin = p.isAdmin
  req.ccKiosk = { linkId: p.linkId, meta: p.meta, expires_at: p.expires_at }
  // The compiled permission cache keys entries by how the request signed in.
  notePrincipalKind(p.user, `kiosk:${p.linkId}`)
}

export async function ccWriteAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (kioskParam(req) !== null || req.ccKiosk) {
    throw httpError(403, 'A wallboard link is read-only', 'KIOSK_NOT_ALLOWED')
  }
  return requireAuth(req, reply)
}
