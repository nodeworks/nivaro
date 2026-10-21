import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { currentTenantKey } from '../services/tenant-rooms.js'
import { identityKey } from '../services/traffic-actions/temp-cache.js'

/**
 * ETag + 304 on record and schema reads (#2439).
 *
 * A record page re-asks the same collection, field, relation and layout metadata (and the
 * record itself) on every open; most answers are byte-identical to the last one. For the
 * routes in ETAG_ROUTES a 200 JSON answer carries a weak ETag, and a request whose
 * If-None-Match names it gets a body-less 304 — the browser hands the page its stored copy.
 *
 * Correctness:
 *  - The server still builds the whole answer on every request (permissions, row filters,
 *    scopes, field lists all apply); only the bytes on the wire are saved. Nothing can be
 *    stale: the tag is a hash of the exact body this request would have sent.
 *  - Per viewer: the hash also covers the tenant and the caller's whole identity (user, role,
 *    admin flag, API key and its scopes, masquerade, workspace — the temporary cache's
 *    `identityKey`). Two people who see different fields never share a tag, and a tag kept in
 *    the browser after one person signs out never answers for the next.
 *  - `Cache-Control: private, no-cache` (only when the route set none): shared caches never
 *    keep the answer, and the browser revalidates every time instead of reusing it blindly.
 *  - Only GET, only 200, only a string/Buffer body under ETAG_MAX_BYTES, never a request with
 *    no signed-in caller, never a reply that already carries an ETag.
 *
 * Registered before the request log (it records the 304 and its zero bytes) and before the
 * compression plugin (which only ever sees the full body or nothing).
 */

export const ETAG_ROUTES = new Set([
  // Record reads
  '/api/items/:collection/:id',
  // Collection / field / relation metadata
  '/api/collections',
  '/api/collections/:collection',
  '/api/collections/:collection/fields',
  '/api/field-config/:collection',
  '/api/data-model/relations',
  '/api/data-model/relations/for/:collection',
  // Layout reads
  '/api/collection-layouts',
  '/api/collection-layouts/active',
  '/api/collection-layouts/detail/:collection',
  '/api/collection-layouts/summary/:collection',
  '/api/collection-layouts/:id',
  '/api/collection-layouts/:id/assignments',
  '/api/collection-layouts/:id/bundle'
])

/** Bigger answers are sent as-is: hashing them costs more than the round trip saves. */
export const ETAG_MAX_BYTES = 4 * 1024 * 1024

/** The weak tag for `body` as `viewer` sees it. */
export function viewerEtag(viewer: string, body: string | Buffer): string {
  const h = createHash('sha1').update(viewer).update('\u0000').update(body)
  return `W/"${h.digest('base64url').slice(0, 27)}"`
}

/** Does an If-None-Match header name `etag`? (`*` matches; weak comparison.) */
export function ifNoneMatchHits(header: unknown, etag: string): boolean {
  if (typeof header !== 'string' || header === '') return false
  const bare = (t: string) => t.trim().replace(/^W\//, '')
  const want = bare(etag)
  return header.split(',').some((t) => {
    const v = t.trim()
    return v === '*' || bare(v) === want
  })
}

type Payload = string | Buffer | null | undefined | object

/**
 * The onSend step: returns the payload to send (null for a 304). Exported for the tests.
 */
export function applyEtag(req: FastifyRequest, reply: FastifyReply, payload: Payload): Payload {
  if (req.method !== 'GET' || reply.statusCode !== 200) return payload
  const route = req.routeOptions?.url
  if (!route || !ETAG_ROUTES.has(route)) return payload
  if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload
  const size = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length
  if (size > ETAG_MAX_BYTES) return payload
  if (reply.getHeader('etag') !== undefined) return payload
  const ct = String(reply.getHeader('content-type') ?? '')
  if (ct && !ct.includes('json')) return payload
  const identity = identityKey(req as unknown as Parameters<typeof identityKey>[0])
  if (!identity) return payload

  const etag = viewerEtag(`${currentTenantKey()}|${identity}`, payload)
  void reply.header('etag', etag)
  if (reply.getHeader('cache-control') === undefined) {
    void reply.header('cache-control', 'private, no-cache')
  }
  if (!ifNoneMatchHits(req.headers['if-none-match'], etag)) return payload
  void reply.code(304)
  reply.removeHeader('content-type')
  reply.removeHeader('content-length')
  return null
}

export function registerEtags(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply, payload) => applyEtag(req, reply, payload as Payload))
}
