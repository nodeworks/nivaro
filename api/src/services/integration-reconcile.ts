/**
 * Reconciliation — the layer that does not believe the triggers.
 *
 * Every other part of this feature learns what happened from the mechanism
 * that made it happen, which cannot see the case where the mechanism never
 * ran: a raw-SQL import that bypasses hooks, a transition missing its action,
 * a paused cron, a guard that is simply wrong. So each registered kind
 * declares `expect(db)` — the records the partner is BEHIND on, derived from
 * data alone — and this sweep compares that with the ledger.
 *
 * It writes truth and never sends. The one outcome worth naming: a `skipped`
 * whose expectation still holds after the grace window becomes `overdue`,
 * keeping its original reason. That is the wrong-guard detector, and it is
 * the only thing in the system that can find one.
 */
import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'
import {
  type ExpectedObligation,
  type ObligationKindDef,
  type ObligationOutcome,
  OPEN_OUTCOMES,
  allObligationKinds,
  recordObligation,
  resolveObligation
} from './integration-obligations.js'

const DEFAULT_ACK_GRACE_MINUTES = 60
const DEFAULT_SKIP_GRACE_MINUTES = 30
/** Per kind, per sweep. A kind past this reports truncation rather than
 *  quietly reconciling an arbitrary slice. */
const EXPECT_CEILING = 20_000

export interface LedgerRowForSweep {
  id: number
  outcome: ObligationOutcome
  reason: string | null
  due_at: Date
  resolved_at: Date | null
}

export interface ReconcileDecision {
  item: string
  outcome: 'missing' | 'overdue' | 'superseded' | 'none'
  reason: string | null
  /** The ledger row this decision applies to; null when a row must be created. */
  obligation_id: number | null
}

function minutesBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 60_000
}

/** The whole sweep policy, pure. */
export function decideReconcile(opts: {
  expected: ExpectedObligation | null
  latest: LedgerRowForSweep | null
  now: Date
  ackGraceMinutes: number
  skipGraceMinutes: number
}): ReconcileDecision {
  const { expected, latest, now, ackGraceMinutes, skipGraceMinutes } = opts

  if (!expected) {
    // The record moved on. Anything still open is history now — "open" here
    // is exactly OPEN_OUTCOMES (pending/failed/overdue/missing): a closed
    // `sent`, `skipped` or already-`superseded` row is never rewritten.
    if (latest && OPEN_OUTCOMES.includes(latest.outcome)) {
      return {
        item: String(latest.id),
        outcome: 'superseded',
        reason: 'the expectation no longer holds — the record moved on',
        obligation_id: latest.id
      }
    }
    return { item: '', outcome: 'none', reason: null, obligation_id: null }
  }

  const item = expected.item

  if (!latest) {
    return {
      item,
      outcome: 'missing',
      reason: 'no send was ever attempted — the trigger did not fire',
      obligation_id: null
    }
  }

  const age = minutesBetween(now, latest.resolved_at ?? latest.due_at)

  if (latest.outcome === 'skipped') {
    if (age < skipGraceMinutes) return { item, outcome: 'none', reason: null, obligation_id: null }
    // The wrong-guard detector: the mechanism decided not to send, and the
    // partner still does not have it.
    return {
      item,
      outcome: 'overdue',
      reason: `skipped: ${latest.reason ?? 'no reason recorded'} — but the partner still lacks it`,
      obligation_id: latest.id
    }
  }

  if (latest.outcome === 'pending') {
    if (age < ackGraceMinutes) return { item, outcome: 'none', reason: null, obligation_id: null }
    return {
      item,
      outcome: 'overdue',
      reason: `no acknowledgement in ${ackGraceMinutes} minutes`,
      obligation_id: latest.id
    }
  }

  if (latest.outcome === 'sent') {
    return {
      item,
      outcome: 'overdue',
      reason: 'recorded as sent, but the partner is still behind',
      obligation_id: latest.id
    }
  }

  // failed / overdue / missing — already loud, and remediation owns them.
  // Re-writing them each sweep would churn notified_at and re-alert.
  return { item, outcome: 'none', reason: null, obligation_id: null }
}

async function graceFor(api: string): Promise<{ ack: number; skip: number }> {
  try {
    const row = (await db('nivaro_external_apis')
      .where({ name: api })
      .first('ack_grace_minutes', 'skip_grace_minutes')) as
      | { ack_grace_minutes: number | null; skip_grace_minutes: number | null }
      | undefined
    return {
      ack: row?.ack_grace_minutes ?? DEFAULT_ACK_GRACE_MINUTES,
      skip: row?.skip_grace_minutes ?? DEFAULT_SKIP_GRACE_MINUTES
    }
  } catch {
    return { ack: DEFAULT_ACK_GRACE_MINUTES, skip: DEFAULT_SKIP_GRACE_MINUTES }
  }
}

