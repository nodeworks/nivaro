// api/src/routes/traffic-map-extras/inspect-nav.ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { errorText, reasonWithoutSql } from '../../lib/db-refusal.js'
// Loads the group's inspect sources (`load`, `search` — they register at module load).
import { loadList, relatedFor, searchInspect } from '../../services/traffic-inspect/nav.js'
import {
  INSPECT_KIND_RE,
  parseInspectAt,
  parseInspectWindow
} from '../../services/traffic-inspect.js'

/**
 * Traffic Map drill-down, group "nav" — routes beyond the generic inspect ones. Admin only and 404
 * in cloud mode (inherited from the traffic-map plugin's hooks).
 *
 *   GET /traffic-map/inspect/related/:kind/:id?at=&window=  → { data: { groups, notes, load, at, window } }
 *   GET /traffic-map/inspect/load-list?page=<pattern>       → { data: [{ load, at, calls, ms, user, caller }] }
 *   GET /traffic-map/inspect/search?q=                      → { data: { q, type, results, refused?, hint? } }
 */
function failure(req: FastifyRequest, reply: FastifyReply, err: unknown, what: string) {
  req.log.warn({ err }, `traffic-map inspect ${what} failed`)
  const text = errorText(err, 1000)
  const cut = text.indexOf(' — while running:')
  return reply.code(500).send({
    error: reasonWithoutSql(cut >= 0 ? text.slice(0, cut) : text) || `${what} failed`,
    code: 'INSPECT_FAILED'
  })
}

export async function inspectNavRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { kind: string; id: string }; Querystring: { at?: string; window?: string } }>(
    '/inspect/related/:kind/:id',
    async (req, reply) => {
      const kind = String(req.params.kind ?? '')
      const id = String(req.params.id ?? '')
      if (!INSPECT_KIND_RE.test(kind) || !id || id.length > 400) {
        return reply.code(400).send({
          error: 'That is not a level that can have related items',
          code: 'INSPECT_ID_INVALID'
        })
      }
      try {
        const data = await relatedFor(kind, id, {
          req,
          at: parseInspectAt(req.query.at),
          windowSec: parseInspectWindow(req.query.window)
        })
        if (!data)
          return reply
            .code(400)
            .send({ error: `That is not a valid ${kind} id`, code: 'INSPECT_ID_INVALID' })
        return { data }
      } catch (err) {
        return failure(req, reply, err, 'related')
      }
    }
  )

  app.get<{ Querystring: { page?: string } }>('/inspect/load-list', async (req, reply) => {
    const page = typeof req.query.page === 'string' ? req.query.page.trim() : ''
    if (!page || page.length > 300) {
      return reply.code(400).send({
        error: 'Name a page pattern (?page=/collections/:collection)',
        code: 'INSPECT_ID_INVALID'
      })
    }
    try {
      return { data: await loadList(page) }
    } catch (err) {
      return failure(req, reply, err, 'load list')
    }
  })

  app.get<{ Querystring: { q?: string } }>('/inspect/search', async (req, reply) => {
    try {
      return { data: await searchInspect(req.query.q) }
    } catch (err) {
      return failure(req, reply, err, 'search')
    }
  })
}
