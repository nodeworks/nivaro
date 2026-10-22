import type { FastifyInstance, FastifyReply } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { checkCronOverlap, cronJobsOf } from '../services/chaos/cron-overlap.js'
import { startChaosTestScheduler } from '../services/chaos/cron-test-job.js'
import { ChaosError, chaosRefusal } from '../services/chaos/gate.js'
import { requireChaosOperator } from '../services/chaos/operator.js'
import { partitionReport, startPartitionProbe } from '../services/chaos/partition.js'
import { partitionCatchUpStats } from '../services/chaos/partition-point.js'
import { redisChaosStats } from '../services/chaos/redis-hook.js'
import { redisDbIndex, sessionLossRefusal } from '../services/chaos/redis-keys.js'

/**
 * Checks for the Redis, scheduler and partition drills (#2832, #2833, #2838), under /api/chaos:
 *
 *   GET  /checks/cron-overlap?since=&until=   jobs that ran twice at once, runs left half-finished,
 *                                              jobs not safe to run twice (#2833)
 *   POST /partition/probe {sid?, count?, interval_ms?}   send a numbered event train into a probe
 *                                              room from THIS replica (#2838); start it on a replica
 *                                              that is not cut off, before arming the partition
 *   GET  /checks/partition?probe=             expected vs delivered on THIS replica: lost, doubled
 *   GET  /checks/redis                        this replica's Redis fault counters and whether the
 *                                              sessions family may be dropped here (#2832)
 *
 * Reads answer even where the gate refuses drills (they read history); the probe is a drill step.
 */

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof ChaosError)
    return reply
      .code(err.statusCode)
      .send({ error: err.message, code: err.code, details: err.details ?? undefined })
  throw err
}

export async function chaosFredisRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onReady', async () => {
    startChaosTestScheduler(app)
  })

  await app.register(async (adm) => {
    adm.addHook('preHandler', requireAdmin)

    adm.get<{ Querystring: { since?: string; until?: string } }>(
      '/checks/cron-overlap',
      async (req, reply) => {
        const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 3_600_000)
        const until = req.query.until ? new Date(req.query.until) : undefined
        if (Number.isNaN(since.getTime()) || (until && Number.isNaN(until.getTime())))
          return reply.code(400).send({ error: 'since / until must be ISO dates' })
        return { data: await checkCronOverlap(await cronJobsOf(app), { since, until }) }
      }
    )

    adm.get<{ Querystring: { probe?: string } }>('/checks/partition', async (req, reply) => {
      const probe = String(req.query.probe ?? '').trim()
      if (!/^[0-9a-f-]{8,64}$/i.test(probe))
        return reply.code(400).send({ error: 'probe must be a probe id' })
      return { data: await partitionReport(probe) }
    })

    adm.get('/checks/redis', async () => {
      const redis = (app as unknown as { redis?: unknown }).redis
      const db = redisDbIndex(redis)
      return {
        data: {
          db,
          sessions_refusal: sessionLossRefusal(db),
          counters: redisChaosStats(),
          stream_catch_up: partitionCatchUpStats()
        }
      }
    })
  })

  await app.register(async (op) => {
    op.addHook('preHandler', requireChaosOperator)
    op.post<{ Body: { sid?: string; count?: number; interval_ms?: number } }>(
      '/partition/probe',
      async (req, reply) => {
        const why = chaosRefusal()
        if (why) return reply.code(403).send({ error: why, code: 'CHAOS_GATE' })
        try {
          const body = req.body ?? {}
          return reply.code(201).send({
            data: await startPartitionProbe({
              sid: body.sid ?? null,
              count: body.count,
              interval_ms: body.interval_ms
            })
          })
        } catch (err) {
          return fail(reply, err)
        }
      }
    )
  })
}
