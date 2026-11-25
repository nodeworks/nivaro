import type { FastifyInstance, FastifyReply } from 'fastify'
import { failedAuthLimiter } from '../lib/auth-fail-limiter.js'
import { hubModeEnabled } from '../services/hub/mode.js'
import {
  noteObservedVersion,
  recordSighting,
  sightingInstance
} from '../services/hub/shared/sightings.js'
import { getShared, sharedForToken } from '../services/hub/shared/store.js'
import { tenantsBody } from '../services/hub/shared/tenants.js'
import { healSharedBeforeRead } from '../services/hub/shared/upgrade-run.js'

/**
 * Nivaro Hub phase 6: the Hub side of the phase-5 tenants contract.
 *
 *   GET /api/hub/shared/:key/tenants   Authorization: Bearer <HUB_DEPLOYMENT_TOKEN>
 *
 * The bearer is the deployment token itself (what the deployment's hub-source sends), checked by
 * sharedForToken: SHA-256 lookup + timing-safe compare of the opened seal; the previous token
 * only inside its 24 h grace; a retired deployment never. The deployment link the other way uses
 * a bearer DERIVED from the token (deploymentLinkBearer, ruling R7), which is never accepted
 * here, so a sniffed link call cannot open this list. An unknown key and a wrong token get the
 * same 401 HUB_SHARED_UNAUTHORIZED; 20 failures a minute from one address → 429.
 *
 * The failed-token brake counts per address: replicas behind one egress address that still send a
 * token past its 24 h grace lock that address out for a minute at a time (20 tries), the good
 * replicas there included — rotate, then roll the new token out within the grace.
 *
 * The answer carries every app's database connection and encryption key: `Cache-Control:
 * no-store`, never logged. `ETag` = sha256 of the body without generated_at; If-None-Match equal
 * → 304. Each call records a sighting (X-Nivaro-Instance / X-Nivaro-Version) holding the ETag the
 * replica NAMES in If-None-Match (what it proves it serves), never the one just sent; a registered deployment whose replicas agree on a new version gets
 * an observed shared deploy. Mounted only in hub mode (HUB=on, never cloud).
 */

export const HUB_SHARED_UNAUTHORIZED = 'HUB_SHARED_UNAUTHORIZED'

function refuse(reply: FastifyReply, status: number, message: string) {
  return reply
    .code(status)
    .header('Cache-Control', 'no-store')
    .send({ statusCode: status, error: message, message, code: HUB_SHARED_UNAUTHORIZED })
}

/** The token from `Authorization: Bearer <t>`, else null. */
function bearerOf(header: unknown): string | null {
  if (typeof header !== 'string') return null
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header)
  return m ? m[1] : null
}

function headerText(v: unknown): string | null {
  const s = Array.isArray(v) ? v[0] : v
  return typeof s === 'string' ? s : null
}

export async function hubSharedTenantsRoutes(app: FastifyInstance) {
  if (!hubModeEnabled()) return
  const authFails = failedAuthLimiter()

  app.get('/shared/:key/tenants', async (req, reply) => {
    if (authFails.blocked(req.ip)) return refuse(reply, 429, 'Too many attempts')
    const { key } = req.params as { key: string }
    const bearer = bearerOf(req.headers.authorization)
    const shared = bearer ? await sharedForToken(key, bearer) : null
    if (!shared) {
      if (authFails.fail(req.ip))
        app.log.warn({ ip: req.ip }, 'hub shared tenants: unknown deployment or wrong token')
      return refuse(reply, 401, 'Unauthorized')
    }

    let out: Awaited<ReturnType<typeof tenantsBody>>
    try {
      out = await tenantsBody(shared, new Date(), app.log)
    } catch (err) {
      // The code only: driver text could carry a connection.
      const code = (err as { code?: unknown } | null)?.code
      app.log.error(
        { deployment: shared.key, code: typeof code === 'string' ? code : null },
        'hub shared tenants: building the list failed'
      )
      const message = 'The Hub could not build the tenant list — try again shortly.'
      return reply
        .code(500)
        .header('Cache-Control', 'no-store')
        .send({ statusCode: 500, error: message, message, code: 'HUB_SHARED_TENANTS_FAILED' })
    }

    const named = (headerText(req.headers['if-none-match']) ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    const notModified = named.includes(out.etag)
    // What the replica HOLDS is what it proves it holds: the tag it names. A 200 never counts
    // (the replica may drop the body: over 2 MB, unparseable, timed out, cut off); it shows up
    // as held on its next poll. hub-source names only the list it actually serves.
    const held = notModified ? out.etag : (named[0] ?? null)

    const instance = sightingInstance(headerText(req.headers['x-nivaro-instance']))
    if (instance) {
      await recordSighting(shared.id, {
        instance,
        version: headerText(req.headers['x-nivaro-version']),
        etag: held,
        at: new Date().toISOString()
      })
      try {
        // Only apps placed here run this deployment's version: never a released move-out or an
        // app moving in before release.
        // Review L1: an `upgrading` left by a run whose process died would hide an outside
        // upgrade until someone opened the page: heal it here first (a stale heartbeat and a free
        // lock only; one indexed read while nothing is stale).
        let fresh = shared
        if (shared.status === 'upgrading') {
          await healSharedBeforeRead(shared.id, 1000)
          fresh = (await getShared(shared.id)) ?? shared
        }
        await noteObservedVersion(
          fresh,
          out.rows
            .filter((r) => r.placedHere)
            .map((r) => ({ id: r.env.id, app_id: r.env.app_id, version_pin: r.env.version_pin }))
        )
      } catch {
        app.log.warn({ deployment: shared.key }, 'hub shared tenants: observed version not saved')
      }
    }

    reply.header('Cache-Control', 'no-store').header('ETag', out.etag)
    if (notModified) return reply.code(304).send()
    return reply.send(out.body)
  })
}
