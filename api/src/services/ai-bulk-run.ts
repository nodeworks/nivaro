import { db } from '../db/index.js'
import type { User } from '../types.js'
import { latestRevisionIds, readRaw } from './ai-plan-made.js'
import type { PlanMadeRecord, PlanStepMade, StepOutcome } from './ai-plan-runner.js'
import type { PlanStepContext } from './ai-plan-steps.js'
import {
  INLINE_UNDO_CAP,
  type UndoOp,
  type UndoWrite,
  undoStoreReady,
  writeUndoRecords
} from './ai-undo-store.js'
import { selectInChunks } from './db-batch.js'

/**
 * The WRITE half of an Ask AI plan step that changes records — update, create or
 * delete — however many there are (an administrator may change 62,000 units in one
 * step; everyone else is capped at 200 when the step is proposed).
 *
 * Every record goes through the items service AS THE PERSON (services/items.ts:
 * hooks, validation, permissions, row security, rollups, realtime, activity,
 * revisions), one at a time, in chunks: before each chunk the values it will replace
 * are read raw, after it the records' newest revision ids, and both are kept so the
 * write can be undone (services/ai-undo-store.ts). Between chunks the step reports
 * progress (saved + pushed to the person's socket) and stops if they pressed Stop —
 * what ran stays, and stays undoable.
 *
 * Every activity row the step writes shares one burst key (`ai-plan:<plan>`, so the
 * Activity page folds them into one line) and names Ask AI as the actor for the
 * person ("Ask AI for Rob Lee").
 *
 * Why not one set-based UPDATE for big runs: it would skip the hooks, rollups,
 * realtime events and per-record history that make an AI change look like any other
 * change. Sequential writes keep that, on the background pool, at the cost of time
 * (tens of minutes for tens of thousands of records) — the plan card shows how far.
 */

export const BULK_CHUNK = 50
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface BulkSpec {
  op: UndoOp
  collection: string
  /** update / delete: the records (resolved as the person when proposed). */
  ids?: string[]
  /** update: the values every record gets. */
  changes?: Record<string, unknown>
  /** create: one data object per new record. */
  records?: Array<Record<string, unknown>>
}

/** The actor stamped on the activity rows an Ask AI plan writes. */
export function askAiActor(userId: string) {
  return { kind: 'mcp' as const, id: 'ask-ai', name: 'Ask AI', on_behalf_of: userId }
}

/** Whole rows, raw (a delete keeps everything it removes). */
async function readWholeRows(
  collection: string,
  ids: string[]
): Promise<Map<string, Record<string, unknown>>> {
  if (!IDENT.test(collection) || ids.length === 0) return new Map()
  const rows = await selectInChunks(
    ids,
    1000,
    (chunk) =>
      db(collection).whereIn('id', chunk).select('*') as Promise<Array<Record<string, unknown>>>
  )
  return new Map(rows.map((r) => [String(r.id), r]))
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err ?? 'failed')).slice(0, 160)
}

