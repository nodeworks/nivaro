import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { isEncrypted } from '../services/encryption.js'
import { idParam } from '../services/hub/apps.js'
import { healMoves } from '../services/hub/move/heal.js'
import { type HubMoveRow, listMoves, readMove } from '../services/hub/move/rows.js'
import {
  cancelMove,
  confirmRoute,
  finishStopSource,
  MoveError,
  planFor,
  resumeMove,
  retireStopOf,
  type StartBody,
  setMoveChecklist,
  startMove
} from '../services/hub/move/run.js'
import { PromotionError } from '../services/hub/promote-lock.js'
import { environmentFreezeRefusal } from '../services/hub/releases/freeze.js'
import { HubSecretError } from '../services/hub/secrets.js'

/**
 * Nivaro Hub phase 6 (Task 16): moving an environment between a dedicated stack and a shared
 * deployment, mounted under /api/hub by hub.ts (HUB=on only). Every route is for a Hub
 * administrator (403 otherwise).
 *
 *   POST /environments/:envId/move/plan {to}     → {data: MovePlan}
 *   POST /environments/:envId/move               {to, plan_hash, confirm, checklist} → 202
 *                                                {data: {move_id}}; 400 CONFIRM_MISMATCH |
 *                                                BAD_TARGET; 409 PLAN_CHANGED (with `plan`) |
 *                                                PLAN_BLOCKED (with `blockers`) |
 *                                                CHECKLIST_INCOMPLETE (with `open`) | BUSY |
 *                                                SHARED_BUSY
 *   GET  /moves/:id                              → {data: move}
 *   GET  /environments/:envId/moves              → {data: [move]} (newest first)
 *   POST /moves/:id/cancel                       → 202; a running move rolls back at its next
 *                                                step, an interrupted one now (409 TOO_LATE after
 *                                                release, MOVE_ENDED once ended)
 *   POST /moves/:id/resume                       → 202 (interrupted only)
 *   POST /moves/:id/confirm-route                → {data: {serving}}
 *   POST /moves/:id/checklist {item, done}       → {data: checklist}
 *   POST /moves/:id/finish-stop-source {confirm}  → 202; P6-45 "Finish and stop the old home":
 *                                                a retire_source key stop whose old home the
 *                                                Hub can stop ends success once that stop is
 *                                                proven (400 CONFIRM_MISMATCH; 409 NOT_RELEASED
 *                                                | NOT_STOPPED_AT_RETIRE | CANNOT_STOP_OLD_HOME
 *                                                | MOVE_CHANGED | MOVE_ENDED)
 * A move answered carries `retire_stop` (run.ts retireStopOf, the one predicate the admin reads):
 * the retire_source key stop and its ways out, or null.
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

/** Anything sealed with the Hub key, at any depth, is left out of an answer (R6-M-1). */
function withoutSealed(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => !isEncrypted(x)).map(withoutSealed)
  const proto = v && typeof v === 'object' ? Object.getPrototypeOf(v) : undefined
  // Plain objects only: a Date (or any other class) is answered as it is.
  if (proto === Object.prototype || proto === null) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as object)) if (!isEncrypted(x)) out[k] = withoutSealed(x)
    return out
  }
  return v
}

/**
 * A move as answered: the stored row without the run's own lock tokens (heal's business), the
 * sealed transfer tickets (R2-M-6) and any other sealed value (R6-M-1).
 */
function publicMove(m: HubMoveRow) {
  const { locks: _locks, open_tickets: _tickets, ...steps } = m.steps
  return withoutSealed({ ...m, steps }) as HubMoveRow
}

/** A move as answered, with its retire_source stop (the one predicate, review N-7). */
async function answeredMove(m: HubMoveRow) {
  return { ...publicMove(m), retire_stop: await retireStopOf(m) }
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
    // Release operations: a freeze window stops a move (services/hub/releases/freeze.ts).
    const frozen = await environmentFreezeRefusal(envId, 'move')
    if (frozen) return refuse(reply, frozen.status, frozen.code, frozen.message)
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
    return reply.send({ data: await answeredMove(m) })
  })

  app.get('/environments/:envId/moves', { preHandler: requireAdmin }, async (req, reply) => {
    const envId = envParam(req)
    if (envId === null) return refuse(reply, 404, 'NOT_FOUND', 'No such environment.')
    if (!(await db(ENVS).where({ id: envId }).first('id')))
      return refuse(reply, 404, 'NOT_FOUND', 'No such environment.')
    await healMoves().catch(() => 0)
    return reply.send({ data: await Promise.all((await listMoves(envId)).map(answeredMove)) })
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

  app.post('/moves/:id/finish-stop-source', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idOf(req)
    if (id === null) return refuse(reply, 404, 'NOT_FOUND', 'No such move.')
    await healMoves({}, id).catch(() => 0)
    return guarded(reply, async () => {
      await finishStopSource(id, body(req).confirm, userId(req))
      return reply.code(202).send({ data: { finishing: true } })
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
