import { db } from '../db/index.js'
import type { User } from '../types.js'
import { selectInChunks } from './db-batch.js'
import type { ImportRunChange } from './import-run-report.js'

/**
 * Putting an import run back (migration 360).
 *
 * A run's items say what it did: the records it created and, for every record
 * it changed, each field's value before and after. Reverting reads that back:
 *
 *   created  → the record goes to the trash
 *   updated  → each field returns to the value it held before
 *
 * A revert never overwrites work done since the import:
 *   - a created record that anyone has touched since is left alone
 *   - a field whose value is no longer what the import wrote is left alone
 * Both are reported, per record.
 *
 * Every write goes through the items service as the person reverting, so it
 * is revisioned, attributed and subject to the same rules as any edit.
 * What a revert cannot reach: changes the run made outside the items service
 * (a set-based fill, the procedures at the end of a run), rows the run
 * removed, and items rebuilt from activity, which carry no earlier value.
 */

export type RevertVerdict =
  | 'remove'
  | 'restore'
  | 'partly'
  | 'changed-since'
  | 'gone'
  | 'nothing-recorded'
  | 'already-reverted'
  | 'not-applicable'

export interface RevertPlanItem {
  id: number
  kind: string
  collection: string | null
  item_id: string | null
  label: string | null
  verdict: RevertVerdict
  /** Fields that go back, with the value they return to. */
  restore: Record<string, unknown>
  /** Fields left alone because their value changed after the import. */
  left: string[]
  note: string
}

export interface RevertPlan {
  run: number
  total: number
  remove: number
  restore: number
  partly: number
  left_alone: number
  already_reverted: number
  not_applicable: number
  items: RevertPlanItem[]
}

interface ItemRow {
  id: number
  kind: string
  collection: string | null
  item_id: string | null
  label: string | null
  changes: string | null
  reverted_at: Date | string | null
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

const dayOf = (v: unknown): string | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10)
  const s = String(v)
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

/** Whether a stored value is the value the import wrote. Tolerant where the
 *  column type reshapes what comes back: bits, decimals, dates. */
export function sameStored(current: unknown, written: unknown): boolean {
  const a = current == null || current === '' ? null : current
  const b = written == null || written === '' ? null : written
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'
    return truthy(a) === truthy(b)
  }
  if (a instanceof Date || b instanceof Date || DAY.test(String(a)) || DAY.test(String(b))) {
    const da = dayOf(a)
    const dbb = dayOf(b)
    if (da && dbb) {
      // a day written into a datetime column compares by day; two full
      // timestamps compare to the second
      if (DAY.test(String(a)) || DAY.test(String(b))) return da === dbb
      return new Date(a as string).getTime() === new Date(b as string).getTime()
    }
  }
  const sa = String(a).trim()
  const sb = String(b).trim()
  const na = Number(sa)
  const nb = Number(sb)
  if (sa !== '' && sb !== '' && Number.isFinite(na) && Number.isFinite(nb)) {
    return Math.abs(na - nb) < 0.005
  }
  return sa === sb
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const HOUSEKEEPING = new Set(['changed', 'created', 'id', 'updated_at', 'date_updated'])

function parseChanges(raw: string | null): ImportRunChange[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as ImportRunChange[]) : []
  } catch {
    return []
  }
}

