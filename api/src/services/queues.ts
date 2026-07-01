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
  url: string
}

export interface QueueStats {
  total: number
  by_state: Record<string, number>
  unowned: number
}

export type QueueScope = 'mine' | 'unowned' | 'all'

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
  return items.filter((i) => i.owners.some((o) => o.id === userId))
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
