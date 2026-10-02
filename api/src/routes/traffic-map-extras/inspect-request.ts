// api/src/routes/traffic-map-extras/inspect-request.ts
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { logActivity } from '../../services/activity.js'
import { INSTANCE_ID } from '../../services/instance-roster.js'
// Loads the group's inspect sources (they register at module load).
import { compareCandidates } from '../../services/traffic-inspect/request.js'
import {
  armEverywhere,
  inspectBook,
  setInspectNode,
  startInspectRelay,
  stopEverywhere
} from '../../services/traffic-inspect/request-capture.js'
import {
  type ArmKind,
  isRequestId,
  parseArmBody,
  UUID_RE
} from '../../services/traffic-inspect/request-logic.js'
import { parseInspectAt } from '../../services/traffic-inspect.js'

/**
 * Traffic Map drill-down, group "request" — the routes beyond the generic inspect ones:
 *
 *   POST   /traffic-map/inspect/trace-next          { route, caller?, count 1–20, ttlSec ≤ 900 }
 *   GET    /traffic-map/inspect/trace-next/:armId   → { remaining, traces: [{rid, at, ms}] }
 *   DELETE /traffic-map/inspect/trace-next/:armId   stop early (a capture's or trace-next's)
 *   POST   /traffic-map/inspect/capture             { route?, caller?, entity?, count ≤ 50, ttlSec ≤ 900 }
 *   GET    /traffic-map/inspect/compare-candidates/:rid   the same route's recent requests
 *
 * Admin only and 404 in cloud mode (inherited from the traffic-map plugin's hooks). Arms are
 * memory per process, relayed to every process over Redis (services/traffic-inspect/request-capture.ts).
 */
export async function inspectRequestRoutes(app: FastifyInstance): Promise<void> {
  setInspectNode(INSTANCE_ID)
  const redis = (app as unknown as { redis?: import('ioredis').Redis }).redis
  if (redis && process.env.NODE_ENV !== 'test') {
    try {
      const stop = await startInspectRelay(redis, INSTANCE_ID)
      app.addHook('onClose', async () => stop())
    } catch (err) {
      app.log.warn(
        { err },
        'traffic-map trace-next relay did not start; arms apply to this process only'
      )
    }
  }

  async function arm(
    kind: ArmKind,
    body: unknown,
    req: FastifyRequest
  ): Promise<{ status: number; payload: unknown }> {
    const parsed = parseArmBody(body, kind)
    if ('error' in parsed)
      return { status: 400, payload: { error: parsed.error, code: 'ARM_INVALID' } }
    const now = Date.now()
    const id = randomUUID()
    armEverywhere({
      id,
      kind,
      spec: parsed.spec,
      total: parsed.count,
      remaining: parsed.count,
      createdAt: now,
      expiresAt: now + parsed.ttlSec * 1000,
      by: req.user?.id ?? null,
      node: INSTANCE_ID
    })
    const what = [parsed.spec.route, parsed.spec.caller, parsed.spec.entity]
      .filter(Boolean)
      .join(' · ')
    await logActivity({
      action: kind === 'trace' ? 'traffic-trace-next' : 'traffic-capture',
      user: req.user?.id,
      comment: `${kind === 'trace' ? 'Trace' : 'Capture'} next ${parsed.count} of ${what} for ${parsed.ttlSec}s`,
      req
    })
    return {
      status: 200,
      payload: {
        data: {
          id,
          kind,
          spec: parsed.spec,
          total: parsed.count,
          remaining: parsed.count,
          expires_at: now + parsed.ttlSec * 1000
        }
      }
    }
  }

  app.post('/inspect/trace-next', async (req, reply) => {
    const r = await arm('trace', req.body, req)
    return reply.code(r.status).send(r.payload)
  })

  app.post('/inspect/capture', async (req, reply) => {
    const r = await arm('capture', req.body, req)
    return reply.code(r.status).send(r.payload)
  })

  app.get<{ Params: { armId: string } }>('/inspect/trace-next/:armId', async (req, reply) => {
    const id = String(req.params.armId ?? '')
    if (!UUID_RE.test(id))
      return reply.code(400).send({ error: 'That is not a trace-next id', code: 'ARM_ID_INVALID' })
    const v = inspectBook().view(id.toLowerCase())
    if (!v)
      return reply.code(404).send({
        error: 'That trace-next has expired (or was armed on an API process that has restarted)',
        code: 'ARM_NOT_FOUND'
      })
    return {
      data: {
        id: v.id,
        kind: v.kind,
        spec: v.spec,
        total: v.total,
        remaining: v.remaining,
        done: v.done,
        expires_at: v.expires_at,
        traces: v.entries.map((e) => ({
          rid: e.rid,
          at: e.at,
          ms: e.ms,
          status: e.status,
          path: e.path,
          node: e.node
        })),
        node: INSTANCE_ID
      }
    }
  })

  app.delete<{ Params: { armId: string } }>('/inspect/trace-next/:armId', async (req, reply) => {
    const id = String(req.params.armId ?? '')
    if (!UUID_RE.test(id))
      return reply.code(400).send({ error: 'That is not a trace-next id', code: 'ARM_ID_INVALID' })
    const had = stopEverywhere(id.toLowerCase())
    if (!had)
      return reply.code(404).send({ error: 'That arm has already ended', code: 'ARM_NOT_FOUND' })
    return { data: { stopped: true } }
  })

  app.get<{ Params: { rid: string }; Querystring: { at?: string } }>(
    '/inspect/compare-candidates/:rid',
    async (req, reply) => {
      const rid = String(req.params.rid ?? '')
      if (!isRequestId(rid))
        return reply
          .code(400)
          .send({ error: 'That is not a request id', code: 'INSPECT_ID_INVALID' })
      const data = await compareCandidates(rid, parseInspectAt(req.query.at))
      if (!data)
        return reply.code(404).send({
          error: 'That request is not in the API log, so there is no route to compare against',
          code: 'INSPECT_NOT_FOUND'
        })
      return { data }
    }
  )
}
