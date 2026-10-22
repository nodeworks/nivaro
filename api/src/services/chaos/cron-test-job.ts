import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { CronManager } from '../../plugins/cron.js'
import { chaosRefusal } from './gate.js'

/**
 * The harmless job a lease-split drill (#2833) is proven against: `CHAOS_TEST_CRON=1` starts a
 * scheduler of its own on this process holding ONE job, `chaos-test-overlap`, that only sleeps
 * (`CHAOS_TEST_CRON_MS`, default 12 s) every 10 s — longer than its interval, like a poll on a
 * bad day, so a replica that takes the lease mid-run starts it again while the old run is still
 * going. It competes for its own lease key (never the real scheduler's) and ticks while the
 * real ticks stay off, so no real job ever runs on a shared database. Never on production, never
 * where the chaos gate refuses.
 */

export const CHAOS_TEST_JOB = 'chaos-test-overlap'
export const CHAOS_TEST_LEASE = 'nvr:cron:leader:chaos-test'

let manager: CronManager | null = null

export function chaosTestCronWanted(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CHAOS_TEST_CRON === '1' && env.NODE_ENV !== 'production' && !chaosRefusal(env)
}

export function startChaosTestScheduler(app: FastifyInstance): CronManager | null {
  const redis = (app as unknown as { redis?: Redis }).redis
  if (manager || !redis || !chaosTestCronWanted()) return manager
  const sleepMs = Math.min(120_000, Math.max(100, Number(process.env.CHAOS_TEST_CRON_MS) || 12_000))
  const m = new CronManager({
    ticksEnabled: () => true,
    scheduledTrigger: 'manual',
    leaseKey: CHAOS_TEST_LEASE,
    onIssue: (message) => app.log.warn(`[chaos test cron] ${message}`)
  })
  m.startLeaderElection(redis)
  m.schedule(CHAOS_TEST_JOB, '*/10 * * * * *', () => new Promise((r) => setTimeout(r, sleepMs)), {
    idempotent: 'unknown',
    description: 'Chaos test job (#2833): sleeps, nothing else. Only with CHAOS_TEST_CRON=1.',
    watchdogMs: sleepMs * 3
  })
  manager = m
  app.addHook('onClose', async () => {
    await m.leader.stop()
    m.stopAll()
    manager = null
  })
  app.log.warn(`Chaos test scheduler on: "${CHAOS_TEST_JOB}" every 10 s, sleeping ${sleepMs} ms`)
  return m
}

/** The test scheduler, when this process runs one. */
export function chaosTestScheduler(): CronManager | null {
  return manager
}
