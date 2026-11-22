import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { idParam } from '../services/hub/apps.js'
import { healMoves } from '../services/hub/move/heal.js'
import { type HubMoveRow, listMoves, readMove } from '../services/hub/move/rows.js'
import {
  cancelMove,
  confirmRoute,
  MoveError,
  planFor,
  resumeMove,
  setMoveChecklist,
  type StartBody,
  startMove
} from '../services/hub/move/run.js'
import { PromotionError } from '../services/hub/promote-lock.js'
import { HubSecretError } from '../services/hub/secrets.js'

/**
 * Nivaro Hub phase 6 (Task 16): moving an environment between a dedicated stack and a shared
 * deployment, mounted under /api/hub by hub.ts (HUB=on only). Every route is for a Hub
 * administrator (403 otherwise).
 *
 *   POST /environments/:envId/move/plan {to}     → {data: MovePlan}
 *   POST /environments/:envId/move               {to, plan_hash, confirm, checklist} → 202
 *                                                {data: {move_id}}; 400 CONFIRM_MISMATCH |
 *                                                CHECKLIST_OPEN | BAD_TARGET; 409 PLAN_CHANGED
 *                                                (with `plan`) | PLAN_BLOCKED (with `blockers`) |
 *                                                BUSY | SHARED_BUSY
 *   GET  /moves/:id                              → {data: move}
 *   GET  /environments/:envId/moves              → {data: [move]} (newest first)
 *   POST /moves/:id/cancel                       → 202; a running move rolls back at its next
 *                                                step, an interrupted one now (409 TOO_LATE after
 *                                                release, MOVE_ENDED once ended)
 *   POST /moves/:id/resume                       → 202 (interrupted only)
 *   POST /moves/:id/confirm-route                → {data: {serving}}
 *   POST /moves/:id/checklist {item, done}       → {data: checklist}
 *
 * Reads heal first: a move whose run stopped elsewhere shows `interrupted`. At boot the Hub heals
 * every stale move (beside the phase-2 promotion heal). Refusals are `{statusCode, error,
 * message, code}`; answers never carry a token, ticket, key or connection.
 */

const ENVS = 'nivaro_hub_environments'

function refuse(reply: FastifyReply, status: number, code: string, message: string, extra = {}) {
  return reply.code(status).send({ statusCode: status, error: message, message, code, ...extra })
}

function userId(req: FastifyRequest): string {
  return String(req.user?.id ?? '')
}

function body(req: FastifyRequest): Record<string, unknown> {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {}
}

async function guarded(reply: FastifyReply, run: () => Promise<unknown>) {
  try {
    return await run()
  } catch (e) {
    if (e instanceof MoveError)
      return refuse(reply, e.statusCode, e.code, e.message, {
        ...(e.plan ? { plan: e.plan } : {}),
        ...(e.blockers ? { blockers: e.blockers } : {}),
        ...(e.open ? { open: e.open } : {})
      })
    if (e instanceof PromotionError)
      return refuse(reply, e.status === 503 ? 503 : 409, e.code, e.message)
    if (e instanceof HubSecretError) return refuse(reply, 400, e.code, e.message)
    throw e
  }
}

/** A move as answered: the stored row (no secret is ever stored with a move). */
function publicMove(m: HubMoveRow) {
  return m
}

export function hubMoveRoutes(app: FastifyInstance) {
  // Once per process start, beside the promotion heal: moves a dead process left open.
  app.addHook('onReady', async () => {
    try {
      const n = await healMoves()
      if (n) app.log.warn({ moves: n }, 'hub move: interrupted runs found at boot')
    } catch (err) {
      app.log.warn({ err: (err as Error | null)?.name ?? 'Error' }, 'hub move: boot heal failed')
    }
  })

  const envParam = (req: FastifyRequest) => idParam((req.params as { envId?: string }).envId)
  const idOf = (req: FastifyRequest) => idParam((req.params as { id?: string }).id)

  app.post('/environments/:envId/move/plan', { preHandler: requireAdmin }, async (req, reply) => {
    const envId = envParam(req)
    if (envId === null) return refuse(reply, 404, 'NOT_FOUND', 'No such environment.')
    return guarded(reply, async () => reply.send({ data: await planFor(envId, body(req).to) }))
  })

  app.post('/environments/:envId/move', { preHandler: requireAdmin }, async (req, reply) => {
    const envId = envParam(req)
    if (envId === null) return refuse(reply, 404, 'NOT_FOUND', 'No such environment.')
    return guarded(reply, async () => {
      const out = await startMove(envId, body(req) as unknown as StartBody, userId(req))
      return reply.code(202).send({ data: out })
    })
  })

  app.get('/moves/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idOf(req)
    if (id === null) return refuse(reply, 404, 'NOT_FOUND', 'No such move.')
    await healMoves({}, id).catch(() => 0)
    const m = await readMove(id)
    if (!m) return refuse(reply, 404, 'NOT_FOUND', 'No such move.')
    return reply.send({ data: publicMove(m) })
  })

  app.get('/environments/:envId/moves', { preHandler: requireAdmin }, async (req, reply) => {
    const envId = envParam(req)
    if (envId === null) return refuse(reply, 404, 'NOT_FOUND', 'No such environment.')
    if (!(await db(ENVS).where({ id: envId }).first('id')))
      return refuse(reply, 404, 'NOT_FOUND', 'No such environment.')
    await healMoves().catch(() => 0)
    return reply.send({ data: (await listMoves(envId)).map(publicMove) })
  })

  app.post('/moves/:id/cancel', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idOf(req)
    if (id === null) return refuse(reply, 404, 'NOT_FOUND', 'No such move.')
    await healMoves({}, id).catch(() => 0)
    return guarded(reply, async () => {
      await cancelMove(id, userId(req))
      return reply.code(202).send({ data: { cancel: 'asked' } })
    })
  })

  app.post('/moves/:id/resume', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idOf(req)
    if (id === null) return refuse(reply, 404, 'NOT_FOUND', 'No such move.')
    await healMoves({}, id).catch(() => 0)
    return guarded(reply, async () => {
      await resumeMove(id, userId(req))
      return reply.code(202).send({ data: { resumed: true } })
    })
  })

  app.post('/moves/:id/confirm-route', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idOf(req)
    if (id === null) return refuse(reply, 404, 'NOT_FOUND', 'No such move.')
    return guarded(reply, async () => reply.send({ data: await confirmRoute(id, userId(req)) }))
  })

  app.post('/moves/:id/checklist', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idOf(req)
    if (id === null) return refuse(reply, 404, 'NOT_FOUND', 'No such move.')
    const b = body(req)
    return guarded(reply, async () =>
      reply.send({ data: await setMoveChecklist(id, b.item, b.done, userId(req)) })
    )
  })
}
