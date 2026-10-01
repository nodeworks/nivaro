import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { uploadFile } from '../services/files.js'
import {
  INTERNAL_DISPATCH_HEADER,
  internalDispatchStamps,
  internalDispatchTokens
} from './api-logger.js'

/**
 * Root-level aliases for integrations written against the Directus-era API.
 *
 * Third parties post to `/files` and `/graphql` at the host root; Nivaro serves
 * both under `/api`. Every one of those integrations is owned by someone else,
 * on their own release cycle, and a cutover that silently breaks an inbound
 * feed is discovered by its absence — so the host keeps answering the old paths
 * and the partner changes nothing but the hostname.
 *
 * ONLY POST is aliased, deliberately. The admin SPA owns `GET /files` and
 * `GET /graphql` (its file manager and GraphQL explorer), and claiming those
 * would make a direct browser load of either page return JSON instead of the
 * app. No inbound integration GETs them.
 */
export async function legacyCompatRoutes(app: FastifyInstance) {
  /**
   * Directus: `POST /files` multipart -> `{data: {id, ...}}`.
   * Same contract as `/api/files/upload`, which this mirrors rather than
   * proxies (a multipart body cannot be re-dispatched through inject without
   * buffering the whole upload).
   */
  app.post('/files', { preHandler: authenticate }, async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Unauthorized' })
    const multipart = await req.file()
    if (!multipart) return reply.code(400).send({ error: 'No file provided' })
    const folder = (req.query as Record<string, string>).folder
    const file = await uploadFile(req.user, multipart, folder)
    await logActivity({
      action: 'create',
      collection: 'nivaro_files',
      item: String(file.id),
      user: req.user.id,
      req
    })
    return reply.code(201).send({ data: file })
  })

  /**
   * Directus: `POST /graphql`. Re-dispatched to the real handler so persisted
   * queries, auth and error shaping can never drift between the two paths.
   */
  /**
   * Directus: `/items/<collection>[/<id>]` at the host root. Re-dispatched to
   * the same path under `/api` with the query string, headers the handler
   * reads and the body, so a caller written against the legacy base URL
   * changes nothing. One request-log row (the inner dispatch is marked), and
   * the inner write adopts the outer request's chain.
   */
  const forwardItems = async (
    req: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply
  ) => {
    await authenticate(req, reply).catch(() => undefined)
    const headers: Record<string, string> = {}
    for (const name of [
      'authorization',
      'cookie',
      'content-type',
      'idempotency-key',
      'x-workspace',
      'accept'
    ]) {
      const v = req.headers[name]
      if (v) headers[name] = Array.isArray(v) ? v[0] : v
    }
    const dispatchToken = randomUUID()
    headers[INTERNAL_DISPATCH_HEADER] = dispatchToken
    internalDispatchTokens.add(dispatchToken)
    const url = `/api${req.url}`
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined
    let res: Awaited<ReturnType<typeof app.inject>>
    try {
      res = await app.inject({
        method: req.method as 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
        url,
        headers,
        ...(hasBody ? { payload: req.body as Record<string, unknown> } : {})
      })
    } finally {
      internalDispatchTokens.delete(dispatchToken)
    }
    const out = reply.code(res.statusCode)
    for (const name of ['content-type', 'x-nivaro-upserted', 'retry-after']) {
      const v = res.headers[name]
      if (v) out.header(name, String(v))
    }
    return out.send(res.body)
  }
  for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const) {
    app.route({ method, url: '/items/:collection', handler: forwardItems })
    app.route({ method, url: '/items/:collection/*', handler: forwardItems })
  }

  app.post('/graphql', async (req, reply) => {
    // Resolve the caller for the request log (auth/ip/user land on the OUTER
    // row); the real 401 shaping stays with the inner GraphQL handler, so an
    // invalid token still comes back as a GraphQL error, never a bare 401.
    await authenticate(req, reply).catch(() => undefined)
    // Only what the handler needs. Hop-by-hop and length headers describe the
    // ORIGINAL request; inject sets its own, and forwarding the old ones makes
    // it reject the call outright.
    const headers: Record<string, string> = {}
    const auth = req.headers.authorization
    if (auth) headers.authorization = auth
    if (req.headers.cookie) headers.cookie = req.headers.cookie
    headers['content-type'] = 'application/json'
    // A partner's Idempotency-Key must reach the handler that honours it.
    const idem = req.headers['idempotency-key']
    if (idem) headers['idempotency-key'] = Array.isArray(idem) ? idem[0] : idem
    const dispatchToken = randomUUID()
    headers[INTERNAL_DISPATCH_HEADER] = dispatchToken
    internalDispatchTokens.add(dispatchToken)
    let res: Awaited<ReturnType<typeof app.inject>>
    try {
      res = await app.inject({
        method: 'POST',
        url: '/api/graphql',
        headers,
        payload: req.body as Record<string, unknown>
      })
    } finally {
      internalDispatchTokens.delete(dispatchToken)
      // The inner request's operation stamp names the OUTER logged row (#1102).
      const stamp = internalDispatchStamps.get(dispatchToken)
      internalDispatchStamps.delete(dispatchToken)
      if (stamp) (req as unknown as { __nvrGql?: unknown }).__nvrGql = stamp
    }
    return reply
      .code(res.statusCode)
      .header('content-type', res.headers['content-type'] ?? 'application/json')
      .send(res.body)
  })
}
