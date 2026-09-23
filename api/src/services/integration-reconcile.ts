/**
 * Reconciliation — the layer that does not believe the triggers.
 *
 * Every other part of this feature learns what happened from the mechanism
 * that made it happen, which cannot see the case where the mechanism never
 * ran: a raw-SQL import that bypasses hooks, a transition missing its action,
 * a paused cron, a guard that is simply wrong. So each registered kind
 * declares `expect(db, {epoch})` — the records the partner is BEHIND on,
 * derived from data alone and bounded by `getObligationsEpoch` so a kind
 * never flags a record older than obligations started counting — and this
 * sweep compares that with the ledger.
 *
 * It writes truth and never sends. The one outcome worth naming: a `skipped`
 * whose expectation still holds after the grace window becomes `overdue`,
 * keeping its original reason. That is the wrong-guard detector, and it is
 * the only thing in the system that can find one.
 */

import type { FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'
import {
  allObligationKinds,
  type ExpectedObligation,
  getObligationsEpoch,
  type ObligationKindDef,
  type ObligationOutcome,
  OPEN_OUTCOMES,
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

async function graceFor(api: string, database: Knex = db): Promise<{ ack: number; skip: number }> {
  try {
    const row = (await database('nivaro_external_apis')
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
  items: string[],
  database: Knex = db
): Promise<Map<string, LedgerRowForSweep>> {
  const out = new Map<string, LedgerRowForSweep>()
  if (items.length === 0) return out
  const rows = (await selectInChunks(items, 1000, (chunk) =>
    database('nivaro_integration_obligations')
      .where({ api: def.api, kind: def.kind, collection: def.collection })
      .whereIn('item', chunk)
      .orderBy('id', 'desc')
      .select('id', 'item', 'outcome', 'reason', 'due_at', 'resolved_at')
  )) as Array<LedgerRowForSweep & { item: string }>
  // Ordered id DESC, so the first row per item is its newest.
  for (const r of rows) if (!out.has(r.item)) out.set(r.item, r)
  return out
}

/**
 * Duplicate obligations for one record/kind (spec §2.2): only the NEWEST row
 * for an item is the current truth. An older row still sitting in an OPEN
 * outcome — orphaned by a crash between open and resolve, or any path that
 * opened more than one row for the same item — is neither "the latest" (so
 * it can never age into `overdue` on its own) nor reached by the item-level
 * supersede in `reconcileKind` (the item is still expected, so that loop
 * skips it). Superseded here instead, scoped to the items this sweep is
 * already looking at, and never the newest row itself — what happens to
 * that one is decided by `decideReconcile`.
 */
async function supersedeOlderOpenRows(
  def: ObligationKindDef,
  database: Knex,
  items: string[],
  latest: Map<string, LedgerRowForSweep>
): Promise<number> {
  if (items.length === 0) return 0
  const rows = (await selectInChunks(items, 1000, (chunk) =>
    database('nivaro_integration_obligations')
      .where({ api: def.api, kind: def.kind, collection: def.collection })
      .whereIn('item', chunk)
      .whereIn('outcome', OPEN_OUTCOMES)
      .orderBy('id', 'asc')
      .select('id', 'item')
  )) as Array<{ id: number; item: string }>
  let superseded = 0
  for (const r of rows) {
    const newestId = latest.get(String(r.item))?.id
    if (newestId == null || r.id === newestId) continue
    superseded++
    await resolveObligation(r.id, {
      outcome: 'superseded',
      reason: `superseded by obligation ${newestId}`
    })
  }
  return superseded
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
  const epoch = await getObligationsEpoch(database)
  const expectedRows = await def.expect(database, { epoch })
  const truncated = expectedRows.length > EXPECT_CEILING
  const rows = truncated ? expectedRows.slice(0, EXPECT_CEILING) : expectedRows
  const grace = await graceFor(def.api, database)
  const skipGrace = def.grace_minutes ?? grace.skip

  const byItem = new Map(rows.map((r) => [String(r.item), r]))
  const items = [...byItem.keys()]
  const latest = await latestByItem(def, items, database)

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

  superseded += await supersedeOlderOpenRows(def, database, items, latest)

  // Anything open for this kind whose item is no longer expected has been
  // overtaken by events.
  //
  // SKIPPED ENTIRELY when the expectation set was truncated: `byItem` then
  // holds only the first EXPECT_CEILING expectations, while this loop scans
  // EVERY open row for the kind — so items past the cap are still genuinely
  // expected but would be closed here as "the record moved on", which is
  // false, and which closes them to alerting, to the board's unmet tiles and
  // to remediation. Worse, `expect()` carries no ordering contract, so the
  // slice is not stable between ticks: consecutive sweeps would supersede one
  // half and re-open the other as `missing`, alternating. A truncated kind
  // reports its truncation (runIntegrationReconcile adds it to `errors`) and
  // reconciles only what it could see.
  if (!truncated) {
    const openRows = (await database('nivaro_integration_obligations')
      .where({ api: def.api, kind: def.kind, collection: def.collection })
      .whereIn('outcome', OPEN_OUTCOMES)
      .orderBy('id', 'asc')
      .select('id', 'item')) as Array<{ id: number; item: string }>
    for (const r of openRows) {
      if (byItem.has(String(r.item))) continue
      superseded++
      await resolveObligation(r.id, {
        outcome: 'superseded',
        reason: 'the expectation no longer holds — the record moved on'
      })
    }
  }

  return { kind: def.kind, missing, overdue, superseded, expected: rows.length, truncated }
}

export async function runIntegrationReconcile(): Promise<{
  kinds: number
  missing: number
  overdue: number
  superseded: number
  errors: string[]
  /** How many of `kinds` threw out of `expect()` — distinct from a kind that
   *  merely truncated (its own `expect()` succeeded, just capped): that one
   *  also adds a line to `errors`, but it is not a failure. */
  failed: number
}> {
  const defs = allObligationKinds()

  // Sampled before anything below writes a row, so a partner whose last
  // unmet obligation this very tick resolves counts as recovered by the
  // time the flip is written at the end. Nothing is registered on a bare
  // install (Phase 1, dormant-safe) — the sweep must touch the database not
  // at all in that case, so incident tracking is skipped along with
  // everything else when there is nothing to reconcile.
  const healthBefore =
    defs.length > 0 ? await (await import('./integration-incidents.js')).currentApiHealth() : []

  const totals = {
    kinds: defs.length,
    missing: 0,
    overdue: 0,
    superseded: 0,
    errors: [] as string[],
    failed: 0
  }
  for (const def of defs) {
    try {
      const r = await reconcileKind(def, db)
      totals.missing += r.missing
      totals.overdue += r.overdue
      totals.superseded += r.superseded
      if (r.truncated) {
        totals.errors.push(
          `${def.kind}: expectation set truncated at ${EXPECT_CEILING} (${r.expected} reconciled) — ` +
            'the "no longer expected" supersede was skipped for this kind, so nothing past the cap ' +
            'was closed on a partial view'
        )
      }
    } catch (err) {
      // One kind's broken query must never hide the other twelve.
      totals.failed++
      totals.errors.push(`${def.kind}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Tell the people who can do something about it — the failed/missing/
  // overdue rows this pass just wrote, and any `failed` a writer stamped
  // between sweeps. Best-effort: an alerting failure must never make the
  // sweep itself look like it failed — the ledger is already true by now.
  {
    const { alertUnmetObligations } = await import('./integration-alerts.js')
    await alertUnmetObligations().catch(() => ({ notified: 0 }))
  }

  // Last, so a retry that landed inside this same tick counts as recovery
  // rather than a flip nobody ever sees.
  if (defs.length > 0) {
    const { recordIncidentFlips } = await import('./integration-incidents.js')
    await recordIncidentFlips(healthBefore)
  }

  // Task 19 — remediation: retry the failures worth retrying, and re-fire a
  // `missing` obligation once. Gated the same way incidents just were above
  // (only when at least one kind is registered) — a bare install with
  // nothing registered has trivially nothing in THIS ledger to act on, and
  // must touch the database not at all, same as every other pass in this
  // function. Both passes gate themselves on the deployment's own
  // remediation switch too, so this call is inert on arrival regardless of
  // whether kinds are registered — wrapped so a failure here can never make
  // the sweep itself look like it failed, the same posture as alerting.
  if (defs.length > 0) {
    const rem = await import('./integration-remediation.js')
    await rem.runRetryPass().catch(() => ({ retried: 0, gaveUp: 0 }))
    await rem.runMissingRefirePass().catch(() => ({ refired: 0, queued: 0 }))
  }

  return totals
}

/** What a tick WOULD do, writing nothing — the Background Jobs dry run. */
export async function dryRunIntegrationReconcile(): Promise<unknown> {
  const out: Array<{ kind: string; expected: number }> = []
  for (const def of allObligationKinds()) {
    try {
      const epoch = await getObligationsEpoch(db)
      const rows = await def.expect(db, { epoch })
      out.push({ kind: def.kind, expected: rows.length })
    } catch {
      out.push({ kind: def.kind, expected: -1 })
    }
  }
  return { kinds: out.length, behind: out }
}

/**
 * The cron entry point — `server.ts` calls only this, so the visibility
 * logic lives with the sweep instead of being copied into the registration
 * site. Logs every entry of `errors` (a truncated kind included — it is
 * still worth a line, just not a failure), and when EVERY registered kind's
 * own `expect()` threw, throws itself — so `cron.ts`'s job-run wrapper marks
 * the tick failed instead of a total-outage night reading identical to a
 * quiet, healthy one. A tick with zero registered kinds is not a failure.
 */
export async function runIntegrationReconcileForCron(app: FastifyInstance): Promise<{
  kinds: number
  missing: number
  overdue: number
  superseded: number
  errors: string[]
  failed: number
}> {
  const r = await runIntegrationReconcile()
  if (r.missing > 0 || r.overdue > 0) {
    app.log.warn(
      { missing: r.missing, overdue: r.overdue, superseded: r.superseded },
      'integration reconcile found unmet obligations'
    )
  }
  for (const e of r.errors) {
    app.log.warn({ err: e }, 'integration reconcile: a kind reported an error')
  }
  if (r.kinds > 0 && r.failed === r.kinds) {
    throw new Error(`integration reconcile: every registered kind failed — ${r.errors.join('; ')}`)
  }
  return r
}
