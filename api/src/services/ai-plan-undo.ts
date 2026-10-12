import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { latestRevisionIds, readRaw } from './ai-plan-made.js'
import type { PlanMadeRecord } from './ai-plan-runner.js'
import { getPlanStepKind, labelsFor, sameValue, stillVisibleIds } from './ai-plan-steps.js'
import { httpError, isAdmin, loadPlan } from './ai-plans.js'
import { deleteOne, updateOne } from './items.js'

/**
 * UNDO a plan's writes (#1954), administrators only. Only what a step
 * captured as it ran (doc.made) can be reverted, and only per record when
 * nothing has touched the record since: its newest revision is still the
 * one the plan's write left (no later edit, by anyone — the record's
 * revision history is the witness), and every field still holds the value
 * the plan wrote. Anything else is refused and named. Reverts go through
 * the items service as the administrator, so they are revisioned and
 * audited like a hand edit. Messages, chat posts, flows and tasks cannot be
 * unsent — those steps say so.
 */

export type UndoRecordStatus = 'revertible' | 'changed' | 'gone' | 'undone'

export interface UndoRecordCheck {
  id: string
  collection: string
  label: string
  status: UndoRecordStatus
  reason?: string
}

export interface UndoStepCheck {
  step_id: string
  n: number
  title: string
  kind_label: string
  /** Why the whole step cannot be undone (nothing captured, a message…). */
  not_revertible?: string
  revertible: number
  blocked: number
  undone_at: string | null
  records: UndoRecordCheck[]
}

const SHOWN = 50

async function checkRecords(
  collection: string,
  records: PlanMadeRecord[]
): Promise<Map<PlanMadeRecord, { status: UndoRecordStatus; reason?: string }>> {
  const out = new Map<PlanMadeRecord, { status: UndoRecordStatus; reason?: string }>()
  const ids = records.map((r) => r.id)
  const fields = [...new Set(records.flatMap((r) => Object.keys(r.after)))]
  const [current, revs] = await Promise.all([
    readRaw(collection, ids, fields),
    latestRevisionIds(collection, ids)
  ])
  for (const r of records) {
    const row = current.get(r.id)
    if (!row) {
      out.set(r, { status: 'gone', reason: 'the record no longer exists' })
      continue
    }
    if (r.undone) {
      out.set(r, { status: 'undone' })
      continue
    }
    const rev = revs.get(r.id) ?? null
    if (rev !== (r.rev ?? null)) {
      out.set(r, { status: 'changed', reason: 'edited since the plan ran' })
      continue
    }
    const moved = Object.keys(r.after).find((f) => f in row && !sameValue(row[f], r.after[f]))
    if (moved) {
      out.set(r, { status: 'changed', reason: `${moved} changed since the plan ran` })
      continue
    }
    out.set(r, { status: 'revertible' })
  }
  return out
}

export async function undoCheck(
  admin: User,
  id: string
): Promise<{ plan_id: string; steps: UndoStepCheck[] }> {
  if (!(await isAdmin(admin))) throw httpError('Only administrators can undo a plan', 403)
  const { row, doc } = await loadPlan(id)
  const steps: UndoStepCheck[] = []
  for (const step of [...doc.steps].sort((a, b) => a.n - b.n)) {
    const state = doc.state.find((x) => x.id === step.id)
    const made = doc.made?.[step.id]
    const base = {
      step_id: step.id,
      n: step.n,
      title: step.title,
      kind_label: getPlanStepKind(step.kind)?.label ?? step.kind,
      revertible: 0,
      blocked: 0,
      undone_at: made?.undone_at ?? null,
      records: [] as UndoRecordCheck[]
    }
    if (!made) {
      if (state?.status === 'done') {
        steps.push({
          ...base,
          not_revertible:
            step.kind === 'bulk_update' || step.kind === 'create_record'
              ? 'Nothing was captured for this step'
              : 'This kind of step cannot be undone'
        })
      }
      continue
    }
    const byCollection = new Map<string, PlanMadeRecord[]>()
    for (const r of made.records) {
      const c = r.collection ?? made.collection
      byCollection.set(c, [...(byCollection.get(c) ?? []), r])
    }
    for (const [c, records] of byCollection) {
      const checked = await checkRecords(c, records)
      const visible = new Set(
        await stillVisibleIds(
          admin,
          c,
          records.map((r) => r.id)
        )
      )
      const labels = await labelsFor(c, [...visible])
      for (const r of records) {
        const v = checked.get(r) ?? { status: 'gone' as UndoRecordStatus }
        if (v.status === 'revertible') base.revertible++
        else if (v.status !== 'undone') base.blocked++
        if (base.records.length < SHOWN) {
          base.records.push({
            id: r.id,
            collection: c,
            label: visible.has(r.id) ? (labels[r.id] ?? `#${r.id}`) : `#${r.id}`,
            status: v.status,
            ...(v.reason ? { reason: v.reason } : {})
          })
        }
      }
    }
    steps.push(base)
  }
  return { plan_id: String(row.id), steps }
}

export interface UndoResult {
  undone: number
  skipped: number
  failed: number
  errors: string[]
}

/** Revert every revertible record of one step (or of every step, newest first). */
export async function undoPlan(
  admin: User,
  id: string,
  stepId?: string | null
): Promise<UndoResult> {
  if (!(await isAdmin(admin))) throw httpError('Only administrators can undo a plan', 403)
  const { row, doc } = await loadPlan(id)
  const status = String(row.status)
  if (status === 'running' || status === 'scheduled') {
    throw httpError(`A ${status} plan cannot be undone — stop it first`, 409)
  }
  const steps = [...doc.steps]
    .sort((a, b) => b.n - a.n)
    .filter(
      (s) => (stepId ? s.id === stepId : true) && doc.made?.[s.id] && !doc.made[s.id].undone_at
    )
  if (steps.length === 0) throw httpError('Nothing left to undo on this plan', 409)
  const result: UndoResult = { undone: 0, skipped: 0, failed: 0, errors: [] }
  for (const step of steps) {
    const made = doc.made![step.id]
    const byCollection = new Map<string, PlanMadeRecord[]>()
    for (const r of made.records) {
      const c = r.collection ?? made.collection
      byCollection.set(c, [...(byCollection.get(c) ?? []), r])
    }
    for (const [c, records] of byCollection) {
      const checked = await checkRecords(c, records)
      for (const r of records) {
        if (checked.get(r)?.status !== 'revertible') {
          result.skipped++
          continue
        }
        try {
          if (r.created) await deleteOne(admin, c, r.id)
          else await updateOne(admin, c, r.id, { ...r.before })
          r.undone = true
          result.undone++
        } catch (err) {
          result.failed++
          if (result.errors.length < 10)
            result.errors.push(
              `${c} #${r.id}: ${(err as Error)?.message?.slice(0, 160) ?? 'failed'}`
            )
        }
      }
    }
    made.undone_at = new Date().toISOString()
    made.undone_by = String(admin.id)
  }
  await db('nivaro_ai_proposals')
    .where({ id })
    .update({ payload: JSON.stringify(doc) })
  await logActivity({
    action: 'ai-plan-undo',
    user: admin.id,
    comment: `plan ${id}: undid ${result.undone} record(s)${stepId ? ` of step ${steps[0]?.n}` : ''}, ${result.skipped} changed since, ${result.failed} failed`
  })
  return result
}
