// api/src/routes/traffic-map-extras/inspect-core.ts
import type { FastifyInstance, FastifyReply } from 'fastify'
import { errorText, reasonWithoutSql } from '../../lib/db-refusal.js'
import {
  type InspectCtx,
  type InspectSource,
  inspectKinds,
  inspectSource,
  parseInspectAt,
  parseInspectWindow
} from '../../services/traffic-inspect.js'

/**
 * Traffic Map drill-down — the generic inspect routes (services/traffic-inspect.ts holds the
 * registry; each group's sources register from services/traffic-inspect/<group>.ts).
 *
 *   GET /traffic-map/inspect/kinds                      → { data: string[] }
 *   GET /traffic-map/inspect/:kind/:id?at=&window=      → { data } | 404 | 400
 *   GET /traffic-map/inspect/:kind/:id/peek?at=&window= → { data: InspectPeek | null }
 *
 * Admin only and 404 in cloud mode (inherited from the traffic-map plugin's hooks).
 */
type Params = { kind: string; id: string }
type Query = { at?: string; window?: string }

/** A source failure as a sentence: the reason only, never the statement it was running. */
function failureMessage(err: unknown): string {
  const text = errorText(err, 1000)
  const cut = text.indexOf(' — while running:')
  return reasonWithoutSql(cut >= 0 ? text.slice(0, cut) : text) || 'Inspect failed'
}

/** The source for `kind` and an accepted id, or the reply already sent (404 / 400). */
function resolve(
  params: Params,
  reply: FastifyReply
): { source: InspectSource; id: string } | null {
  const source = inspectSource(params.kind)
  if (!source) {
    reply.code(404).send({
      error: `Nothing can be inspected as "${params.kind}"`,
      code: 'INSPECT_KIND_UNKNOWN'
    })
    return null
  }
  const id = String(params.id ?? '')
  let ok = false
  try {
    ok = id.length > 0 && id.length <= 400 && source.validId(id)
  } catch {
    ok = false
  }
  if (!ok) {
    reply.code(400).send({
      error: `That is not a valid ${params.kind} id`,
      code: 'INSPECT_ID_INVALID'
    })
    return null
  }
  return { source, id }
}

export async function inspectCoreRoutes(app: FastifyInstance): Promise<void> {
  app.get('/inspect/kinds', async () => ({ data: inspectKinds() }))

  app.get<{ Params: Params; Querystring: Query }>('/inspect/:kind/:id', async (req, reply) => {
    const found = resolve(req.params, reply)
    if (!found) return reply
    const ctx: InspectCtx = {
      req,
      at: parseInspectAt(req.query.at),
      windowSec: parseInspectWindow(req.query.window)
    }
    try {
      const data = await found.source.detail(found.id, ctx)
      if (data == null) {
        return reply.code(404).send({
          error: `No ${req.params.kind} ${found.id} to show`,
          code: 'INSPECT_NOT_FOUND'
        })
      }
      return { data }
    } catch (err) {
      req.log.warn({ err, kind: req.params.kind }, 'traffic-map inspect source failed')
      return reply.code(500).send({ error: failureMessage(err), code: 'INSPECT_FAILED' })
    }
  })

  app.get<{ Params: Params; Querystring: Query }>('/inspect/:kind/:id/peek', async (req, reply) => {
    const found = resolve(req.params, reply)
    if (!found) return reply
    if (!found.source.peek) {
      return { data: { title: `${req.params.kind} ${found.id}`, lines: [] } }
    }
    const ctx: InspectCtx = {
      req,
      at: parseInspectAt(req.query.at),
      windowSec: parseInspectWindow(req.query.window)
    }
    try {
      return { data: (await found.source.peek(found.id, ctx)) ?? null }
    } catch (err) {
      req.log.warn({ err, kind: req.params.kind }, 'traffic-map inspect peek failed')
      return reply.code(500).send({ error: failureMessage(err), code: 'INSPECT_FAILED' })
    }
  })
}
