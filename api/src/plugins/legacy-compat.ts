import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { uploadFile } from '../services/files.js'

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
  app.post('/graphql', async (req, reply) => {
    // Only what the handler needs. Hop-by-hop and length headers describe the
    // ORIGINAL request; inject sets its own, and forwarding the old ones makes
    // it reject the call outright.
    const headers: Record<string, string> = {}
    const auth = req.headers.authorization
    if (auth) headers.authorization = auth
    if (req.headers.cookie) headers.cookie = req.headers.cookie
    headers['content-type'] = 'application/json'
    const res = await app.inject({
      method: 'POST',
      url: '/api/graphql',
      headers,
      payload: req.body as Record<string, unknown>
    })
    return reply
      .code(res.statusCode)
      .header('content-type', res.headers['content-type'] ?? 'application/json')
      .send(res.body)
  })
}
