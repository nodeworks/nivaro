import { db } from '../db/index.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkflowState {
  id: string
  template: string
  key: string
  label: string
  color: string | null
  is_initial: boolean
  is_terminal: boolean
  lock_record: boolean
  sort: number
  skip_criteria: string | null
}

export interface WorkflowTransition {
  id: string
  template: string
  from_state: string | null
  to_state: string
  label: string
  color: string | null
  required_roles: string | null
  actions: string | null
  sort: number
}

export interface WorkflowInstance {
  id: string
  template: string
  collection: string
  item: string
  current_state: string | null
  started_at: Date
  completed_at: Date | null
}

export interface WorkflowHistory {
  id: number
  instance: string
  transition: string | null
  from_state: string | null
  to_state: string
  user: string | null
  comment: string | null
  timestamp: Date
}

export interface OwnerGroup {
  id: string
  template: string
  state: string
  name: string | null
  filters: string | null
  sort: number
  is_default: boolean
  priority: number
}

export interface ResolvedOwner {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
}

type SkipOp = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'notin'

export type SkipCondition =
  | { type: 'no_owners' }
  | { type: 'field_compare'; field: string; op: SkipOp; value: unknown }
  | { type: 'field_empty'; field: string }
  | { type: 'field_nonempty'; field: string }

export interface SkipCriteria {
  mode: 'any' | 'all'
  conditions: SkipCondition[]
}

