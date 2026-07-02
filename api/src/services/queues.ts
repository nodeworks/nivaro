import { db } from '../db/index.js'
import { type ApprovalChainStep, resolveStepApprovers } from '../routes/approvals.js'
import {
  type AtRiskRuleRow,
  evaluateRows,
  parseActiveRules,
  referencedFields
} from '../routes/at-risk.js'
import { computeStatusBatch } from '../routes/sla.js'
import type { CMSRelation, User } from '../types.js'
import { getCollection, getRelations } from './collections.js'
import { extractTemplateFields, resolveDisplayValue } from './display-value.js'
import { can } from './permissions.js'
import { parseJson, resolveStateOwners } from './pipeline-engine.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export type QueueSourceType = 'collection' | 'tasks' | 'approvals' | 'owned_by_me'

export type QueueConditionOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'null'
  | 'nnull'

export interface QueueCondition {
  field: string
  op: QueueConditionOp
  value?: unknown
}

export interface QueueSourceRow {
  id: number
  queue_id: string
  type: QueueSourceType
  collection: string | null
  filters: string | null
  state_values: string | null
  sla_filter: string | null
  extra_fields: string | null
  sort: number
}

export interface QueueRow {
  id: string
  name: string
  description: string | null
  icon: string | null
  color: string | null
  owner: string
  is_shared: boolean | number
  role_id: string | null
  view_mode: 'table' | 'kanban' | 'both'
  is_active: boolean | number
  created_at: Date
  updated_at: Date | null
}

export interface QueueOwner {
  id: string
  name: string
}

export interface QueueItem {
  collection: string
  item_id: string
  label: string
  state: string | null
  state_color: string | null
  owners: QueueOwner[]
  sla_status: 'ok' | 'warning' | 'breached' | null
  at_risk: boolean
  aging_hours: number | null
  claimed_by: QueueOwner | null
  extra?: Record<string, unknown>
  url: string
}

export interface QueueStats {
  total: number
  by_state: Record<string, number>
  unowned: number
}

export interface WorkloadRow {
  owner: QueueOwner | null
  count: number
  max_wip: number | null
}

export type QueueScope = 'mine' | 'unowned' | 'all' | 'claimed'