/** Newest ledger row per item for one kind, in one query. */
async function latestByItem(
  def: ObligationKindDef,
  items: string[]
): Promise<Map<string, LedgerRowForSweep>> {
  const out = new Map<string, LedgerRowForSweep>()
  if (items.length === 0) return out
  const rows = (await selectInChunks(items, 1000, (chunk) =>
    db('nivaro_integration_obligations')
      .where({ api: def.api, kind: def.kind, collection: def.collection })
      .whereIn('item', chunk)
      .orderBy('id', 'desc')
      .select('id', 'item', 'outcome', 'reason', 'due_at', 'resolved_at')
  )) as Array<LedgerRowForSweep & { item: string }>
  // Ordered id DESC, so the first row per item is its newest.
  for (const r of rows) if (!out.has(r.item)) out.set(r.item, r)
  return out
}

export async function reconcileKind(
  def: ObligationKindDef,
  database: Knex = db,
  now: Date = new Date()
): Promise<{
  kind: string
  missing: number
  overdue: number
  superseded: number
  expected: number
  truncated: boolean
}> {
  const expectedRows = await def.expect(database)
  const truncated = expectedRows.length > EXPECT_CEILING
  const rows = truncated ? expectedRows.slice(0, EXPECT_CEILING) : expectedRows
  const grace = await graceFor(def.api)
  const skipGrace = def.grace_minutes ?? grace.skip

  const byItem = new Map(rows.map((r) => [String(r.item), r]))
  const latest = await latestByItem(def, [...byItem.keys()])

  let missing = 0
  let overdue = 0
  let superseded = 0

  for (const [item, expected] of byItem) {
    const d = decideReconcile({
      expected,
      latest: latest.get(item) ?? null,
      now,
      ackGraceMinutes: grace.ack,
      skipGraceMinutes: skipGrace
    })
    if (d.outcome === 'none') continue
    if (d.outcome === 'missing') {
      missing++
      await recordObligation({
        api: def.api,
        kind: def.kind,
        collection: def.collection,
        item,
        trigger: 'reconcile',
        trigger_ref: 'integration-reconcile',
        // The data's own timestamp — when the partner started being behind.
        due_at: expected.due_at,
        outcome: 'missing',
        reason: d.reason,
        detail: expected.detail ? { note: expected.detail } : undefined
      })
    } else if (d.outcome === 'overdue') {
      overdue++
      await resolveObligation(d.obligation_id, { outcome: 'overdue', reason: d.reason })
    }
  }

  // Anything open for this kind whose item is no longer expected has been
  // overtaken by events.
  const openRows = (await database('nivaro_integration_obligations')
    .where({ api: def.api, kind: def.kind, collection: def.collection })
    .whereIn('outcome', OPEN_OUTCOMES)
    .select('id', 'item')) as Array<{ id: number; item: string }>
  for (const r of openRows) {
    if (byItem.has(String(r.item))) continue
    superseded++
    await resolveObligation(r.id, {
      outcome: 'superseded',
      reason: 'the expectation no longer holds — the record moved on'
    })
  }

  return { kind: def.kind, missing, overdue, superseded, expected: rows.length, truncated }
}

export async function runIntegrationReconcile(): Promise<{
  kinds: number
  missing: number
  overdue: number
  superseded: number
  errors: string[]
}> {
  const defs = allObligationKinds()
  const totals = { kinds: defs.length, missing: 0, overdue: 0, superseded: 0, errors: [] as string[] }
  for (const def of defs) {
    try {
      const r = await reconcileKind(def, db)
      totals.missing += r.missing
      totals.overdue += r.overdue
      totals.superseded += r.superseded
      if (r.truncated) totals.errors.push(`${def.kind}: expectation set truncated at ${EXPECT_CEILING}`)
    } catch (err) {
      // One kind's broken query must never hide the other twelve.
      totals.errors.push(`${def.kind}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return totals
}

/** What a tick WOULD do, writing nothing — the Background Jobs dry run. */
export async function dryRunIntegrationReconcile(): Promise<unknown> {
  const out: Array<{ kind: string; expected: number }> = []
  for (const def of allObligationKinds()) {
    try {
      const rows = await def.expect(db)
      out.push({ kind: def.kind, expected: rows.length })
    } catch (err) {
      out.push({ kind: def.kind, expected: -1 })
      void err
    }
  }
  return { kinds: out.length, behind: out }
}
