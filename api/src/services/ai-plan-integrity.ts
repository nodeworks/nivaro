import { db } from '../db/index.js'
import type { User } from '../types.js'
import type { PlanMadeRecord } from './ai-plan-runner.js'
import { isAdminUser, labelsFor, registerPlanStepKind } from './ai-plan-steps.js'
import { httpError, type PlanView, proposePlan } from './ai-plans.js'
import { getApp } from './io-holder.js'

/**
 * Fix a Data Integrity CLUSTER with a plan (#2006). A cluster is one field +
 * rule of a conformance run (the facet the Data Integrity page already
 * groups findings by — "these 340 lines fail the cascade on category").
 * The step applies the same fix engine "Apply confident fixes" uses
 * (integrity-proposals.ts): per record, the top proposal when it is HIGH
 * confidence and of an unattended-safe kind — previewed record by record
 * (old → new) in the plan's change report before anyone approves. At run
 * time each record's proposals are rebuilt and the fix is applied only when
 * the same proposal (content-hashed id) still stands. Administrators only,
 * like Data Integrity itself.
 */

const MAX_RECORDS = 200
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

interface ClusterItem {
  id: string
  message: string | null
  proposal_id: string
}

async function loadRun(runId: unknown): Promise<{ id: number; collection: string }> {
  const id = Number(runId)
  if (!Number.isInteger(id) || id <= 0) throw new Error('integrity_fix needs a conformance run id')
  const run = (await db('nivaro_conformance_runs').where({ id }).first('id', 'collection')) as
    | { id: number; collection: string }
    | undefined
  if (!run) throw new Error(`Conformance run #${id} not found`)
  return { id: Number(run.id), collection: String(run.collection) }
}