export async function runBulkWrite(
  user: User,
  spec: BulkSpec,
  ctx: PlanStepContext
): Promise<StepOutcome> {
  const collection = spec.collection
  if (!IDENT.test(collection)) throw new Error('Invalid collection')
  const ids = (spec.ids ?? []).map(String)
  const records = spec.records ?? []
  const total = spec.op === 'create' ? records.length : ids.length
  const changes = spec.changes ?? {}
  const fields = Object.keys(changes)

  const table = await undoStoreReady()
  if (!table && total > INLINE_UNDO_CAP) {
    return {
      ok: false,
      result: { not_run: total },
      records_changed: 0,
      error: `Nothing was changed: this database can keep undo data for at most ${INLINE_UNDO_CAP} records until migration 537 runs, and this step writes ${total.toLocaleString('en-US')}.`
    }
  }

  const { aiWriter } = await import('./ai-actions.js')
  const { createOne, deleteOne, updateOne } = await import('./items.js')
  const { activityGroupKey, withActivityScope } = await import('./activity-scope.js')
  const writer = await aiWriter(user)
  const scope = {
    group_key: activityGroupKey('ai-plan', ctx.planId),
    actor: askAiActor(String(user.id))
  }

  let done = 0
  let okCount = 0
  let stopped = false
  const errors: string[] = []
  const failedIds: string[] = []
  const createdIds: string[] = []
  const inline: PlanMadeRecord[] = []
  const ranAt = new Date().toISOString()

  for (let start = 0; start < total; start += BULK_CHUNK) {
    if (ctx.shouldStop?.()) {
      stopped = true
      break
    }
    const end = Math.min(total, start + BULK_CHUNK)
    const chunkIds = spec.op === 'create' ? [] : ids.slice(start, end)
    const before =
      spec.op === 'update'
        ? await readRaw(collection, chunkIds, fields)
        : spec.op === 'delete'
          ? await readWholeRows(collection, chunkIds)
          : new Map<string, Record<string, unknown>>()
    const wrote: Array<{
      id: string
      before: Record<string, unknown> | null
      after: Record<string, unknown> | null
    }> = []
    await withActivityScope(scope, async () => {
      for (let i = start; i < end; i++) {
        if (spec.op === 'create') {
          const data = records[i] ?? {}
          try {
            const created = (await createOne(writer, collection, { ...data })) as Record<
              string,
              unknown
            > | null
            const id = created?.id != null ? String(created.id) : null
            if (id) {
              createdIds.push(id)
              wrote.push({ id, before: null, after: data })
            }
            okCount++
          } catch (err) {
            failedIds.push(`#${i + 1}`)
            if (errors.length < 10) errors.push(`record ${i + 1}: ${errText(err)}`)
          }
          continue
        }
        const id = ids[i]
        try {
          if (spec.op === 'update') {
            await updateOne(writer, collection, id, { ...changes })
            const row = before.get(id) ?? {}
            wrote.push({
              id,
              before: Object.fromEntries(fields.map((f) => [f, row[f] ?? null])),
              after: changes
            })
          } else {
            const row = before.get(id) ?? null
            await deleteOne(writer, collection, id)
            wrote.push({ id, before: row ?? { id }, after: null })
          }
          okCount++
        } catch (err) {
          failedIds.push(id)
          if (errors.length < 10) errors.push(`${id}: ${errText(err)}`)
        }
      }
    })
    done = end
    // The witness for "nothing touched it since" (a deleted record has none).
    const revs =
      spec.op === 'delete' || wrote.length === 0
        ? new Map<string, number>()
        : await latestRevisionIds(
            collection,
            wrote.map((w) => w.id)
          )
    const rows: UndoWrite[] = wrote.map((w) => ({
      collection,
      item: w.id,
      op: spec.op,
      before: w.before,
      after: w.after,
      rev: revs.get(w.id) ?? null
    }))
    if (table) {
      await writeUndoRecords(ctx.planId, ctx.stepId, rows)
    } else {
      for (const r of rows)
        inline.push({
          id: r.item,
          before: r.before ?? {},
          after: r.after ?? {},
          rev: r.rev,
          ...(r.op === 'create' ? { created: true } : {}),
          ...(r.op === 'delete' ? { deleted: true } : {})
        })
    }
    await ctx.progress?.(done, total)
  }

  const made: PlanStepMade | null =
    okCount === 0
      ? null
      : table
        ? { collection, records: [], store: 'table', count: okCount, ran_at: ranAt }
        : { collection, records: inline, ran_at: ranAt }
  const failed = failedIds.length
  const verb = spec.op === 'update' ? 'updated' : spec.op === 'create' ? 'created' : 'deleted'
  const result: Record<string, unknown> = {
    [verb]: okCount,
    failed,
    errors,
    failed_ids: failedIds,
    total,
    ...(spec.op === 'create' ? { ids: createdIds.slice(0, 50), id: createdIds[0] ?? null } : {}),
    ...(stopped ? { stopped: true, not_run: total - done } : {})
  }
  if (stopped) {
    return {
      ok: false,
      stopped: true,
      result,
      records_changed: okCount,
      error: `Stopped after ${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} records — what ran can be undone from the plan's history`,
      made
    }
  }
  return {
    ok: failed === 0,
    result,
    records_changed: okCount,
    error: failed
      ? `${failed} of ${total} record(s) refused: ${errors.slice(0, 3).join('; ')}`
      : undefined,
    made
  }
}
