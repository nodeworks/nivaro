import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import {
  type IndexKind,
  replayIndexKeys,
  searchReplayIndex
} from '../services/session-replay-index.js'

/**
 * Session replay search (#1374, #1372) over nivaro_replay_index — which
 * recordings opened a record, typed into a field (by NAME — values are never
 * indexed), clicked an element or visited a route. Registered under the same
 * /session-recordings prefix as the recordings themselves; admin-only like
 * every read of a recording.
 *
 *   GET /session-recordings/search?collection=&item=&field=&selector=&route=&limit=
 *   GET /session-recordings/search/keys?kind=field|record|route|selector&q=
 */

const KINDS: IndexKind[] = ['route', 'record', 'field', 'selector']

function str(v: unknown, max = 255): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t ? t.slice(0, max) : undefined
}

export async function sessionReplaySearchRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: {
      collection?: string
      item?: string
      field?: string
      selector?: string
      route?: string
      limit?: string
    }
  }>('/search', { preHandler: requireAdmin }, async (req, reply) => {
    const q = {
      collection: str(req.query.collection, 64),
      item: str(req.query.item, 200),
      field: str(req.query.field, 64),
      selector: str(req.query.selector),
      route: str(req.query.route),
      limit: Number(req.query.limit) || 100
    }
    if (q.item && !q.collection) {
      return reply.code(400).send({ error: 'item needs a collection' })
    }
    if (!q.collection && !q.field && !q.selector && !q.route) {
      return reply.code(400).send({ error: 'collection, field, selector or route is required' })
    }
    return reply.send({ data: await searchReplayIndex(q) })
  })

  app.get<{ Querystring: { kind?: string; q?: string } }>(
    '/search/keys',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const kind = req.query.kind as IndexKind
      if (!KINDS.includes(kind)) {
        return reply.code(400).send({ error: `kind must be one of ${KINDS.join(', ')}` })
      }
      return reply.send({ data: await replayIndexKeys(kind, str(req.query.q) ?? '') })
    }
  )
}
