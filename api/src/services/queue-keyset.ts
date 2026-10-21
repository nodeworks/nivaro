import type { Knex } from 'knex'
import { decodeCursor, encodeCursor, type KeysetSort, keysetBranches } from '../lib/keyset.js'
import { keysetSecret } from './keyset-secret.js'

/**
 * #2447 — cursor paging for a materialized queue worklist. Paging forward with OFFSET makes
 * SQL Server walk and throw away every earlier row; a cursor on (sort column, cache row id)
 * starts where the last page ended, so page 200 costs what page 1 does.
 *
 * Only the sorts the SQL path orders by a plain column walk by cursor: the default (cache
 * row id), label, state, collection and at_risk — each with the cache row id as the
 * tie-break, exactly the ORDER BY the offset path uses. Any other sort (aging, SLA, owners,
 * extra columns, priority) and any cursor that does not decode for this queue + sort fall
 * back to the page number the caller also sent: same rows, the offset way.
 */

export const QUEUE_KEYSET_SORTS = new Set(['', 'label', 'state', 'collection', 'at_risk'])

export interface QueueKeysetPlan {
  sorts: KeysetSort[]
  /** null = the first page of the walk. */
  values: unknown[] | null
}

const cursorScope = (queueId: string) => `queue:${queueId}`

function sortsFor(sort: string): KeysetSort[] | null {
  const desc = sort.startsWith('-')
  const key = desc ? sort.slice(1) : sort
  if (!QUEUE_KEYSET_SORTS.has(key)) return null
  const tie: KeysetSort = { column: 'id', desc: false }
  return key ? [{ column: key, desc }, tie] : [tie]
}

/** The walk `after` asks for, or null when this request pages by number instead. */
export function queueKeysetPlan(
  queueId: string,
  sort: string,
  after: string | undefined
): QueueKeysetPlan | null {
  if (after === undefined) return null
  const sorts = sortsFor(sort)
  if (!sorts) return null
  try {
    return { sorts, values: decodeCursor(after, cursorScope(queueId), sorts, keysetSecret()) }
  } catch {
    // Another queue's / sort's cursor, or a tampered one: page by number.
    return null
  }
}

/** Rows after the cursor, on the `qi` alias. `nullsFirst`: SQL Server/MySQL true. */
export function applyQueueKeyset(
  q: Knex.QueryBuilder,
  plan: QueueKeysetPlan,
  nullsFirst: boolean
): void {
  if (!plan.values) return
  const values = plan.values
  const branches = keysetBranches(plan.sorts, values, nullsFirst)
  if (branches.length === 0) {
    q.whereRaw('1 = 0')
    return
  }
  const col = (i: number) => `qi.${plan.sorts[i].column}`
  const val = (i: number) => values[i] as Knex.Value
  q.where((outer) => {
    for (const terms of branches) {
      outer.orWhere((branch) => {
        for (const t of terms) {
          const c = col(t.column)
          if (t.test === 'eq') branch.where(c, '=', val(t.column))
          else if (t.test === 'null') branch.whereNull(c)
          else if (t.test === 'not_null') branch.whereNotNull(c)
          else if (t.test === 'gt') branch.where(c, '>', val(t.column))
          else if (t.test === 'lt') branch.where(c, '<', val(t.column))
          else if (t.test === 'gt_or_null')
            branch.where((w) => w.where(c, '>', val(t.column)).orWhereNull(c))
          else if (t.test === 'lt_or_null')
            branch.where((w) => w.where(c, '<', val(t.column)).orWhereNull(c))
        }
      })
    }
  })
}

/** The cursor of the page after `rows` (null when the page was not full). */
export function queueNextCursor(
  queueId: string,
  plan: QueueKeysetPlan,
  rows: ReadonlyArray<Record<string, unknown>>,
  limit: number
): string | null {
  if (limit <= 0 || rows.length < limit) return null
  const last = rows[rows.length - 1]
  return encodeCursor(
    cursorScope(queueId),
    plan.sorts,
    plan.sorts.map((s) => {
      const v = last[s.column]
      return typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? null)
    }),
    keysetSecret()
  )
}
