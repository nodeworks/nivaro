import type { Knex } from 'knex'
import { db } from '../../db/index.js'
import { legalHoldsReady, whereNotHeld } from '../legal-holds.js'
import { planBridges, type SealedRow } from './chain.js'
import { withTrailLock } from './lock.js'
import { ACTIVITY, BRIDGES, loadBridges, readHead, trailReady, trimHash } from './store.js'

/**
 * THE way activity rows are deleted (#16/#17). Every retention pass (the daily purge's global
 * and per-collection windows, scripts/purge-ephemeral-audit) goes through here, so:
 *
 *   - records under an active legal hold keep their rows (one NOT EXISTS on nivaro_legal_holds);
 *   - rows a revision still points at stay (nivaro_revisions.activity is a NO ACTION FK — an
 *     unbounded DELETE used to fail whole on the first one and took the rest of the purge with it);
 *   - the chain head is never deleted (a shortened chain would look like truncation);
 *   - for every deleted sealed row whose surviving successor sat right after it, a bridge row
 *     keeps the deleted row's hash, so the survivor still verifies;
 *   - each batch runs under the trail lock (never beside a sealer or verify batch).
 *
 * `scope` adds the caller's filter to a query over nivaro_activity (unaliased: write
 * `q.where('timestamp', '<', cutoff)`). Batches of `batch` ids keep each DELETE short.
 */
export interface ActivityPurgeOptions {
  /** Most rows to delete in this call (default 200,000). */
  maxRows?: number
  batch?: number
  /** Count what would go (up to maxRows) without deleting. */
  dryRun?: boolean
  budgetMs?: number
}

export interface ActivityPurgeReport {
  deleted: number
  bridged: number
  more: boolean
  would_delete?: number
}

type Scope = (q: Knex.QueryBuilder) => void

async function candidates(
  scope: Scope,
  limit: number,
  opts: { holds: boolean; sealed: boolean; headSeq: number }
): Promise<Array<{ id: number; seal_seq: number | null; seal_hash: string | null }>> {
  const q = db(ACTIVITY).orderBy(`${ACTIVITY}.id`, 'asc').limit(limit)
  scope(q)
  whereNotHeld(q, `${ACTIVITY}.collection`, `${ACTIVITY}.item`, opts.holds)
  q.whereNotExists(function (this: Knex.QueryBuilder) {
    void this.select(db.raw('1'))
      .from('nivaro_revisions as pr')
      .whereRaw('pr.activity = ??', [`${ACTIVITY}.id`])
  })
  if (opts.sealed) {
    if (opts.headSeq > 0)
      q.where((w) => {
        void w.whereNull(`${ACTIVITY}.seal_seq`).orWhere(`${ACTIVITY}.seal_seq`, '<', opts.headSeq)
      })
    return (await q.select(`${ACTIVITY}.id`, 'seal_seq', 'seal_hash')) as Array<{
      id: number
      seal_seq: number | null
      seal_hash: string | null
    }>
  }
  const rows = (await q.select(`${ACTIVITY}.id`)) as Array<{ id: number }>
  return rows.map((r) => ({ id: Number(r.id), seal_seq: null, seal_hash: null }))
}

/** The next existing sealed row after each deleted sealed row. */
async function nextRows(sealed: SealedRow[]): Promise<Map<number, { id: number; seq: number }>> {
  const out = new Map<number, { id: number; seq: number }>()
  if (sealed.length === 0) return out
  const nexts = (await db(`${ACTIVITY} as d`)
    .whereIn(
      'd.id',
      sealed.map((s) => s.id)
    )
    .select(
      'd.id',
      db.raw(
        `(SELECT MIN(n.seal_seq) FROM ${ACTIVITY} n WHERE n.seal_seq > d.seal_seq) AS next_seq`
      )
    )) as Array<{ id: number; next_seq: number | string | null }>
  const seqs = [...new Set(nexts.filter((n) => n.next_seq != null).map((n) => Number(n.next_seq)))]
  const bySeq = new Map<number, number>()
  for (let i = 0; i < seqs.length; i += 1000) {
    const rows = (await db(ACTIVITY)
      .whereIn('seal_seq', seqs.slice(i, i + 1000))
      .select('id', 'seal_seq')) as Array<{ id: number; seal_seq: number | string }>
    for (const r of rows) bySeq.set(Number(r.seal_seq), Number(r.id))
  }
  for (const n of nexts) {
    if (n.next_seq == null) continue
    const id = bySeq.get(Number(n.next_seq))
    if (id != null) out.set(Number(n.id), { id, seq: Number(n.next_seq) })
  }
  return out
}

async function purgeBatch(
  scope: Scope,
  batch: number
): Promise<{ deleted: number; bridged: number; read: number }> {
  const sealedOn = await trailReady()
  const holds = await legalHoldsReady()
  const head = sealedOn ? await readHead() : { seq: 0 }
  const rows = await candidates(scope, batch, { holds, sealed: sealedOn, headSeq: head.seq })
  if (rows.length === 0) return { deleted: 0, bridged: 0, read: 0 }
  const ids = rows.map((r) => Number(r.id))
  const sealed: SealedRow[] = rows
    .filter((r) => r.seal_seq != null && r.seal_hash != null)
    .map((r) => ({ id: Number(r.id), seq: Number(r.seal_seq), hash: trimHash(r.seal_hash) }))
  let plan: Array<{ activity_id: number; prev_hash: string; prev_seq: number }> = []
  if (sealedOn && sealed.length > 0) {
    const nextOf = await nextRows(sealed)
    const survivors = [...new Set([...nextOf.values()].map((n) => n.id))].filter(
      (id) => !ids.includes(id)
    )
    const already = new Set((await loadBridges(survivors)).keys())
    plan = planBridges(sealed, nextOf, already)
  }
  const purgedAt = new Date()
  await db.transaction(async (trx) => {
    for (let i = 0; i < plan.length; i += 400)
      await trx(BRIDGES).insert(plan.slice(i, i + 400).map((b) => ({ ...b, purged_at: purgedAt })))
    if (sealedOn) await trx(BRIDGES).whereIn('activity_id', ids).del()
    await trx(ACTIVITY).whereIn('id', ids).del()
  })
  return { deleted: ids.length, bridged: plan.length, read: rows.length }
}

export async function purgeActivityRows(
  scope: Scope,
  opts: ActivityPurgeOptions = {}
): Promise<ActivityPurgeReport> {
  const max = Math.max(1, opts.maxRows ?? 200_000)
  const batch = Math.min(Math.max(opts.batch ?? 500, 1), 1000)
  const deadline = Date.now() + (opts.budgetMs ?? 10 * 60_000)
  if (opts.dryRun) {
    const holds = await legalHoldsReady()
    const sealedOn = await trailReady()
    const head = sealedOn ? await readHead() : { seq: 0 }
    const rows = await candidates(scope, max, { holds, sealed: sealedOn, headSeq: head.seq })
    return { deleted: 0, bridged: 0, more: rows.length >= max, would_delete: rows.length }
  }
  let deleted = 0
  let bridged = 0
  let more = false
  while (deleted < max) {
    if (Date.now() > deadline) {
      more = true
      break
    }
    const want = Math.min(batch, max - deleted)
    const step = await withTrailLock(() => purgeBatch(scope, want), 60_000)
    deleted += step.deleted
    bridged += step.bridged
    if (step.read < want) break
    if (deleted >= max) more = true
  }
  return { deleted, bridged, more }
}