export const SOURCE_ROW_CAP = 1000

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export function mergeSourceResults(results: QueueItem[][]): QueueItem[] {
  const seen = new Set<string>()
  const out: QueueItem[] = []
  for (const batch of results) {
    for (const item of batch) {
      const key = `${item.collection}:${item.item_id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }
  return out
}

export function applyScopeFilter(
  items: QueueItem[],
  scope: QueueScope,
  userId: string
): QueueItem[] {
  if (scope === 'all') return items
  if (scope === 'unowned') return items.filter((i) => i.owners.length === 0)
  if (scope === 'claimed') return items.filter((i) => i.claimed_by?.id === userId)
  return items.filter((i) => i.owners.some((o) => o.id === userId))
}

export function attachClaims(items: QueueItem[], claims: Map<string, QueueOwner>): QueueItem[] {
  return items.map((item) => ({
    ...item,
    claimed_by: claims.get(`${item.collection}:${item.item_id}`) ?? null
  }))
}

export function computeStats(items: QueueItem[]): QueueStats {
  const by_state: Record<string, number> = {}
  let unowned = 0
  for (const item of items) {
    const key = item.state ?? 'none'
    by_state[key] = (by_state[key] ?? 0) + 1
    if (item.owners.length === 0) unowned++
  }
  return { total: items.length, by_state, unowned }
}

const UNASSIGNED_KEY = '__unassigned__'

export function groupByOwner(
  items: QueueItem[]
): Map<string, { owner: QueueOwner | null; count: number }> {
  const groups = new Map<string, { owner: QueueOwner | null; count: number }>()
  for (const item of items) {
    if (item.owners.length === 0) {
      const existing = groups.get(UNASSIGNED_KEY) ?? { owner: null, count: 0 }
      existing.count++
      groups.set(UNASSIGNED_KEY, existing)
      continue
    }
    for (const owner of item.owners) {
      const existing = groups.get(owner.id) ?? { owner, count: 0 }
      existing.count++
      groups.set(owner.id, existing)
    }
  }
  return groups
}

export function filterBySlaStatus(
  ids: string[],
  slaMap: Record<string, { status: string }>,
  filter: string | null
): string[] {
  if (!filter) return ids
  return ids.filter((id) => slaMap[id]?.status === filter)
}

export function computeAvailableExtraFields(sources: QueueSourceRow[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const source of sources) {
    if (source.type !== 'collection') continue
    const fields = (parseJson(source.extra_fields) as string[] | null) ?? []
    for (const field of fields) {
      if (seen.has(field)) continue
      seen.add(field)
      out.push(field)
    }
  }
  return out
}

export interface RelationSegmentInfo {
  type: 'm2o' | 'm2m' | 'o2m'
  relatedCollection: string
  manyField?: string
  junction?: string
  junctionFkToParent?: string
  junctionFkToOther?: string
}

export function classifyRelationSegment(
  collection: string,
  segment: string,
  relations: CMSRelation[]
): RelationSegmentInfo | null {
  const m2o = relations.find(
    (r) =>
      r.many_collection === collection &&
      r.many_field === segment &&
      r.junction_field === null &&
      r.one_collection
  )
  if (m2o) return { type: 'm2o', relatedCollection: m2o.one_collection as string }

  const m2mParent = relations.find(
    (r) =>
      r.one_collection === collection &&
      r.one_field === segment &&
      r.junction_field !== null &&
      r.many_collection
  )
  if (m2mParent) {
    const target = relations.find(
      (r) =>
        r.many_collection === m2mParent.many_collection &&
        r.many_field === m2mParent.junction_field &&
        r.one_collection
    )
    if (target?.one_collection) {
      return {
        type: 'm2m',
        relatedCollection: target.one_collection,
        junction: m2mParent.many_collection,
        junctionFkToParent: m2mParent.many_field,
        junctionFkToOther: m2mParent.junction_field as string
      }
    }
  }

  const o2m = relations.find(
    (r) =>
      r.one_collection === collection &&
      r.one_field === segment &&
      r.junction_field === null &&
      r.many_collection
  )
  if (o2m)
    return {
      type: 'o2m',
      relatedCollection: o2m.many_collection,
      manyField: o2m.many_field as string
    }

  return null
}

export function formatMultiValueCell(values: string[], totalCount: number, cap = 3): string {
  if (totalCount === 0) return ''
  const shown = values.slice(0, cap)
  const remaining = totalCount - shown.length
  return remaining > 0 ? `${shown.join(', ')} +${remaining} more` : shown.join(', ')
}

export interface ConditionBuilder {
  where(field: string, value: unknown): ConditionBuilder
  where(field: string, op: string, value: unknown): ConditionBuilder
  whereNot(field: string, value: unknown): ConditionBuilder
  whereNull(field: string): ConditionBuilder
  whereNotNull(field: string): ConditionBuilder
}

export function applyQueueConditions(q: ConditionBuilder, conditions: QueueCondition[]): void {
  for (const c of conditions) {
    switch (c.op) {
      case 'eq':
        q.where(c.field, c.value)
        break
      case 'neq':
        q.whereNot(c.field, c.value)
        break
      case 'contains':
        q.where(c.field, 'like', `%${String(c.value)}%`)
        break
      case 'gt':
        q.where(c.field, '>', c.value)
        break
      case 'gte':
        q.where(c.field, '>=', c.value)
        break
      case 'lt':
        q.where(c.field, '<', c.value)
        break
      case 'lte':
        q.where(c.field, '<=', c.value)
        break
      case 'null':
        q.whereNull(c.field)
        break
      case 'nnull':
        q.whereNotNull(c.field)
        break
    }
  }
}

// ─── Labels ───────────────────────────────────────────────────────────────────

const LABEL_CANDIDATES = ['title', 'name', 'label', 'subject']

/** Best-effort display labels for a set of {collection,item_id} pairs. Mirrors tasks.ts getItemLabels(). */
export async function getLabels(
  itemsByCollection: Map<string, Set<string>>
): Promise<Record<string, string>> {
  const labels: Record<string, string> = {}
  for (const [collection, ids] of itemsByCollection) {
    try {
      const fields = (await db('nivaro_fields').where({ collection }).select('field')) as Array<{
        field: string
      }>
      const fieldNames = fields.map((f) => f.field)
      const labelField = LABEL_CANDIDATES.find((c) => fieldNames.includes(c))
      const pk = fieldNames.includes('id') ? 'id' : null
      if (!labelField || !pk) continue

      const rows = (await db(collection)
        .whereIn(pk, [...ids])
        .select(pk, labelField)) as Array<Record<string, unknown>>
      for (const row of rows) {
        const value = row[labelField]
        if (value != null) labels[`${collection}:${row[pk]}`] = String(value)
      }
    } catch {
      // Collection table may not exist or be queryable — labels stay empty
    }
  }
  return labels
}

export async function getClaims(queueId: string): Promise<Map<string, QueueOwner>> {
  const rows = (await db('nivaro_queue_claims as c')
    .join('nivaro_users as u', 'c.claimed_by', 'u.id')
    .where('c.queue_id', queueId)
    .select(
      'c.source_collection',
      'c.item_id',
      'u.id',
      'u.first_name',
      'u.last_name',
      'u.email'
    )) as Array<{
    source_collection: string
    item_id: string
    id: string
    first_name: string | null
    last_name: string | null
    email: string
  }>

  const out = new Map<string, QueueOwner>()
  for (const r of rows) {
    out.set(`${r.source_collection}:${r.item_id}`, {
      id: r.id,
      name: userDisplayName({ first_name: r.first_name, last_name: r.last_name, email: r.email })
    })
  }
  return out
}

function userDisplayName(row: {
  first_name: string | null
  last_name: string | null
  email?: string
}): string {
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ')
  return name || row.email || 'Unknown'
}

// ─── Relation path resolution ──────────────────────────────────────────────────

async function resolvePathValues(
  collection: string,
  ids: string[],
  segments: string[],
  relationsCache: Map<string, CMSRelation[]>
): Promise<Map<string, string>> {
  if (ids.length === 0 || segments.length === 0) return new Map()

  let relations = relationsCache.get(collection)
  if (!relations) {
    relations = await getRelations(collection)
    relationsCache.set(collection, relations)
  }

  const [head, ...rest] = segments
  const classified = classifyRelationSegment(collection, head, relations)

  if (!classified) {
    const rows = (await db(collection).whereIn('id', ids).select(['id', head])) as Array<
      Record<string, unknown>
    >
    const out = new Map<string, string>()
    for (const row of rows) {
      const v = row[head]
      out.set(String(row.id), v == null ? '' : String(v))
    }
    return out
  }

  if (classified.type === 'm2o') {
    const rows = (await db(collection).whereIn('id', ids).select(['id', head])) as Array<
      Record<string, unknown>
    >
    const fkByRowId = new Map<string, string>()
    const relatedIds = new Set<string>()
    for (const row of rows) {
      if (row[head] == null) continue
      const fk = String(row[head])
      fkByRowId.set(String(row.id), fk)
      relatedIds.add(fk)
    }
    if (relatedIds.size === 0) return new Map()

    if (rest.length > 0) {
      const nested = await resolvePathValues(
        classified.relatedCollection,
        [...relatedIds],
        rest,
        relationsCache
      )
      const out = new Map<string, string>()
      for (const [rowId, fk] of fkByRowId) {
        const v = nested.get(fk)
        if (v !== undefined) out.set(rowId, v)
      }
      return out
    }

    const relatedCol = await getCollection(classified.relatedCollection)
    const template = relatedCol?.display_template ?? null
    const selectFields = template ? extractTemplateFields(template) : ['*']
    const relatedRows = (await db(classified.relatedCollection)
      .whereIn('id', [...relatedIds])
      .select(selectFields)) as Array<Record<string, unknown>>
    const displayById = new Map<string, string>()
    for (const r of relatedRows) displayById.set(String(r.id), resolveDisplayValue(r, template))
    const out = new Map<string, string>()
    for (const [rowId, fk] of fkByRowId) {
      const v = displayById.get(fk)
      if (v !== undefined) out.set(rowId, v)
    }
    return out
  }

  // M2M / O2M — always resolved as a leaf (multi-value), regardless of remaining
  // segments. Chaining a path through a multi-valued relation into another field
  // is out of scope (see docs/superpowers/specs/2026-07-02-queue-extra-field-relations-design.md)
  // — a queue-owner path that does this simply resolves as if it ended here.
  const relatedCol = await getCollection(classified.relatedCollection)
  const template = relatedCol?.display_template ?? null
  const selectFields = template ? extractTemplateFields(template) : ['*']

  if (classified.type === 'o2m') {
    const manyField = classified.manyField as string
    const relatedRows = (await db(classified.relatedCollection)
      .whereIn(manyField, ids)
      .select([manyField, ...selectFields])) as Array<Record<string, unknown>>
    const grouped = new Map<string, Record<string, unknown>[]>()
    for (const row of relatedRows) {
      const parentId = String(row[manyField])
      const list = grouped.get(parentId) ?? []
      list.push(row)
      grouped.set(parentId, list)
    }
    const out = new Map<string, string>()
    for (const rowId of ids) {
      const related = grouped.get(rowId) ?? []
      const values = related.slice(0, 3).map((r) => resolveDisplayValue(r, template))
      out.set(rowId, formatMultiValueCell(values, related.length))
    }
    return out
  }

  // m2m
  const junctionRows = (await db(`${classified.junction} as _j`)
    .whereIn(`_j.${classified.junctionFkToParent}`, ids)
    .join(
      `${classified.relatedCollection} as _rel`,
      '_rel.id',
      `_j.${classified.junctionFkToOther}`
    )
    .select([
      `_j.${classified.junctionFkToParent} as __parent_id`,
      ...selectFields.map((f) => `_rel.${f}`)
    ])) as Array<Record<string, unknown>>
  const grouped = new Map<string, Record<string, unknown>[]>()
  for (const row of junctionRows) {
    const parentId = String(row.__parent_id)
    const list = grouped.get(parentId) ?? []
    list.push(row)
    grouped.set(parentId, list)
  }
  const out = new Map<string, string>()
  for (const rowId of ids) {
    const related = grouped.get(rowId) ?? []
    const values = related.slice(0, 3).map((r) => resolveDisplayValue(r, template))
    out.set(rowId, formatMultiValueCell(values, related.length))
  }
  return out
}

// ─── Source resolvers ───────────────────────────────────────────────────────────

export async function resolveCollectionSource(
  source: QueueSourceRow,
  user: User
): Promise<QueueItem[]> {
  if (!source.collection) return []
  if (!(await can(user, 'read', source.collection))) return []
  const conditions = (parseJson(source.filters) as QueueCondition[] | null) ?? []
  const stateValues = parseJson(source.state_values) as string[] | null

  let rows: Array<{ id: string | number }>
  try {
    const q = db(source.collection).select('id').limit(SOURCE_ROW_CAP)
    applyQueueConditions(q as unknown as ConditionBuilder, conditions)
    rows = (await q) as Array<{ id: string | number }>
  } catch {
    return []
  }
  let ids = rows.map((r) => String(r.id))
  if (ids.length === 0) return []

  const labels = await getLabels(new Map([[source.collection, new Set(ids)]]))

  const binding = (await db('nivaro_workflow_bindings')
    .where({ collection: source.collection })
    .first()) as { id: number; template: string } | undefined

  const stateById = new Map<string, { key: string; color: string | null }>()
  const ownersById = new Map<string, QueueOwner[]>()

  if (binding) {
    const instances = (await db('nivaro_workflow_instances as wi')
      .leftJoin('nivaro_workflow_states as s', 'wi.current_state', 's.id')
      .whereIn('wi.item', ids)
      .where('wi.collection', source.collection)
      .select(
        'wi.id as instance_id',
        'wi.item',
        'wi.current_state',
        's.key as state_key',
        's.color as state_color'
      )) as Array<{
      instance_id: string
      item: string
      current_state: string | null
      state_key: string | null
      state_color: string | null
    }>

    if (stateValues?.length) {
      const keep = new Set(
        instances.filter((i) => i.state_key && stateValues.includes(i.state_key)).map((i) => i.item)
      )
      ids = ids.filter((id) => keep.has(id))
    }

    for (const inst of instances) {
      if (!ids.includes(inst.item)) continue
      if (inst.state_key) stateById.set(inst.item, { key: inst.state_key, color: inst.state_color })
      if (inst.current_state) {
        const owners = await resolveStateOwners(
          inst.current_state,
          inst.instance_id,
          source.collection,
          inst.item
        )
        ownersById.set(
          inst.item,
          owners.map((o) => ({ id: o.id, name: userDisplayName(o) }))
        )
      }
    }
  }

  const slaMap = ids.length ? await computeStatusBatch(source.collection, ids) : {}
  ids = filterBySlaStatus(ids, slaMap, source.sla_filter)

  const extraFieldPaths = (parseJson(source.extra_fields) as string[] | null) ?? []
  const extraById = new Map<string, Record<string, unknown>>()
  if (extraFieldPaths.length && ids.length) {
    const relationsCache = new Map<string, CMSRelation[]>()
    for (const path of extraFieldPaths) {
      try {
        const segments = path.split('.')
        const valuesByRowId = await resolvePathValues(
          source.collection,
          ids,
          segments,
          relationsCache
        )
        for (const [rowId, value] of valuesByRowId) {
          const extra = extraById.get(rowId) ?? {}
          extra[path] = value
          extraById.set(rowId, extra)
        }
      } catch {
        // Degrade gracefully — a stale/deleted/relational field config must not
        // break the whole queue's item list, and must not prevent OTHER extra
        // field paths on the same source from resolving.
      }
    }
  }

  const ruleRows = (await db('nivaro_at_risk_rules')
    .where({ collection: source.collection, is_active: true })
    .orderBy('id')) as AtRiskRuleRow[]
  const rules = parseActiveRules(ruleRows)
  let atRiskMap: Record<string, { at_risk: true; rule: string; color: 'red' | 'amber' }> = {}
  if (rules.length && ids.length) {
    const fields = new Set<string>(['id'])
    for (const rule of rules) for (const f of referencedFields(rule.conditions)) fields.add(f)
    const riskRows = (await db(source.collection)
      .whereIn('id', ids)
      .select([...fields])) as Record<string, unknown>[]
    atRiskMap = evaluateRows(riskRows, rules)
  }

  return ids.map((id) => ({
    collection: source.collection as string,
    item_id: id,
    label: labels[`${source.collection}:${id}`] ?? id,
    state: stateById.get(id)?.key ?? null,
    state_color: stateById.get(id)?.color ?? null,
    owners: ownersById.get(id) ?? [],
    sla_status: slaMap[id]?.status ?? null,
    at_risk: !!atRiskMap[id]?.at_risk,
    aging_hours: slaMap[id]?.elapsed_hours ?? null,
    claimed_by: null,
    extra: extraById.get(id) ?? {},
    url: `/collections/${source.collection}/${id}`
  }))
}

export async function resolveTasksSource(): Promise<QueueItem[]> {
  const rows = (await db('nivaro_tasks as t')
    .leftJoin('nivaro_users as u', 't.assignee', 'u.id')
    .where('t.status', 'open')
    .orderBy('t.created_at', 'asc')
    .limit(SOURCE_ROW_CAP)
    .select(
      't.id',
      't.title',
      't.collection as target_collection',
      't.item as target_item',
      't.created_at',
      't.assignee',
      'u.first_name as assignee_first',
      'u.last_name as assignee_last',
      'u.email as assignee_email'
    )) as Array<{
    id: number
    title: string
    target_collection: string
    target_item: string
    created_at: Date
    assignee: string
    assignee_first: string | null
    assignee_last: string | null
    assignee_email: string
  }>

  const now = Date.now()
  return rows.map((r) => ({
    collection: 'tasks',
    item_id: String(r.id),
    label: r.title,
    state: null,
    state_color: null,
    owners: [
      {
        id: r.assignee,
        name: userDisplayName({
          first_name: r.assignee_first,
          last_name: r.assignee_last,
          email: r.assignee_email
        })
      }
    ],
    sla_status: null,
    at_risk: false,
    aging_hours: Math.max(0, (now - new Date(r.created_at).getTime()) / (1000 * 60 * 60)),
    claimed_by: null,
    url: `/collections/${r.target_collection}/${r.target_item}`
  }))
}

export async function resolveApprovalsSource(): Promise<QueueItem[]> {
  const rows = (await db('nivaro_approval_instances as i')
    .where('i.status', 'pending')
    .orderBy('i.created_at', 'asc')
    .limit(SOURCE_ROW_CAP)
    .select(
      'i.id',
      'i.collection',
      'i.item',
      'i.created_at',
      'i.current_step',
      'i.chain'
    )) as Array<{
    id: number
    collection: string
    item: string
    created_at: Date
    current_step: number
    chain: number
  }>
  if (rows.length === 0) return []

  const stepRows = (await db('nivaro_approval_chain_steps')
    .whereIn('chain', [...new Set(rows.map((r) => r.chain))])
    .select(
      'id',
      'chain',
      'step_order',
      'approver',
      'approver_role',
      'label'
    )) as ApprovalChainStep[]

  const byCollection = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!byCollection.has(r.collection)) byCollection.set(r.collection, new Set())
    byCollection.get(r.collection)!.add(r.item)
  }
  const labels = await getLabels(byCollection)

  const now = Date.now()
  const out: QueueItem[] = []
  for (const r of rows) {
    const step = stepRows.find((s) => s.chain === r.chain && s.step_order === r.current_step)
    const approverIds = step ? await resolveStepApprovers(step) : []
    let owners: QueueOwner[] = []
    if (approverIds.length > 0) {
      const users = (await db('nivaro_users')
        .whereIn('id', approverIds)
        .select('id', 'first_name', 'last_name', 'email')) as Array<{
        id: string
        first_name: string | null
        last_name: string | null
        email: string
      }>
      owners = users.map((u) => ({ id: u.id, name: userDisplayName(u) }))
    }

    out.push({
      collection: r.collection,
      item_id: String(r.item),
      label: labels[`${r.collection}:${r.item}`] ?? String(r.item),
      state: 'pending_approval',
      state_color: null,
      owners,
      sla_status: null,
      at_risk: false,
      aging_hours: Math.max(0, (now - new Date(r.created_at).getTime()) / (1000 * 60 * 60)),
      claimed_by: null,
      url: `/collections/${r.collection}/${r.item}`
    })
  }
  return out
}

export async function resolveOwnedByMeSource(userId: string): Promise<QueueItem[]> {
  const instances = (await db('nivaro_workflow_instances as wi')
    .join('nivaro_workflow_bindings as b', 'wi.collection', 'b.collection')
    .leftJoin('nivaro_workflow_states as s', 'wi.current_state', 's.id')
    .whereNotNull('wi.current_state')
    .whereNull('wi.completed_at')
    .limit(SOURCE_ROW_CAP)
    .select(
      'wi.id as instance_id',
      'wi.collection',
      'wi.item',
      'wi.current_state',
      's.key as state_key',
      's.color as state_color'
    )) as Array<{
    instance_id: string
    collection: string
    item: string
    current_state: string
    state_key: string | null
    state_color: string | null
  }>
  if (instances.length === 0) return []

  const byCollection = new Map<string, Set<string>>()
  for (const inst of instances) {
    if (!byCollection.has(inst.collection)) byCollection.set(inst.collection, new Set())
    byCollection.get(inst.collection)!.add(inst.item)
  }
  const labels = await getLabels(byCollection)

  const out: QueueItem[] = []
  for (const inst of instances) {
    const owners = await resolveStateOwners(
      inst.current_state,
      inst.instance_id,
      inst.collection,
      inst.item
    )
    if (!owners.some((o) => o.id === userId)) continue
    out.push({
      collection: inst.collection,
      item_id: inst.item,
      label: labels[`${inst.collection}:${inst.item}`] ?? inst.item,
      state: inst.state_key,
      state_color: inst.state_color,
      owners: owners.map((o) => ({ id: o.id, name: userDisplayName(o) })),
      sla_status: null,
      at_risk: false,
      aging_hours: null,
      claimed_by: null,
      url: `/collections/${inst.collection}/${inst.item}`
    })
  }
  return out
}

// ─── Orchestrator ───────────────────────────────────────────────────────────────

export async function fetchQueueItems(
  queueId: string,
  user: User,
  scope: QueueScope
): Promise<{ items: QueueItem[]; stats: QueueStats }> {
  const sources = (await db<QueueSourceRow>('nivaro_queue_sources')
    .where({ queue_id: queueId })
    .orderBy('sort')) as QueueSourceRow[]

  const batches = await Promise.all(
    sources.map((source) => {
      if (source.type === 'collection') return resolveCollectionSource(source, user)
      if (source.type === 'tasks') return resolveTasksSource()
      if (source.type === 'approvals') return resolveApprovalsSource()
      return resolveOwnedByMeSource(user.id)
    })
  )

  const merged = mergeSourceResults(batches)
  const claims = await getClaims(queueId)
  const withClaims = attachClaims(merged, claims)
  const scoped = applyScopeFilter(withClaims, scope, user.id)
  return { items: scoped, stats: computeStats(scoped) }
}

export async function getWipLimits(ownerIds: string[]): Promise<Map<string, number>> {
  if (ownerIds.length === 0) return new Map()
  const rows = (await db('nivaro_pipeline_owner_group_users as gu')
    .join('nivaro_pipeline_owner_groups as g', 'gu.group', 'g.id')
    .whereIn('gu.user', ownerIds)
    .whereNotNull('g.max_wip')
    .select('gu.user', 'g.max_wip')) as Array<{ user: string; max_wip: number }>

  const out = new Map<string, number>()
  for (const r of rows) {
    const current = out.get(r.user)
    if (current === undefined || r.max_wip < current) out.set(r.user, r.max_wip)
  }
  return out
}

export async function fetchQueueWorkload(queueId: string, user: User): Promise<WorkloadRow[]> {
  const { items } = await fetchQueueItems(queueId, user, 'all')
  const groups = groupByOwner(items)
  const ownerIds = [...groups.values()].map((g) => g.owner?.id).filter((id): id is string => !!id)
  const limits = await getWipLimits(ownerIds)

  return [...groups.values()].map((g) => ({
    owner: g.owner,
    count: g.count,
    max_wip: g.owner ? (limits.get(g.owner.id) ?? null) : null
  }))
}