export interface RecordFilter {
  field: string
  op: SkipOp
  value: unknown
  id_value?: number | null
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function parseJson(val: string | null | undefined): unknown {
  if (!val) return null
  try {
    return JSON.parse(val)
  } catch {
    return null
  }
}

export function toJsonStr(val: unknown): string | null {
  if (val === null || val === undefined) return null
  if (typeof val === 'string') return val
  return JSON.stringify(val)
}

export function coerceBool(val: unknown): boolean {
  if (typeof val === 'boolean') return val
  if (val === 1 || val === '1' || val === 'true') return true
  return false
}

export function formatState(s: WorkflowState): WorkflowState {
  return {
    ...s,
    is_initial: coerceBool(s.is_initial),
    is_terminal: coerceBool(s.is_terminal),
    lock_record: coerceBool(s.lock_record)
  }
}

export function formatTransition(t: WorkflowTransition) {
  return {
    ...t,
    required_roles: parseJson(t.required_roles) as string[] | null,
    actions: parseJson(t.actions) as unknown[] | null
  }
}

export function evalFilterOp(op: SkipOp, recordVal: unknown, value: unknown): boolean {
  switch (op) {
    case 'eq':
      return recordVal === value
    case 'neq':
      return recordVal !== value
    case 'lt':
      return Number(recordVal) < Number(value)
    case 'lte':
      return Number(recordVal) <= Number(value)
    case 'gt':
      return Number(recordVal) > Number(value)
    case 'gte':
      return Number(recordVal) >= Number(value)
    case 'in':
      return Array.isArray(value) && value.includes(recordVal)
    case 'notin':
      return Array.isArray(value) && !value.includes(recordVal)
    default:
      return false
  }
}

export function dedupeOwners(owners: ResolvedOwner[]): ResolvedOwner[] {
  const seen = new Set<string>()
  const out: ResolvedOwner[] = []
  for (const o of owners) {
    if (seen.has(o.id)) continue
    seen.add(o.id)
    out.push(o)
  }
  return out
}

// ─── Delegation / substitution ──────────────────────────────────────────────

/**
 * Resolve a user's active delegate. When the user is out of office and has a
 * delegate set that has not expired, returns the delegate's id; otherwise the
 * original id. See "Pipeline delegation" gotcha in CLAUDE.md.
 */
export async function resolveActiveDelegate(
  userId: string,
  database: typeof db = db
): Promise<string> {
  const user = await database('nivaro_users')
    .where({ id: userId })
    .select('id', 'delegate_id', 'delegate_expires_at', 'is_out_of_office')
    .first<{
      id: string
      delegate_id: string | null
      delegate_expires_at: Date | null
      is_out_of_office: boolean
    }>()
  if (!user) return userId
  if (
    coerceBool(user.is_out_of_office) &&
    user.delegate_id &&
    (!user.delegate_expires_at || new Date(user.delegate_expires_at) > new Date())
  ) {
    return user.delegate_id
  }
  return userId
}

/**
 * Apply delegation substitution to a resolved owner list. For each owner that
 * is out of office with an active (non-expired) delegate, the delegate's full
 * record replaces the owner. Result is re-deduped.
 */
export async function applyDelegations(
  owners: ResolvedOwner[],
  database: typeof db = db
): Promise<ResolvedOwner[]> {
  if (owners.length === 0) return owners

  const ownerIds = owners.map((o) => o.id)
  const rows = (await database('nivaro_users')
    .whereIn('id', ownerIds)
    .select('id', 'delegate_id', 'delegate_expires_at', 'is_out_of_office')) as Array<{
    id: string
    delegate_id: string | null
    delegate_expires_at: Date | null
    is_out_of_office: boolean
  }>
  const byId = new Map(rows.map((r) => [r.id, r]))

  // Collect delegate ids that will be substituted in.
  const substitutions = new Map<string, string>()
  for (const o of owners) {
    const u = byId.get(o.id)
    if (!u) continue
    if (
      coerceBool(u.is_out_of_office) &&
      u.delegate_id &&
      (!u.delegate_expires_at || new Date(u.delegate_expires_at) > new Date())
    ) {
      substitutions.set(o.id, u.delegate_id)
    }
  }

  if (substitutions.size === 0) return owners

  // Fetch full records for the substituted delegate ids.
  const delegateIds = [...new Set(substitutions.values())]
  const delegateRows = (await database('nivaro_users')
    .whereIn('id', delegateIds)
    .select('id', 'email', 'first_name', 'last_name')) as ResolvedOwner[]
  const delegateById = new Map(delegateRows.map((d) => [d.id, d]))

  const out: ResolvedOwner[] = []
  for (const o of owners) {
    const sub = substitutions.get(o.id)
    if (sub) {
      const delegate = delegateById.get(sub)
      if (delegate) {
        out.push(delegate)
        continue
      }
    }
    out.push(o)
  }
  return dedupeOwners(out)
}

// ─── Owner resolution ─────────────────────────────────────────────────────────

export async function resolveInstanceOwners(
  stateId: string,
  instanceId: string | null,
  database: typeof db = db
): Promise<ResolvedOwner[]> {
  if (!instanceId) return []
  const rows = await database('nivaro_pipeline_instance_owners as io')
    .join('nivaro_users as u', 'io.user', 'u.id')
    .where('io.instance', instanceId)
    .andWhere((qb) => qb.where('io.state', stateId).orWhereNull('io.state'))
    .select('u.id', 'u.email', 'u.first_name', 'u.last_name')
  return rows as ResolvedOwner[]
}

export async function resolveStateOwners(
  stateId: string,
  instanceId: string | null,
  collection: string,
  itemId: string,
  database: typeof db = db
): Promise<ResolvedOwner[]> {
  const groups = await database<OwnerGroup>('nivaro_pipeline_owner_groups')
    .where({ state: stateId })
    .orderBy('sort')
    .orderBy('is_default')

  if (!groups.length) {
    return dedupeOwners(await resolveInstanceOwners(stateId, instanceId, database))
  }

  let record: Record<string, unknown> = {}
  try {
    const row = (await database(collection).where({ id: itemId }).select('*').first()) as
      | Record<string, unknown>
      | undefined
    if (row) record = row
  } catch {
    // Safe fallback for dev tables that may not exist
  }

  const nonDefault = groups.filter((g) => !coerceBool(g.is_default))
  const defaults = groups.filter((g) => coerceBool(g.is_default))

  let relations: Array<{
    many_collection: string
    many_field: string
    one_collection: string | null
  }> = []
  try {
    relations = await database('nivaro_relations')
      .where({ many_collection: collection })
      .select('many_collection', 'many_field', 'one_collection')
  } catch {
    // Non-fatal
  }

  function evalFilter(f: RecordFilter): boolean {
    if (f.id_value != null && f.field.includes('.')) {
      const prefix = f.field.split('.')[0]
      const m2oRel = relations.find((r) => r.many_field === prefix)
      const fkValue = m2oRel ? record[m2oRel.many_field] : null
      return evalFilterOp(f.op, fkValue, f.id_value)
    }
    if (f.id_value != null && !f.field.includes('.')) {
      return evalFilterOp(f.op, record[f.field], f.id_value)
    }
    return evalFilterOp(f.op, record[f.field], f.value)
  }

  const matched: Array<{ group: OwnerGroup; filterCount: number }> = []
  for (const group of nonDefault) {
    const filters = parseJson(group.filters) as RecordFilter[] | null
    if (!filters || filters.length === 0) continue
    if (filters.every((f) => evalFilter(f))) {
      matched.push({ group, filterCount: filters.length })
    }
  }

  let winningGroups: OwnerGroup[] = []
  if (matched.length > 0) {
    matched.sort((a, b) =>
      b.filterCount !== a.filterCount
        ? b.filterCount - a.filterCount
        : (a.group.priority ?? 0) - (b.group.priority ?? 0)
    )
    winningGroups = [matched[0].group]
  }

  if (winningGroups.length === 0) {
    winningGroups = defaults
  }

  const groupIds = winningGroups.map((g) => g.id)
  let baseOwners: ResolvedOwner[] = []
  if (groupIds.length > 0) {
    baseOwners = (await database('nivaro_pipeline_owner_group_users as ogu')
      .join('nivaro_users as u', 'ogu.user', 'u.id')
      .whereIn('ogu.group', groupIds)
      .select('u.id', 'u.email', 'u.first_name', 'u.last_name')) as ResolvedOwner[]
  }

  const instanceOwners = await resolveInstanceOwners(stateId, instanceId, database)
  const resolved = dedupeOwners([...baseOwners, ...instanceOwners])
  return applyDelegations(resolved, database)
}

// ─── Skip criteria / auto-advance ─────────────────────────────────────────────

export async function evaluateSkipCriteria(
  stateId: string,
  record: Record<string, unknown>,
  instanceId: string | null,
  collection: string,
  itemId: string,
  database: typeof db = db
): Promise<boolean> {
  try {
    const state = await database<WorkflowState>('nivaro_workflow_states')
      .where({ id: stateId })
      .first()
    if (!state) return false

    const criteria = parseJson(state.skip_criteria) as SkipCriteria | null
    if (!criteria || !Array.isArray(criteria.conditions) || criteria.conditions.length === 0) {
      return false
    }

    const results: boolean[] = []
    for (const cond of criteria.conditions) {
      if (cond.type === 'no_owners') {
        const owners = await resolveStateOwners(stateId, instanceId, collection, itemId, database)
        results.push(owners.length === 0)
      } else if (cond.type === 'field_compare') {
        results.push(evalFilterOp(cond.op, record[cond.field], cond.value))
      } else if (cond.type === 'field_empty') {
        const v = record[cond.field]
        results.push(v == null || v === '')
      } else if (cond.type === 'field_nonempty') {
        const v = record[cond.field]
        results.push(v != null && v !== '')
      }
    }

    if (criteria.mode === 'any') return results.some(Boolean)
    return results.every(Boolean)
  } catch {
    return false
  }
}

export async function resolveTransitionTarget(
  toStateId: string,
  templateId: string,
  collection: string,
  itemId: string,
  instanceId: string | null,
  database: typeof db = db,
  depth = 0
): Promise<WorkflowState | null> {
  if (depth > 10) return null

  const state = await database<WorkflowState>('nivaro_workflow_states')
    .where({ id: toStateId })
    .first()
  if (!state) return null

  if (coerceBool(state.is_terminal) || coerceBool(state.is_initial)) return state

  let record: Record<string, unknown> = {}
  try {
    const r = await database(collection).where({ id: itemId }).first()
    if (r) record = r as Record<string, unknown>
  } catch {
    record = {}
  }

  const shouldSkip = await evaluateSkipCriteria(
    toStateId,
    record,
    instanceId,
    collection,
    itemId,
    database
  )

  if (!shouldSkip) return state

  const nextTransition = await database<WorkflowTransition>('nivaro_workflow_transitions')
    .where({ template: templateId, from_state: toStateId })
    .whereNot({ to_state: toStateId })
    .orderBy('sort')
    .first()

  if (!nextTransition) return state

  return resolveTransitionTarget(
    nextTransition.to_state,
    templateId,
    collection,
    itemId,
    instanceId,
    database,
    depth + 1
  )
}

// ─── Full instance query helpers ───────────────────────────────────────────────

export async function buildInstancePayload(
  instance: WorkflowInstance,
  userRoleId: string | null | undefined,
  isAdmin: boolean,
  database: typeof db = db
) {
  const [states, allTransitions, history] = await Promise.all([
    database<WorkflowState>('nivaro_workflow_states')
      .where({ template: instance.template })
      .orderBy('sort'),
    database<WorkflowTransition>('nivaro_workflow_transitions')
      .where({ template: instance.template })
      .orderBy('sort'),
    database('nivaro_workflow_history as h')
      .leftJoin('nivaro_users as u', 'h.user', 'u.id')
      .leftJoin('nivaro_workflow_states as fs', 'h.from_state', 'fs.id')
      .leftJoin('nivaro_workflow_states as ts', 'h.to_state', 'ts.id')
      .where('h.instance', instance.id)
      .orderBy('h.timestamp', 'asc')
      .select(
        'h.id',
        'h.transition',
        'h.comment',
        'h.timestamp',
        'u.id as user_id',
        'u.email as user_email',
        'u.first_name as user_first_name',
        'u.last_name as user_last_name',
        'fs.id as from_state_id',
        'fs.key as from_state_key',
        'fs.label as from_state_label',
        'fs.color as from_state_color',
        'fs.is_initial as from_state_is_initial',
        'fs.is_terminal as from_state_is_terminal',
        'fs.lock_record as from_state_lock_record',
        'fs.sort as from_state_sort',
        'ts.id as to_state_id',
        'ts.key as to_state_key',
        'ts.label as to_state_label',
        'ts.color as to_state_color',
        'ts.is_initial as to_state_is_initial',
        'ts.is_terminal as to_state_is_terminal',
        'ts.lock_record as to_state_lock_record',
        'ts.sort as to_state_sort'
      )
  ])

  const currentState = states.find((s) => s.id === instance.current_state)

  const availableTransitions = allTransitions.filter((t) => {
    if (t.from_state !== null && t.from_state !== instance.current_state) return false
    if (isAdmin) return true
    const roles = parseJson(t.required_roles) as string[] | null
    if (!roles || roles.length === 0) return true
    return userRoleId != null && roles.includes(userRoleId)
  })

  const formattedHistory = history.map((h) => ({
    id: h.id,
    transition: h.transition,
    fromState: h.from_state_id
      ? {
          id: h.from_state_id,
          key: h.from_state_key,
          label: h.from_state_label,
          color: h.from_state_color,
          isInitial: coerceBool(h.from_state_is_initial),
          isTerminal: coerceBool(h.from_state_is_terminal),
          lockRecord: coerceBool(h.from_state_lock_record),
          sort: h.from_state_sort ?? 0,
          skipCriteria: null
        }
      : null,
    toState: {
      id: h.to_state_id,
      key: h.to_state_key,
      label: h.to_state_label,
      color: h.to_state_color,
      isInitial: coerceBool(h.to_state_is_initial),
      isTerminal: coerceBool(h.to_state_is_terminal),
      lockRecord: coerceBool(h.to_state_lock_record),
      sort: h.to_state_sort ?? 0,
      skipCriteria: null
    },
    user: h.user_id
      ? {
          id: h.user_id,
          email: h.user_email,
          firstName: h.user_first_name,
          lastName: h.user_last_name
        }
      : null,
    comment: h.comment,
    timestamp: h.timestamp
  }))

  return {
    id: instance.id,
    collection: instance.collection,
    item: instance.item,
    currentState: currentState ? gqlState(currentState) : null,
    startedAt: instance.started_at,
    completedAt: instance.completed_at,
    history: formattedHistory,
    availableTransitions: availableTransitions.map((t) => ({
      id: t.id,
      fromState: t.from_state,
      toState: t.to_state,
      label: t.label,
      color: t.color,
      requiredRoles: parseJson(t.required_roles) as string[] | null,
      actions: parseJson(t.actions) as unknown[] | null,
      sort: t.sort
    }))
  }
}

// ─── GQL shape formatters ─────────────────────────────────────────────────────

export function gqlState(s: WorkflowState) {
  return {
    id: s.id,
    key: s.key,
    label: s.label,
    color: s.color,
    isInitial: coerceBool(s.is_initial),
    isTerminal: coerceBool(s.is_terminal),
    lockRecord: coerceBool(s.lock_record),
    sort: s.sort,
    skipCriteria: parseJson(s.skip_criteria),
    ownerGroups: []
  }
}

export function gqlUser(row: Record<string, unknown>) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    role: row.role,
    status: row.status,
    lastAccess: row.last_access,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}
