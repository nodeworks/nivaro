import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { isAiAdminUnbounded } from './ai-admin-mode.js'
import { latestRevisionIds, readRaw } from './ai-plan-made.js'
import { madeHasRecords, type PlanMadeRecord, type PlanStepMade } from './ai-plan-runner.js'
import { getPlanStepKind, labelsFor, sameValue, stillVisibleIds } from './ai-plan-steps.js'
import {
  emitPlan,
  httpError,
  isAdmin,
  loadPlan,
  type PlanUndoRun,
  planLink,
  planView,
  type StoredPlanDoc,
  sameId
} from './ai-plans.js'
import {
  countUndoRecords,
  markUndoRows,
  readUndoRecords,
  reopenUndoRows,
  type StoredUndoRecord,
  UNDO_RETENTION_DAYS,
  undoExpiresAt,
  undoStoreReady
} from './ai-undo-store.js'
import { getApp } from './io-holder.js'

/**
 * UNDO a plan's writes (#1954; Rob 2026-11-18 "make it reversible what they delete /
 * change / create"), administrators only (and the owner of a task-do plan for 7 days).
 *
 * Only what a step captured as it ran can be reverted — in the plan's JSON (older plans,
 * a database behind migration 537) or in nivaro_ai_undo_records (services/ai-undo-store.ts):
 *   update  → the fields go back to the values they had before the plan
 *   create  → the record the plan created is deleted
 *   delete  → the record the plan deleted is restored with its id (from the trash, or from
 *             the whole row the step kept when the trash no longer holds it)
 *
 * A record is REVERTIBLE when nothing has touched it since: its newest revision is still
 * the one the plan's write left (the record's revision history is the witness) and every
 * field still holds what the plan wrote. Anything else is a CONFLICT and named; the
 * administrator chooses to skip conflicts (default) or overwrite them — a record that was
 * deleted since, or whose id is taken again, is never touched.
 *
 * Reverts go through the items service as the administrator (permissions, hooks,
 * revisions, activity — one burst `ai-plan-undo:<plan>` on the Activity page). A large
 * undo (over SYNC_MAX records) runs in the background with progress on the plan
 * (`undo_run`, pushed as `ai:plan`), and the administrator is told when it ends.
 * Messages, chat posts, flows and tasks cannot be unsent — those steps say so.
 */

export type UndoRecordStatus = 'revertible' | 'changed' | 'gone' | 'undone'

export interface UndoRecordCheck {
  id: string
  collection: string
  label: string
  status: UndoRecordStatus
  /** What undo does to this record. */
  op?: 'update' | 'create' | 'delete'
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
  /** changed + gone — kept for older clients. */
  blocked: number
  /** Changed since the plan ran — reverted only when the administrator chooses overwrite. */
  changed: number
  /** Deleted since (or its id taken again) — never touched. */
  gone: number
  undone: number
  total: number
  undone_at: string | null
  /** When this step's undo data is pruned (table store). */
  expires_at?: string | null
  records: UndoRecordCheck[]
}

export interface UndoCheckResult {
  plan_id: string
  steps: UndoStepCheck[]
  run: PlanUndoRun | null
  retention_days: number
}

const SHOWN = 50
/** At most this many records are undone inside the request; more run in the background. */
export const SYNC_MAX = 200
const PAGE = 500
const PROGRESS_SAVE_MS = 5000
/** An undo with no sign of life for this long lost its process. */
const STALE_UNDO_MS = 10 * 60 * 1000
/** The owner of a task-do plan (#2865) may undo it this long after it ran. */
export const OWNER_UNDO_DAYS = 7

/** An administrator always (on their own session for an unbounded plan); the owner of a
 *  plan drafted for a task or ticket while the undo window is open. Anyone else: 403. */
