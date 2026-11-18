import type { FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import { runInBackgroundPool } from '../../db/pool-context.js'
import { onIssueWrite, pruneHits } from '../issue-raise.js'
import { listConnections } from './connections.js'
import { evaluateQueued, sweep, trimAllDecisions } from './engine.js'
import { trackersEnabled } from './feature.js'
import { noteReconcileFailure, reconcileConnection } from './inbound.js'
import { onRecurrence } from './outbound-sync.js'
import { processOutbox } from './outbox.js'

/**
 * The GitLab sync background work (self-hosted only; every run returns at once while the master
 * switch is off): the rule-engine listener on issue writes, the 5-minute sweep, the outbox worker
 * (every 30 s), the reconcile pass (every 10 min) and the nightly prune.
 */

const EVENTS_KEEP_DAYS = 30
const DAY_MS = 86_400_000

let unsubscribe: (() => void) | null = null

/**
 * Listen to issue writes (once per process): each write evaluates the issue on the background
 * pool, one evaluation per issue at a time (evaluateQueued), never blocking the writer. A raised
 * or recurred issue then goes to onRecurrence (seen-again note, fingerprint join, reopen) — after
 * the engine, so a join the engine made is seen there as an existing member.
 */
export function subscribeEngine(): void {
  if (unsubscribe) return
  unsubscribe = onIssueWrite(({ issueId, kind }) => {
    void runInBackgroundPool(async () => {
      await evaluateQueued(issueId)
      if (kind === 'raised' || kind === 'recurred') await onRecurrence(issueId, kind)
    }).catch(() => {})
  })
}

/** Tests: drop the listener. */
export function unsubscribeEngine(): void {
  unsubscribe?.()
  unsubscribe = null
}

/**
 * Pull changes from GitLab for links touched lately (missed or never-configured webhooks): every
 * active connection in good health, one at a time; one failing never stops the others.
 */
export async function reconcileAll(): Promise<{ checked: number; applied: number }> {
  const tally = { checked: 0, applied: 0 }
  if (!(await trackersEnabled())) return tally
  for (const conn of await listConnections()) {
    if (!conn.is_active || conn.status !== 'ok') continue
    try {
      const r = await reconcileConnection(conn.id)
      tally.checked += r.checked
      tally.applied += r.applied
    } catch (err) {
      // read again next pass (last_reconcile_at did not move); logged ≤ 1 per 10 min
      noteReconcileFailure(conn.id, err)
    }
  }
  return tally
}

/**
 * Nightly: hit counters past 90 days, inbound events past 30 days, decision logs to 200. The hit
 * counters are written by the issue funnel whether or not GitLab sync is on, so they are pruned
 * either way; the tracker tables only while it is on.
 */
export async function pruneTrackers(now = new Date()): Promise<void> {
  await pruneHits()
  if (!(await trackersEnabled())) return
  await db('nivaro_tracker_events')
    .where('received_at', '<', new Date(now.getTime() - EVENTS_KEEP_DAYS * DAY_MS))
    .delete()
  await trimAllDecisions()
}

export function registerTrackerCrons(app: FastifyInstance): void {
  if (process.env.CLOUD_META_DB_URL) return
  subscribeEngine()

  app.cron.schedule(
    'tracker-sweep',
    '*/5 * * * *',
    async () => {
      if (!(await trackersEnabled())) return
      await sweep()
    },
    {
      idempotent: 'safe',
      description:
        'GitLab sync: re-runs the issue rules for issues changed since the last sweep and for issues held by quiet hours whose window has ended.'
    }
  )

  // croner takes a seconds field (staged-imports runs '*/10 * * * * *').
  app.cron.schedule(
    'tracker-outbox',
    '*/30 * * * * *',
    async () => {
      if (!(await trackersEnabled())) return
      await processOutbox()
    },
    {
      quiet: true,
      idempotent: 'safe',
      description: 'GitLab sync: sends queued GitLab writes and retries failed ones with backoff.'
    }
  )

  app.cron.schedule(
    'tracker-reconcile',
    '*/10 * * * *',
    async () => {
      if (!(await trackersEnabled())) return
      await reconcileAll()
    },
    {
      idempotent: 'safe',
      description:
        'GitLab sync: reads recent changes from GitLab for linked issues, in case a webhook was missed.'
    }
  )

  app.cron.schedule(
    'tracker-prune',
    '15 4 * * *',
    async () => {
      await pruneTrackers()
    },
    {
      idempotent: 'safe',
      description:
        'GitLab sync: drops hit counters older than 90 days, inbound events older than 30 days and decision logs beyond 200 per rule.'
    }
  )
}