registerPlanStepKind({
  kind: 'integrity_fix',
  label: 'Fix data integrity findings',
  describe:
    'integrity_fix: {run, field, rule} — administrators: apply the confident Data Integrity fix to every record in one cluster (a field + rule of a conformance run).',
  async propose(user, input) {
    if (!(await isAdminUser(user)))
      throw new Error('Only administrators can fix integrity findings')
    const run = await loadRun(input.run)
    const field = String(input.field ?? '')
    const rule = String(input.rule ?? '')
    if (!IDENT.test(field) || !rule) throw new Error('integrity_fix needs a field and a rule')
    const findings = (await db('nivaro_conformance_findings')
      .where({ run: run.id, field, rule })
      .orderBy('id', 'asc')
      .select('item_id', 'message')) as Array<{ item_id: string; message: string | null }>
    const byItem = new Map<string, string | null>()
    for (const f of findings)
      if (!byItem.has(String(f.item_id))) byItem.set(String(f.item_id), f.message)
    if (byItem.size === 0) throw new Error('This cluster has no findings left')
    const { AUTO_APPLY_KINDS, proposeFixes } = await import('./integrity-proposals.js')
    const items: ClusterItem[] = []
    const rows: Array<Record<string, unknown>> = []
    let needsPerson = 0
    for (const [id, message] of [...byItem].slice(0, MAX_RECORDS)) {
      const proposals = await proposeFixes(run.collection, id, { field, rule, message })
      const pick = proposals.find(
        (p) =>
          p.confidence === 'high' && AUTO_APPLY_KINDS.includes(p.kind) && p.kind !== 'regenerate'
      )
      if (!pick) {
        needsPerson++
        continue
      }
      items.push({ id, message, proposal_id: pick.id })
      for (const pv of pick.preview) rows.push({ ...pv })
    }
    if (items.length === 0) {
      throw new Error('No record in this cluster has a confident fix — they need a person')
    }
    const labels = await labelsFor(
      run.collection,
      items.map((i) => i.id)
    )
    const more = byItem.size > MAX_RECORDS ? byItem.size - MAX_RECORDS : 0
    return {
      payload: { run: run.id, collection: run.collection, field, rule, items },
      preview: {
        summary: `Fix ${field} (${rule}) on ${items.length} ${run.collection} record${items.length === 1 ? '' : 's'}`,
        count: items.length,
        collection: run.collection,
        changes: {
          Field: field,
          Rule: rule,
          ...(needsPerson ? { 'Need a person': needsPerson } : {}),
          ...(more ? { 'Left for a later plan': more } : {})
        },
        sample: items.slice(0, 8).map((i) => ({ id: i.id, label: labels[i.id] ?? `#${i.id}` })),
        rows: rows.slice(0, 1000)
      },
      targets: { collection: run.collection, ids: items.map((i) => i.id) }
    }
  },
  async execute(user, payload) {
    if (!(await isAdminUser(user)))
      throw new Error('Only administrators can fix integrity findings')
    const app = getApp()
    if (!app) throw new Error('Data Integrity is not available right now')
    const collection = String(payload.collection)
    const field = String(payload.field)
    const rule = String(payload.rule)
    const runId = Number(payload.run)
    const { applyProposal, proposeFixes } = await import('./integrity-proposals.js')
    const { latestRevisionIds } = await import('./ai-plan-made.js')
    let fixed = 0
    const errors: string[] = []
    const failedIds: string[] = []
    const made: PlanMadeRecord[] = []
    for (const item of (payload.items as ClusterItem[]) ?? []) {
      const finding = { field, rule, message: item.message }
      try {
        const pick = (await proposeFixes(collection, item.id, finding)).find(
          (p) => p.id === item.proposal_id
        )
        if (!pick) throw new Error('the fix changed since it was previewed')
        const r = await applyProposal(app, user, collection, item.id, pick, finding)
        if (r.failed.length > 0) throw new Error(r.failed[0].error)
        fixed++
        // Undo writes carry the before-values; the proposal's writes the after.
        for (const u of r.undo) {
          if (!u.item_id) continue
          const w = pick.writes.find(
            (x) => x.item_id === u.item_id && x.collection === u.collection
          )
          made.push({
            id: String(u.item_id),
            collection: u.collection,
            before: u.op === 'update' ? (u.data ?? {}) : {},
            after: w?.data ?? {},
            rev: null,
            ...(u.op === 'delete' ? { created: true } : {})
          })
        }
        await db('nivaro_conformance_findings')
          .where({ run: runId, item_id: item.id, field, rule })
          .modify((qb) => {
            if (item.message) qb.where('message', item.message.slice(0, 1000))
          })
          .del()
          .catch(() => undefined)
      } catch (err) {
        failedIds.push(item.id)
        if (errors.length < 10) errors.push(`${item.id}: ${(err as Error)?.message ?? 'failed'}`)
      }
    }
    // Newest revision per written record, so undo can tell a later edit.
    const byCollection = new Map<string, string[]>()
    for (const m of made)
      byCollection.set(m.collection ?? collection, [
        ...(byCollection.get(m.collection ?? collection) ?? []),
        m.id
      ])
    for (const [c, ids] of byCollection) {
      const revs = await latestRevisionIds(c, ids)
      for (const m of made) if ((m.collection ?? collection) === c) m.rev = revs.get(m.id) ?? null
    }
    return {
      ok: failedIds.length === 0,
      result: { fixed, failed: failedIds.length, errors, failed_ids: failedIds },
      records_changed: fixed,
      error: failedIds.length
        ? `${failedIds.length} record(s) not fixed: ${errors.slice(0, 3).join('; ')}`
        : undefined,
      made: made.length ? { collection, records: made } : null
    }
  },
  narrow(payload, ids) {
    const keep = new Set(ids.map(String))
    return {
      ...payload,
      items: ((payload.items as ClusterItem[]) ?? []).filter((i) => keep.has(String(i.id)))
    }
  }
})

/** Offer a cluster's fix as a plan the administrator reviews and approves. */
export async function proposeIntegrityPlan(
  admin: User,
  runId: number,
  field: string,
  rule: string
): Promise<PlanView> {
  if (!(await isAdminUser(admin)))
    throw httpError('Only administrators can fix integrity findings', 403)
  const run = await loadRun(runId).catch((err: Error) => {
    throw httpError(err.message, 404)
  })
  try {
    return await proposePlan(
      admin,
      {
        title: `Fix ${field} (${rule}) on ${run.collection}`,
        steps: [{ kind: 'integrity_fix', run: run.id, field, rule }]
      },
      {
        source: { kind: 'integrity', label: `Data Integrity run #${run.id}`, ref: String(run.id) }
      }
    )
  } catch (err) {
    throw httpError((err as Error).message.replace(/^Step 1 \(integrity_fix\): /, ''), 400)
  }
}