export async function planRevert(runId: number, itemIds?: number[]): Promise<RevertPlan> {
  const q = db('nivaro_import_run_items').where('run', runId)
  if (itemIds && itemIds.length > 0) q.whereIn('id', itemIds.slice(0, 2000))
  const rows = (await q
    .orderBy('id', 'asc')
    .select('id', 'kind', 'collection', 'item_id', 'label', 'changes', 'reverted_at')) as ItemRow[]

  const run = (await db('nivaro_import_queue')
    .where('id', runId)
    .select('started_at', 'created_at')
    .first()) as { started_at: Date | null; created_at: Date | null } | undefined
  const since = run?.started_at ?? run?.created_at ?? new Date(0)
  const stamp = `import:%:run-${runId}`

  const byCollection = new Map<string, ItemRow[]>()
  for (const r of rows) {
    if (!r.collection || !r.item_id || !IDENT.test(r.collection) || /^nivaro_/i.test(r.collection)) continue
    if (r.kind !== 'created' && r.kind !== 'updated') continue
    byCollection.set(r.collection, [...(byCollection.get(r.collection) ?? []), r])
  }

  // current values of every field the run changed, and who touched the
  // created records afterwards — one chunked read per collection
  const current = new Map<string, Record<string, unknown>>()
  const touchedSince = new Set<string>()
  for (const [collection, list] of byCollection) {
    const fields = new Set<string>()
    for (const r of list) {
      if (r.kind !== 'updated') continue
      for (const c of parseChanges(r.changes)) if (IDENT.test(c.field)) fields.add(c.field)
    }
    const physical = new Set(
      (
        (await db('information_schema.columns')
          .where('table_name', collection)
          .pluck('column_name')) as string[]
      ).map((c) => c.toLowerCase())
    )
    const select = ['id', ...[...fields].filter((f) => physical.has(f.toLowerCase()) && f !== 'id')]
    const ids = [...new Set(list.map((r) => String(r.item_id)))]
    const found = await selectInChunks(ids, 900, (chunk) =>
      db(collection).whereIn('id', chunk).select(select)
    )
    for (const f of found as Array<Record<string, unknown>>) {
      current.set(`${collection}:${String(f.id)}`, f)
    }
    const createdIds = [...new Set(list.filter((r) => r.kind === 'created').map((r) => String(r.item_id)))]
    const later = await selectInChunks(createdIds, 900, (chunk) =>
      db('nivaro_activity')
        .where('collection', collection)
        .whereIn('item', chunk)
        .where('timestamp', '>=', since)
        .where((b) => b.whereNull('comment').orWhere('comment', 'not like', stamp))
        .whereNotIn('action', ['read', 'login'])
        .distinct('item')
    )
    for (const l of later as Array<{ item: unknown }>) touchedSince.add(`${collection}:${String(l.item)}`)
  }

  const items: RevertPlanItem[] = rows.map((r) => {
    const base = {
      id: Number(r.id),
      kind: r.kind,
      collection: r.collection,
      item_id: r.item_id,
      label: r.label,
      restore: {} as Record<string, unknown>,
      left: [] as string[]
    }
    if (r.reverted_at) return { ...base, verdict: 'already-reverted', note: 'Already reverted' }
    if ((r.kind !== 'created' && r.kind !== 'updated') || !r.collection || !r.item_id) {
      return { ...base, verdict: 'not-applicable', note: 'Nothing was written for this row' }
    }
    const key = `${r.collection}:${r.item_id}`
    const now = current.get(key)
    if (!now) return { ...base, verdict: 'gone', note: 'The record no longer exists' }
    if (r.kind === 'created') {
      if (touchedSince.has(key)) {
        return { ...base, verdict: 'changed-since', note: 'Changed since the import, so it stays' }
      }
      return { ...base, verdict: 'remove', note: 'Goes to the trash' }
    }
    const changes = parseChanges(r.changes).filter((c) => !HOUSEKEEPING.has(c.field))
    const known = changes.filter((c) => c.from !== undefined && c.field in now)
    if (known.length === 0) {
      return {
        ...base,
        verdict: 'nothing-recorded',
        note: 'The values from before the import were not kept for this record'
      }
    }
    for (const c of known) {
      if (sameStored(now[c.field], c.to)) base.restore[c.field] = c.from ?? null
      else base.left.push(c.field)
    }
    const n = Object.keys(base.restore).length
    if (n === 0) {
      return { ...base, verdict: 'changed-since', note: 'Every field changed again after the import' }
    }
    if (base.left.length > 0) {
      return {
        ...base,
        verdict: 'partly',
        note: `${n} field${n === 1 ? '' : 's'} go back; ${base.left.length} changed again after the import and stay`
      }
    }
    return { ...base, verdict: 'restore', note: `${n} field${n === 1 ? '' : 's'} go back` }
  })

  const count = (v: RevertVerdict[]) => items.filter((i) => v.includes(i.verdict)).length
  return {
    run: runId,
    total: items.length,
    remove: count(['remove']),
    restore: count(['restore']),
    partly: count(['partly']),
    left_alone: count(['changed-since', 'gone', 'nothing-recorded']),
    already_reverted: count(['already-reverted']),
    not_applicable: count(['not-applicable']),
    items
  }
}

export interface RevertOutcome {
  removed: number
  restored: number
  left_alone: number
  failed: number
  failures: string[]
}

const WIDTH = 8

/**
 * Carry out a plan. Writes run several at a time; one failed record never
 * stops the rest. Each item is marked as it lands, so a revert that is
 * interrupted can be started again and picks up what is left.
 */
export async function executeRevert(
  plan: RevertPlan,
  opts: {
    user: User
    label: string
    onProgress?: (done: number, total: number) => void
    cancelled?: () => boolean
  }
): Promise<RevertOutcome> {
  const { updateOne, deleteOne } = await import('./items.js')
  const stamp = `import:${opts.label} (reverted):run-${plan.run}`
  const work = plan.items.filter((i) => ['remove', 'restore', 'partly'].includes(i.verdict))
  const skipped = plan.items.filter((i) =>
    ['changed-since', 'gone', 'nothing-recorded'].includes(i.verdict)
  )
  const out: RevertOutcome = { removed: 0, restored: 0, left_alone: skipped.length, failed: 0, failures: [] }
  const mark = (id: number, note: string, done: boolean) =>
    db('nivaro_import_run_items')
      .where('id', id)
      .update({ revert_note: note.slice(0, 500), ...(done ? { reverted_at: new Date() } : {}) })
      .catch(() => undefined)

  await Promise.all(skipped.map((i) => mark(i.id, i.note, false)))

  let next = 0
  let done = 0
  const worker = async () => {
    while (next < work.length) {
      if (opts.cancelled?.()) return
      const item = work[next++]
      try {
        if (item.verdict === 'remove') {
          await deleteOne(opts.user, item.collection as string, item.item_id as string)
          out.removed++
          await mark(item.id, 'Removed — it is in the trash', true)
        } else {
          await updateOne(opts.user, item.collection as string, item.item_id as string, {
            ...item.restore,
            _change_reason: stamp
          })
          out.restored++
          await mark(item.id, item.note, true)
        }
      } catch (err) {
        out.failed++
        const msg = err instanceof Error ? err.message : String(err)
        if (out.failures.length < 10) out.failures.push(`${item.label ?? item.item_id}: ${msg}`.slice(0, 300))
        await mark(item.id, `Could not be reverted: ${msg}`, false)
      }
      done++
      if (done % 25 === 0 || done === work.length) opts.onProgress?.(done, work.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(WIDTH, work.length || 1) }, worker))
  return out
}
