/**
 * Which pipeline instances on a record are PARALLEL-BRANCH CHILDREN (#1240).
 *
 * The split engine (routes/workflows.ts) gives each branch its own instance on
 * the SAME collection/item as the parent, so "the record's instance" must skip
 * them. There is no parent column; the engine records the relationship in
 * history comments as JSON. A person can type a transition comment that
 * parses as that JSON, so a comment alone proves nothing. A child is a branch
 * only when ALL of this holds:
 *
 * - the parent has a SPLIT row and the child has a BRANCH row, both with
 *   `transition IS NULL` — the engine writes lifecycle rows with no
 *   transition; every row carrying a person's comment comes from a transition
 *   (applyTransition, the GraphQL mutation, the branch-transition route), so
 *   a typed comment always sits on a row with a transition id;
 * - the split row lists the child AND the branch row names the parent
 *   (mutual reference);
 * - both instances belong to the same record and template.
 *
 * Anything short of that reads as an ordinary instance.
 */
import { db } from '../db/index.js'
import { pickInstance } from './record-state.js'

export interface InstanceIdentity {
  id: string
  collection: string
  item: string
  template: string
}

export interface LifecycleRow {
  instance: string
  transition: string | null
  comment: string | null
}

/** Engine lifecycle JSON from a history row, or null. Rows with a transition
 *  are never lifecycle rows, whatever their comment says. */
export function engineLifecycle(row: {
  transition: string | null | undefined
  comment: string | null | undefined
}): { action: string; children?: string[]; parent?: string; join_state?: string } | null {
  if (row.transition != null && row.transition !== '') return null
  const s = String(row.comment ?? '').trim()
  if (!s.startsWith('{')) return null
  try {
    const parsed = JSON.parse(s) as Record<string, unknown>
    const action = parsed?.action
    if (action !== 'split' && action !== 'branch' && action !== 'join') return null
    return {
      action,
      children: Array.isArray(parsed.children) ? parsed.children.map(String) : undefined,
      parent: typeof parsed.parent === 'string' ? parsed.parent : undefined,
      join_state: typeof parsed.join_state === 'string' ? parsed.join_state : undefined
    }
  } catch {
    return null
  }
}

const norm = (v: string) => v.toLowerCase()
const sameRecord = (a: InstanceIdentity, b: InstanceIdentity) =>
  a.collection === b.collection &&
  norm(String(a.item)) === norm(String(b.item)) &&
  norm(a.template) === norm(b.template)

/**
 * Branch-child instance ids among `instances`, judged only from the engine's
 * own lifecycle rows. Pure — unit-tested with forged comments.
 */
export function verifiedBranchChildren(
  instances: InstanceIdentity[],
  rows: LifecycleRow[]
): Set<string> {
  const byId = new Map(instances.map((i) => [norm(i.id), i]))
  const splitChildren = new Map<string, Set<string>>() // parent → children it lists
  const branchParent = new Map<string, Set<string>>() // child → parents it names
  for (const row of rows) {
    const life = engineLifecycle(row)
    if (!life) continue
    const inst = norm(row.instance)
    if (life.action === 'split' && life.children) {
      const set = splitChildren.get(inst) ?? new Set<string>()
      for (const c of life.children) set.add(norm(c))
      splitChildren.set(inst, set)
    } else if (life.action === 'branch' && life.parent) {
      const set = branchParent.get(inst) ?? new Set<string>()
      set.add(norm(life.parent))
      branchParent.set(inst, set)
    }
  }
  const out = new Set<string>()
  for (const [childId, parents] of branchParent) {
    const child = byId.get(childId)
    if (!child) continue
    for (const parentId of parents) {
      const parent = byId.get(parentId)
      if (!parent || parentId === childId) continue
      if (!sameRecord(parent, child)) continue
      if (!splitChildren.get(parentId)?.has(childId)) continue
      out.add(child.id)
      break
    }
  }
  return out
}

/**
 * `instances` minus verified branch children. Only records holding more than
 * one instance can have children, so a page of one-instance records costs no
 * query at all.
 */
export async function excludeBranchChildren<T extends InstanceIdentity>(
  instances: T[],
  database: typeof db = db
): Promise<T[]> {
  const count = new Map<string, number>()
  const key = (i: InstanceIdentity) => `${i.collection}\u0000${norm(String(i.item))}`
  for (const i of instances) count.set(key(i), (count.get(key(i)) ?? 0) + 1)
  const shared = instances.filter((i) => (count.get(key(i)) ?? 0) > 1)
  if (shared.length === 0) return instances
  const rows: LifecycleRow[] = []
  const ids = shared.map((i) => i.id)
  for (let k = 0; k < ids.length; k += 1500) {
    const part = (await database('nivaro_workflow_history')
      .whereIn('instance', ids.slice(k, k + 1500))
      .whereNull('transition')
      .where('comment', 'like', '%"action":%')
      .select('instance', 'transition', 'comment')) as LifecycleRow[]
    rows.push(...part)
  }
  const children = verifiedBranchChildren(shared, rows)
  return children.size === 0 ? instances : instances.filter((i) => !children.has(i.id))
}

/**
 * THE record's pipeline instance: never a branch child; among the rest the
 * open one, else the newest by start (the rule $state and the state views
 * use). Undefined when the record runs no pipeline.
 */
export async function findRecordInstance<T extends InstanceIdentity = InstanceIdentity>(
  collection: string,
  item: string | number,
  database: typeof db = db
): Promise<T | undefined> {
  const rows = (await database('nivaro_workflow_instances')
    .where({ collection, item: String(item) })
    .select('*')) as Array<T & { completed_at: Date | null; started_at: Date | null }>
  if (rows.length <= 1) return rows[0]
  const kept = await excludeBranchChildren(rows, database)
  return pickInstance(kept.length ? kept : rows) as T | undefined
}
