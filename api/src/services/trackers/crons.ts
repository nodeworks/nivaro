import type { FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import { runInBackgroundPool } from '../../db/pool-context.js'
import { onIssueWrite, pruneHits } from '../issue-raise.js'
import { onTicketWrite } from '../support-ticket-events.js'
import { currentTenantKey } from '../tenant-rooms.js'
import { listConnections } from './connections.js'
import {
  evaluateQueued,
  evaluateTicketQueued,
  noteEvaluationFailure,
  sweep,
  trimAllDecisions
} from './engine.js'
import { trackersEnabled } from './feature.js'
import {
  type NoteLockRedis,
  noteReconcileFailure,
  reconcileConnection,
  setTrackerRedis
} from './inbound.js'
import { onRecurrence } from './outbound-sync.js'
import { processOutbox, pruneOutbox } from './outbox.js'

/**
 * The GitLab sync background work (self-hosted only; every run returns at once while the master
 * switch is off): the rule-engine listener on issue writes, the 5-minute sweep, the outbox worker
 * (every 30 s), the reconcile pass (every 10 min) and the nightly prune.
 */

const EVENTS_KEEP_DAYS = 30
const DAY_MS = 86_400_000

let unsubscribe: (() => void) | null = null
let unsubscribeTickets: (() => void) | null = null

/**
 * Listen to issue writes (once per process): each write evaluates the issue on the background
 * pool, one evaluation per issue at a time (evaluateQueued), never blocking the writer. A raised
 * or recurred issue then goes to onRecurrence (seen-again note, fingerprint join, reopen) — after
 * the engine, so a join the engine made is seen there as an existing member.
 */
export function subscribeEngine(): void {
  if (unsubscribe) return
  unsubscribe = onIssueWrite((e) => {
    void runInBackgroundPool(() => handleIssueWrite(e)).catch(() => {})
  })
  // support-ticket rules: each ticket write (raised / changed) evaluates the ticket
  unsubscribeTickets = onTicketWrite((e) => {
    void runInBackgroundPool(() => evaluateTicketQueued(e.ticketId)).catch(() => {})
  })
}

/** One issue write: the rule engine, then (raised / recurred) onRecurrence — even if the engine
 *  failed (logged, rate limited). Never throws. */
export async function handleIssueWrite({
  issueId,
  kind
}: {
  issueId: number
  kind: 'raised' | 'recurred' | 'changed'
}): Promise<void> {
  try {
    await evaluateQueued(issueId)
  } catch (err) {
    noteEvaluationFailure(issueId, err)
  }
  if (kind === 'raised' || kind === 'recurred') await recurQueued(issueId, kind)
}

// onRecurrence once at a time per issue (final review M6): a write that arrives meanwhile asks for
// one more run of its kind afterwards ('raised' before 'recurred'), so a storm of recurrences of
// one issue costs two or three runs, not one per write. Tenant-keyed.
const recurInFlight = new Set<string>()
const recurAgain = new Map<string, Set<'raised' | 'recurred'>>()

async function recurQueued(issueId: number, kind: 'raised' | 'recurred'): Promise<void> {
  const key = `${currentTenantKey()}|${issueId}`
  if (recurInFlight.has(key)) {
    const kinds = recurAgain.get(key) ?? new Set()
    kinds.add(kind)
    recurAgain.set(key, kinds)
    return
  }
  recurInFlight.add(key)
  try {
    let kinds: Array<'raised' | 'recurred'> = [kind]
    while (kinds.length) {
      for (const k of kinds) await onRecurrence(issueId, k)
      const more = recurAgain.get(key)
      recurAgain.delete(key)
      kinds = more ? (['raised', 'recurred'] as const).filter((k) => more.has(k)) : []
    }
  } finally {
    recurInFlight.delete(key)
    recurAgain.delete(key)
  }
}

/** Tests: drop the listener. */
export function unsubscribeEngine(): void {
  unsubscribe?.()
  unsubscribe = null
  unsubscribeTickets?.()
  unsubscribeTickets = null
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
 * Nightly: hit counters past 90 days, inbound events past 30 days, decision logs to 200, sent
 * outbox rows past 90 days (creates kept for their idempotency keys). The hit
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
  await pruneOutbox(now)
}

export function registerTrackerCrons(app: FastifyInstance): void {
  if (process.env.CLOUD_META_DB_URL) return
  // the per-note lock of the reconcile pass (same Redis as the webhook's)
  setTrackerRedis((app as { redis?: NoteLockRedis }).redis)
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
        'GitLab sync: drops hit counters older than 90 days, inbound events older than 30 days, decision logs beyond 200 per rule and sent GitLab writes older than 90 days (creates are kept).'
    }
  )
}
