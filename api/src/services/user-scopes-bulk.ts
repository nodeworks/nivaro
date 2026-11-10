/**
 * Bulk edit of people's RESTRICTED scope values (Rob 2026-11-10: "bulk add /
 * remove zones for people … it should be for their restricted zones").
 *
 * One dimension, mode 'restrict' only, for up to 500 people at once:
 *   add    — their restricted values ∪ the picked values
 *   remove — their restricted values ∖ the picked values
 * A person's other dimensions, their DEFAULT filters and any value not named
 * are never touched.
 *
 * Two cases are not changed by default, because they WIDEN access rather than
 * narrow it, which a bulk tick-and-confirm should never do quietly:
 *   - add on a person with no restriction on this dimension: they already see
 *     every value; adding would turn "everything" into "only these";
 *   - remove that takes away their LAST restricted value: an empty restriction
 *     is no restriction — they would see every value. `allow_empty` opts in.
 *
 * The plan is pure (planScopeChange); runBulkScopeChange takes its reads and
 * writes as deps so the route wires the database and tests wire fakes.
 */

export type ScopeValue = string | number
export type BulkScopeOp = 'add' | 'remove'

export type BulkScopeStatus = 'change' | 'unchanged' | 'refused' | 'not_found'

export interface PlannedChange {
  after: ScopeValue[]
  status: Exclude<BulkScopeStatus, 'not_found'>
  reason?: string
}

const keyOf = (v: ScopeValue) => String(v).trim().toLowerCase()

/** One person's change. `current` = their stored restricted values ([] = no restriction). */
export function planScopeChange(
  current: ScopeValue[],
  op: BulkScopeOp,
  values: ScopeValue[],
  opts: { allowEmpty?: boolean; noun?: string } = {}
): PlannedChange {
  const noun = opts.noun ?? 'value'
  if (current.length === 0)
    return {
      after: [],
      status: 'unchanged',
      reason: `No ${noun} restriction — already sees every ${noun}`
    }
  const have = new Set(current.map(keyOf))
  if (op === 'add') {
    const added = values.filter((v) => !have.has(keyOf(v)))
    const seen = new Set<string>()
    const extra = added.filter((v) => {
      const k = keyOf(v)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    if (extra.length === 0)
      return { after: current, status: 'unchanged', reason: `Already has these ${noun}s` }
    return { after: [...current, ...extra], status: 'change' }
  }
  const drop = new Set(values.map(keyOf))
  const after = current.filter((v) => !drop.has(keyOf(v)))
  if (after.length === current.length)
    return { after: current, status: 'unchanged', reason: `Has none of these ${noun}s` }
  if (after.length === 0 && !opts.allowEmpty)
    return {
      after: current,
      status: 'refused',
      reason: `Would remove their last restricted ${noun} — with none left they would see every ${noun}`
    }
  return { after, status: 'change' }
}

export interface BulkScopeRow {
  user_id: string
  name: string
  before: ScopeValue[]
  after: ScopeValue[]
  before_labels: string[]
  after_labels: string[]
  status: BulkScopeStatus
  reason?: string
  /** Real run only: the write for this person failed (others still ran). */
  error?: string
}

export interface BulkScopeDeps {
  /** id → display name, for the people that exist. */
  users(ids: string[]): Promise<Map<string, string>>
  /** user id (lower-case) → stored restricted values for the dimension. */
  restricted(ids: string[], dimension: string): Promise<Map<string, ScopeValue[]>>
  /** value key → label, for values that exist in the dimension's collection. */
  labels(values: ScopeValue[]): Promise<Map<string, string>>
  /** Store one person's restricted values ([] = remove the restriction row). */
  write(
    userId: string,
    dimension: string,
    values: ScopeValue[],
    before: ScopeValue[]
  ): Promise<void>
}

export interface BulkScopeInput {
  userIds: string[]
  dimension: string
  noun: string
  op: BulkScopeOp
  values: ScopeValue[]
  preview: boolean
  allowEmpty: boolean
}

export interface BulkScopeResult {
  rows: BulkScopeRow[]
  counts: Record<BulkScopeStatus | 'failed', number>
  unknown_values: ScopeValue[]
}

export async function runBulkScopeChange(
  input: BulkScopeInput,
  deps: BulkScopeDeps
): Promise<BulkScopeResult> {
  const ids = [...new Set(input.userIds.map((u) => String(u).trim()).filter(Boolean))]
  const labels = await deps.labels(input.values)
  const unknown = input.values.filter((v) => !labels.has(keyOf(v)))
  const counts: BulkScopeResult['counts'] = {
    change: 0,
    unchanged: 0,
    refused: 0,
    not_found: 0,
    failed: 0
  }
  if (unknown.length > 0) return { rows: [], counts, unknown_values: unknown }
  const names = await deps.users(ids)
  const current = await deps.restricted(ids, input.dimension)
  const beforeAll = [...current.values()].flat()
  const allLabels = new Map(labels)
  if (beforeAll.length > 0)
    for (const [k, v] of await deps.labels(beforeAll)) if (!allLabels.has(k)) allLabels.set(k, v)
  const label = (v: ScopeValue) => allLabels.get(keyOf(v)) ?? String(v)

  const rows: BulkScopeRow[] = []
  for (const id of ids) {
    const name = [...names.entries()].find(([k]) => k.toLowerCase() === id.toLowerCase())?.[1]
    if (name == null) {
      counts.not_found++
      rows.push({
        user_id: id,
        name: id,
        before: [],
        after: [],
        before_labels: [],
        after_labels: [],
        status: 'not_found',
        reason: 'No such person'
      })
      continue
    }
    const before = current.get(id.toLowerCase()) ?? []
    const plan = planScopeChange(before, input.op, input.values, {
      allowEmpty: input.allowEmpty,
      noun: input.noun
    })
    const row: BulkScopeRow = {
      user_id: id,
      name,
      before,
      after: plan.after,
      before_labels: before.map(label),
      after_labels: plan.after.map(label),
      status: plan.status,
      ...(plan.reason ? { reason: plan.reason } : {})
    }
    if (!input.preview && plan.status === 'change') {
      try {
        await deps.write(id, input.dimension, plan.after, before)
      } catch (e) {
        row.error = e instanceof Error ? e.message : String(e)
        counts.failed++
        rows.push(row)
        continue
      }
    }
    counts[plan.status]++
    rows.push(row)
  }
  return { rows, counts, unknown_values: [] }
}