export async function assertCanUndo(user: User, row: Record<string, unknown>, doc: StoredPlanDoc) {
  if (await isAdmin(user)) {
    if (doc.admin_unbounded && !isAiAdminUnbounded(user)) {
      throw httpError(
        'This plan has no record limit, so only an administrator signed in as themselves can undo it',
        403
      )
    }
    return
  }
  if (doc.source?.kind === 'task-do' && sameId(row.user, user.id)) {
    const ran = row.executed_at ? new Date(String(row.executed_at)).getTime() : 0
    if (ran && Date.now() - ran <= OWNER_UNDO_DAYS * 86_400_000) return
    throw httpError(
      `You can undo your own plan for ${OWNER_UNDO_DAYS} days after it ran — ask an administrator`,
      403
    )
  }
  throw httpError('Only administrators can undo a plan', 403)
}

type Verdict = { status: UndoRecordStatus; reason?: string }

function opOf(r: PlanMadeRecord): 'update' | 'create' | 'delete' {
  return r.deleted ? 'delete' : r.created ? 'create' : 'update'
}

/** Judge each record against the database now (see the module comment). */
export async function checkRecords(
  collection: string,
  records: PlanMadeRecord[]
): Promise<Map<PlanMadeRecord, Verdict>> {
  const out = new Map<PlanMadeRecord, Verdict>()
  const ids = records.map((r) => r.id)
  const fields = [
    ...new Set(records.filter((r) => !r.deleted).flatMap((r) => Object.keys(r.after)))
  ]
  const [current, revs] = await Promise.all([
    readRaw(collection, ids, fields),
    latestRevisionIds(collection, ids)
  ])
  for (const r of records) {
    if (r.undone) {
      out.set(r, { status: 'undone' })
      continue
    }
    const row = current.get(r.id)
    if (r.deleted) {
      out.set(
        r,
        row
          ? { status: 'gone', reason: 'a record with this id exists again' }
          : { status: 'revertible' }
      )
      continue
    }
    if (!row) {
      out.set(r, { status: 'gone', reason: 'the record no longer exists' })
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

function groupByCollection<T extends PlanMadeRecord>(
  made: PlanStepMade,
  records: T[]
): Map<string, T[]> {
  const by = new Map<string, T[]>()
  for (const r of records) {
    const c = r.collection ?? made.collection
    const list = by.get(c)
    if (list) list.push(r)
    else by.set(c, [r])
  }
  return by
}

async function labelChecks(viewer: User, checks: UndoRecordCheck[]): Promise<UndoRecordCheck[]> {
  const by = new Map<string, UndoRecordCheck[]>()
  for (const c of checks) by.set(c.collection, [...(by.get(c.collection) ?? []), c])
  for (const [c, list] of by) {
    // A deleted record has no row to judge — it is named by id only.
    const visible = new Set(
      await stillVisibleIds(
        viewer,
        c,
        list.filter((x) => x.op !== 'delete').map((x) => x.id)
      )
    )
    const labels = await labelsFor(c, [...visible], viewer)
    for (const x of list) x.label = visible.has(x.id) ? (labels[x.id] ?? `#${x.id}`) : `#${x.id}`
  }
  return checks
}

/** Undo data this step keeps in the table — read a page at a time. */
async function* tablePages(
  planId: string,
  stepId: string,
  opts: { notUndone?: boolean } = {}
): AsyncGenerator<StoredUndoRecord[]> {
  let after = 0
  for (;;) {
    const page = await readUndoRecords(planId, stepId, {
      afterRowId: after,
      limit: PAGE,
      notUndone: opts.notUndone
    })
    if (page.length === 0) return
    after = page[page.length - 1].row_id
    yield page
    if (page.length < PAGE) return
  }
}

function tally(base: UndoStepCheck, v: Verdict): void {
  if (v.status === 'revertible') base.revertible++
  else if (v.status === 'changed') base.changed++
  else if (v.status === 'gone') base.gone++
  else base.undone++
  base.blocked = base.changed + base.gone
}

export async function undoCheck(admin: User, id: string): Promise<UndoCheckResult> {
  const { row, doc } = await loadPlan(id)
  await assertCanUndo(admin, row, doc)
  const steps: UndoStepCheck[] = []
  const { withReadGate } = await import('./read-gate.js')
  for (const step of [...doc.steps].sort((a, b) => a.n - b.n)) {
    const state = doc.state.find((x) => x.id === step.id)
    const made = doc.made?.[step.id]
    const base: UndoStepCheck = {
      step_id: step.id,
      n: step.n,
      title: step.title,
      kind_label: getPlanStepKind(step.kind)?.label ?? step.kind,
      revertible: 0,
      blocked: 0,
      changed: 0,
      gone: 0,
      undone: 0,
      total: 0,
      undone_at: made?.undone_at ?? null,
      records: []
    }
    if (!made || !madeHasRecords(made)) {
      if (state?.status === 'done' || state?.status === 'cancelled') {
        steps.push({
          ...base,
          not_revertible: RECORD_KINDS.has(step.kind)
            ? 'Nothing was captured for this step'
            : 'This kind of step cannot be undone'
        })
      }
      continue
    }
    const shown: UndoRecordCheck[] = []
    const note = (c: string, r: PlanMadeRecord, v: Verdict) => {
      tally(base, v)
      base.total++
      // Conflicts first: they are what the administrator decides on.
      if (shown.length < SHOWN || (v.status !== 'revertible' && v.status !== 'undone')) {
        const entry: UndoRecordCheck = {
          id: r.id,
          collection: c,
          label: `#${r.id}`,
          status: v.status,
          op: opOf(r),
          ...(v.reason ? { reason: v.reason } : {})
        }
        if (shown.length < SHOWN) shown.push(entry)
        else {
          const swap = shown.findIndex((x) => x.status === 'revertible' || x.status === 'undone')
          if (swap >= 0) shown[swap] = entry
        }
      }
    }
    if (made.store === 'table') {
      base.expires_at = undoExpiresAt(made.ran_at ?? null)
      const counts = (await undoStoreReady())
        ? await countUndoRecords(id, step.id)
        : { total: 0, undone: 0, pending: 0 }
      if (counts.total === 0) {
        steps.push({
          ...base,
          not_revertible: `Undo data is kept ${UNDO_RETENTION_DAYS} days after a plan runs — it has expired for this step`
        })
        continue
      }
      await withReadGate(
        String(admin.id),
        async () => {
          for await (const page of tablePages(id, step.id)) {
            for (const [c, records] of groupByCollection(made, page)) {
              const checked = await checkRecords(c, records)
              for (const r of records) note(c, r, checked.get(r) ?? { status: 'gone' })
            }
          }
        },
        { label: 'ai-plan-undo-check' }
      )
    } else {
      for (const [c, records] of groupByCollection(made, made.records)) {
        const checked = await checkRecords(c, records)
        for (const r of records) note(c, r, checked.get(r) ?? { status: 'gone' })
      }
    }
    base.records = await labelChecks(admin, shown)
    steps.push(base)
  }
  return {
    plan_id: String(row.id),
    steps,
    run: liveRun(doc),
    retention_days: UNDO_RETENTION_DAYS
  }
}

const RECORD_KINDS = new Set(['bulk_update', 'bulk_delete', 'create_record', 'create_records'])

function liveRun(doc: StoredPlanDoc): PlanUndoRun | null {
  const run = doc.undo_run ?? null
  if (!run) return null
  if (run.status === 'running' && isStaleUndo(run)) return { ...run, status: 'failed' }
  return run
}

function isStaleUndo(run: PlanUndoRun, now = Date.now()): boolean {
  const last = new Date(run.heartbeat_at ?? run.started_at).getTime()
  return Number.isFinite(last) && now - last > STALE_UNDO_MS
}

export interface UndoResult {
  undone: number
  skipped: number
  failed: number
  errors: string[]
  /** Overwrote records that had changed since (the administrator chose to). */
  overwritten?: number
  /** Too big to wait for: it runs in the background (progress on the plan's undo_run). */
  running?: boolean
  total?: number
}

export interface UndoOptions {
  /** Revert records changed since the plan ran too (never deleted / re-used ones). */
  overwrite?: boolean
}

/** Put one record back. Throws when the items service refuses. */
async function revertOne(
  admin: User,
  collection: string,
  r: PlanMadeRecord,
  capturedAt: string | null
): Promise<void> {
  const { deleteOne, updateOne } = await import('./items.js')
  if (r.created) {
    await deleteOne(admin, collection, r.id)
    return
  }
  if (r.deleted) {
    await restoreDeleted(admin, collection, r, capturedAt)
    return
  }
  await updateOne(admin, collection, r.id, { ...r.before })
}

/**
 * Bring back a record the plan deleted: from the trash row the delete wrote (newest for
 * the id since the plan ran), else from the whole row the step kept — put into the trash
 * first so the one restore path (ids kept, IDENTITY_INSERT, rollups, tasks, history) runs.
 */
async function restoreDeleted(
  admin: User,
  collection: string,
  r: PlanMadeRecord,
  capturedAt: string | null
): Promise<void> {
  const { restoreTrashRow } = await import('./trash.js')
  const since = capturedAt ? new Date(new Date(capturedAt).getTime() - 5 * 60_000) : null
  const hit = (await db('nivaro_trash')
    .where({ collection, item_id: r.id })
    .modify((q) => {
      if (since) q.where('deleted_at', '>=', since)
    })
    .orderBy('id', 'desc')
    .first('id')) as { id: number } | undefined
  let trashId = hit?.id != null ? Number(hit.id) : null
  if (trashId == null) {
    if (!r.before || Object.keys(r.before).length <= 1) {
      throw new Error('the deleted record was not kept — it cannot be restored')
    }
    await db('nivaro_trash').insert({
      collection,
      item_id: r.id,
      data: JSON.stringify(r.before),
      deleted_by: admin.id,
      deleted_at: new Date()
    })
    const back = (await db('nivaro_trash')
      .where({ collection, item_id: r.id })
      .orderBy('id', 'desc')
      .first('id')) as { id: number } | undefined
    trashId = back?.id != null ? Number(back.id) : null
    if (trashId == null) throw new Error('could not stage the record for restore')
  }
  await restoreTrashRow(admin, trashId)
}

interface StepWork {
  stepId: string
  n: number
  made: PlanStepMade
  pending: number
}

/** Steps with something left to undo, newest first. */
async function stepsToUndo(
  id: string,
  doc: StoredPlanDoc,
  stepId: string | null | undefined,
  overwrite: boolean
): Promise<StepWork[]> {
  const out: StepWork[] = []
  const table = await undoStoreReady()
  for (const s of [...doc.steps].sort((a, b) => b.n - a.n)) {
    if (stepId && s.id !== stepId) continue
    const made = doc.made?.[s.id]
    if (!made || !madeHasRecords(made)) continue
    if (made.store === 'table') {
      if (!table) continue
      // Skipped / failed rows are tried again; with overwrite, conflicts too.
      const counts = await countUndoRecords(id, s.id)
      const pending = counts.total - counts.undone
      if (pending > 0) out.push({ stepId: s.id, n: s.n, made, pending })
      continue
    }
    if (made.undone_at && !overwrite) continue
    const pending = made.records.filter((r) => !r.undone).length
    if (pending > 0) out.push({ stepId: s.id, n: s.n, made, pending })
  }
  return out
}

/**
 * Revert every revertible record of one step (or of every step, newest first). Up to
 * SYNC_MAX records answer when done; more answer at once with `running: true` and go on
 * in the background (progress on GET …/undo and the plan's socket event).
 */
export async function undoPlan(
  admin: User,
  id: string,
  stepId?: string | null,
  opts: UndoOptions = {}
): Promise<UndoResult> {
  const { row, doc } = await loadPlan(id)
  await assertCanUndo(admin, row, doc)
  const status = String(row.status)
  if (status === 'running' || status === 'scheduled') {
    throw httpError(`A ${status} plan cannot be undone — stop it first`, 409)
  }
  if (doc.undo_run?.status === 'running' && !isStaleUndo(doc.undo_run)) {
    throw httpError('An undo of this plan is already running', 409)
  }
  const overwrite = opts.overwrite === true
  const work = await stepsToUndo(id, doc, stepId, overwrite)
  if (work.length === 0) throw httpError('Nothing left to undo on this plan', 409)
  const total = work.reduce((n, w) => n + w.pending, 0)

  const run: PlanUndoRun = {
    status: 'running',
    by: String(admin.id),
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    step_id: stepId ?? null,
    overwrite,
    total,
    done: 0,
    undone: 0,
    skipped: 0,
    failed: 0,
    errors: []
  }
  if (total <= SYNC_MAX) {
    const result = await executeUndo(admin, id, row, doc, work, run)
    return result
  }
  // Claim it: only one undo of a plan at a time (another tab, another replica).
  doc.undo_run = run
  const claimed = await db('nivaro_ai_proposals')
    .where({ id, status })
    .update({ payload: JSON.stringify(doc) })
  if (Number(claimed) !== 1) throw httpError('The plan changed — reload it', 409)
  await logActivity({
    action: 'ai-plan-undo',
    user: admin.id,
    comment: `plan ${id}: undo started for ${total} record(s)${overwrite ? ', overwriting changes made since' : ''}`
  })
  const { runInBackgroundPool } = await import('../db/pool-context.js')
  void runInBackgroundPool(() => executeUndo(admin, id, row, doc, work, run))
    .then((r) => notifyUndoFinished(id, doc, r, admin))
    .catch((err) => {
      getApp()?.log?.error({ err, plan: id }, 'AI plan undo failed')
    })
  return { undone: 0, skipped: 0, failed: 0, errors: [], running: true, total }
}

/** The undo itself (inline for small ones, the background body for big ones). */
async function executeUndo(
  admin: User,
  id: string,
  row: Record<string, unknown>,
  doc: StoredPlanDoc,
  work: StepWork[],
  run: PlanUndoRun
): Promise<UndoResult> {
  const result: UndoResult = { undone: 0, skipped: 0, failed: 0, errors: [] }
  let overwritten = 0
  let savedAt = Date.now()
  const background = doc.undo_run === run
  const save = async (force = false) => {
    if (!background) return
    run.heartbeat_at = new Date().toISOString()
    if (!force && Date.now() - savedAt < PROGRESS_SAVE_MS) return
    savedAt = Date.now()
    await db('nivaro_ai_proposals')
      .where({ id })
      .update({ payload: JSON.stringify(doc) })
    emitPlan(run.by, planView(row, doc))
  }
  const { activityGroupKey, withActivityScope } = await import('./activity-scope.js')
  const scope = { group_key: activityGroupKey('ai-plan-undo', id) }
  const fail = (c: string, r: PlanMadeRecord, err: unknown) => {
    result.failed++
    run.failed++
    const text = `${c} #${r.id}: ${(err as Error)?.message?.slice(0, 160) ?? 'failed'}`
    if (result.errors.length < 10) result.errors.push(text)
    if (run.errors.length < 10) run.errors.push(text)
    return text
  }

  try {
    for (const w of work) {
      const made = w.made
      const capturedAt = made.ran_at ?? (row.executed_at ? String(row.executed_at) : null)
      if (made.store === 'table') {
        await reopenUndoRows(id, w.stepId)
        for await (const page of tablePages(id, w.stepId, { notUndone: true })) {
          const undone: number[] = []
          const skipped: Array<{ row: number; note: string }> = []
          const failed: Array<{ row: number; note: string }> = []
          for (const [c, records] of groupByCollection(made, page)) {
            const checked = await checkRecords(c, records)
            await withActivityScope(scope, async () => {
              for (const r of records) {
                const v = checked.get(r) ?? { status: 'gone' as const }
                const go = v.status === 'revertible' || (v.status === 'changed' && run.overwrite)
                if (!go) {
                  result.skipped++
                  run.skipped++
                  skipped.push({ row: r.row_id, note: v.reason ?? v.status })
                  continue
                }
                try {
                  await revertOne(admin, c, r, capturedAt)
                  if (v.status === 'changed') overwritten++
                  result.undone++
                  run.undone++
                  undone.push(r.row_id)
                } catch (err) {
                  failed.push({ row: r.row_id, note: fail(c, r, err) })
                }
              }
            })
          }
          await markUndoRows(undone, 'undone')
          for (const s of skipped) await markUndoRows([s.row], 'skipped', s.note)
          for (const f of failed) await markUndoRows([f.row], 'failed', f.note)
          run.done += page.length
          await save()
        }
        const left = await countUndoRecords(id, w.stepId)
        if (left.undone === left.total) {
          made.undone_at = new Date().toISOString()
          made.undone_by = String(admin.id)
        }
        continue
      }
      // Inline (older plans / a database behind 537).
      for (const [c, records] of groupByCollection(made, made.records)) {
        const checked = await checkRecords(c, records)
        await withActivityScope(scope, async () => {
          for (const r of records) {
            if (r.undone) continue
            const v = checked.get(r)
            const go =
              v?.status === 'revertible' || (v?.status === 'changed' && run.overwrite === true)
            run.done++
            if (!go) {
              result.skipped++
              run.skipped++
              continue
            }
            try {
              await revertOne(admin, c, r, capturedAt)
              if (v?.status === 'changed') overwritten++
              r.undone = true
              result.undone++
              run.undone++
            } catch (err) {
              fail(c, r, err)
            }
          }
        })
        await save()
      }
      made.undone_at = new Date().toISOString()
      made.undone_by = String(admin.id)
    }
    run.status = 'done'
  } catch (err) {
    run.status = 'failed'
    if (run.errors.length < 10) run.errors.push((err as Error)?.message?.slice(0, 200) ?? 'failed')
    throw err
  } finally {
    run.finished_at = new Date().toISOString()
    // A small undo leaves no run behind; a background one stays readable as finished.
    if (background) doc.undo_run = run
    await db('nivaro_ai_proposals')
      .where({ id })
      .update({ payload: JSON.stringify(doc) })
      .catch(() => undefined)
    emitPlan(run.by, planView(row, doc))
    const stepNote =
      run.step_id != null ? ` of step ${doc.steps.find((s) => s.id === run.step_id)?.n ?? '?'}` : ''
    await logActivity({
      action: 'ai-plan-undo',
      user: admin.id,
      comment: `plan ${id}: undid ${result.undone} record(s)${stepNote}, ${result.skipped} changed since${overwritten ? `, ${overwritten} overwritten` : ''}, ${result.failed} failed`
    })
  }
  if (overwritten) result.overwritten = overwritten
  return result
}

/** Tell the administrator a background undo ended (their own channels apply). */
async function notifyUndoFinished(
  id: string,
  doc: StoredPlanDoc,
  r: UndoResult,
  admin: User
): Promise<void> {
  const app = getApp()
  if (!app) return
  try {
    const { notifyUser } = await import('./notification-channels.js')
    const url = planLink(id)
    await notifyUser(app, String(admin.id), {
      subject: `Undo finished: ${doc.title}`.slice(0, 200),
      message:
        `${r.undone} record(s) put back${r.skipped ? `, ${r.skipped} left alone (changed or deleted since)` : ''}${r.failed ? `, ${r.failed} failed: ${r.errors[0] ?? ''}` : ''}.`.slice(
          0,
          2000
        ),
      category: 'system',
      ...(url ? { target: { kind: 'external', url } } : {}),
      source: { kind: 'ai-plan', label: 'Ask AI plan', id }
    })
  } catch (err) {
    app.log?.warn?.({ err, plan: id }, 'AI plan undo notification failed')
  }
}
