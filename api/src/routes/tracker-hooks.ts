import type { FastifyInstance } from 'fastify'
import { runInBackgroundPool } from '../db/pool-context.js'
import { currentTenantKey } from '../services/tenant-rooms.js'
import { getConnection, verifyWebhookToken } from '../services/trackers/connections.js'
import { trackersEnabled } from '../services/trackers/feature.js'
import {
  type Delivery,
  type NoteLockRedis,
  processDelivery,
  recordDelivery,
  setTrackerRedis
} from '../services/trackers/inbound.js'

/**
 * POST /api/tracker-hooks/gitlab/:connectionId — GitLab's webhook (Issue + Note events).
 *
 * No session: the X-Gitlab-Token header is checked against the connection's stored secret hash in
 * constant time, in onRequest — before the body is read. An unknown connection and a wrong token
 * get the same bare 401. Failed checks are counted per address in Redis (`rl:hook:<tenant>:<ip>`,
 * 20 per 10 minutes, then 429 for further FAILED tries); a delivery whose token checks out is
 * never limited by it, and the route stays out of the shared anonymous budget (GitLab sends from
 * one shared address). A paused connection with the right token is answered 200 and ignored
 * (GitLab disables a hook after repeated 4xx). Each delivery is noted (deduped on
 * X-Gitlab-Event-UUID), answered 200 at once, then applied on the background pool; the event row
 * keeps the outcome. Not exempt from the maintenance freeze: GitLab retries the 503.
 * Self-hosted only (never registered in cloud mode).
 */

const BODY_LIMIT = 1024 * 1024
const header = (v: string | string[] | undefined): string =>
  (Array.isArray(v) ? v[0] : v)?.trim() ?? ''

/** Failed token checks one address may make in the window before further failures get 429. */
export const HOOK_FAILURES_MAX = 20
export const HOOK_FAILURE_WINDOW_S = 600

interface FailureRedis {
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<unknown>
}

/** Count one failed token check; true when this address is past its failure budget. */
async function overFailureBudget(redis: FailureRedis | undefined, ip: string): Promise<boolean> {
  if (!redis?.incr) return false
  try {
    const key = `rl:hook:${currentTenantKey()}:${ip}`
    const n = Number(await redis.incr(key))
    if (n === 1) await redis.expire(key, HOOK_FAILURE_WINDOW_S)
    return n > HOOK_FAILURES_MAX
  } catch {
    return false // Redis trouble: a plain 401
  }
}

/** Connection ids whose token checked out, per request (set in onRequest, read in the handler). */
const verified = new WeakMap<object, { id: number; active: boolean }>()

export async function trackerHookRoutes(app: FastifyInstance) {
  // The note lock (services/trackers/inbound.ts) uses Redis when this app has it
  setTrackerRedis((app as { redis?: NoteLockRedis }).redis)

  app.post(
    '/gitlab/:connectionId',
    {
      bodyLimit: BODY_LIMIT,
      onRequest: async (req, reply) => {
        if (!(await trackersEnabled()))
          return reply.code(404).send({ error: 'Not found', code: 'FEATURE_OFF' })
        const raw = String((req.params as { connectionId?: string }).connectionId ?? '')
        const id = /^\d{1,9}$/.test(raw) ? Number(raw) : 0
        const conn = id > 0 ? await getConnection(id) : null
        const token = header(req.headers['x-gitlab-token']) || undefined
        const ok = conn ? await verifyWebhookToken(id, token) : false
        if (!conn || !ok) {
          // only a failed check is counted, and only a failed check can be refused
          if (await overFailureBudget((app as { redis?: FailureRedis }).redis, req.ip)) {
            reply.header('Retry-After', String(HOOK_FAILURE_WINDOW_S))
            return reply.code(429).send({ error: 'Too Many Requests' })
          }
          return reply.code(401).send({ error: 'Unauthorized' })
        }
        verified.set(req, { id, active: !!conn.is_active })
      }
    },
    async (req, reply) => {
      const v = verified.get(req)
      if (!v) return reply.code(401).send({ error: 'Unauthorized' })
      // paused: nothing is applied, and GitLab is not pushed into disabling the hook
      if (!v.active) return reply.send({ ok: true, ignored: true })
      const id = v.id

      const body = req.body
      const kind =
        header(req.headers['x-gitlab-event']) ||
        String((body as { object_kind?: unknown } | null)?.object_kind ?? '')
      const delivery: Delivery = {
        connection: id,
        uuid: header(req.headers['x-gitlab-event-uuid']) || null,
        kind,
        body
      }
      const eventId = await recordDelivery(delivery)
      if (eventId === 'duplicate') return reply.send({ ok: true, duplicate: true })

      await reply.send({ ok: true })
      void runInBackgroundPool(() => processDelivery(eventId, delivery)).catch((err) =>
        req.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'tracker hook')
      )
      return reply
    }
  )
}
