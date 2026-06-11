import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

// ─── Types ────────────────────────────────────────────────────────────────────

interface WorkflowTemplate {
  id: string
  name: string
  description: string | null
  color: string | null
  icon: string | null
  created_at: Date
  updated_at: Date
}

interface WorkflowState {
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
  skip_if_no_owners: boolean
  stage_visibility: string
}

interface WorkflowTransition {
  id: string
  template: string
  from_state: string | null
  to_state: string
  label: string
  color: string | null
  required_roles: string | null
  actions: string | null
  sort: number
  group_label: string | null
  condition_rules: string | null
}

interface WorkflowBinding {
  id: number
  template: string
  collection: string
  state_field: string | null
}

interface WorkflowInstance {
  id: string
  template: string
  collection: string
  item: string
  current_state: string | null
  started_at: Date
  completed_at: Date | null
}

interface WorkflowHistory {
  id: number
  instance: string
  transition: string | null
  from_state: string | null
  to_state: string
  user: string | null
  comment: string | null
  timestamp: Date
}

interface OwnerGroup {
  id: string
  template: string
  state: string
  name: string | null
  filters: string | null
  sort: number
  is_default: boolean
  priority: number
}

interface OwnerGroupUser {
  id: number
  group: string
  user: string
}

interface OwnerDimension {
  id: number
  binding: number
  field: string
  label: string
  sort: number
  is_row_axis: boolean
  required: boolean
}

interface InstanceOwner {
  id: number
  instance: string
  state: string | null
  user: string
  added_by: string | null
  added_at: Date
}

type SkipOp = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'notin'

type SkipCondition =
  | { type: 'no_owners' }
  | { type: 'field_compare'; field: string; op: SkipOp; value: unknown }
  | { type: 'field_empty'; field: string }
  | { type: 'field_nonempty'; field: string }

interface SkipCriteria {
  mode: 'any' | 'all'
  conditions: SkipCondition[]
}

interface ResolvedOwner {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
}

interface RecordFilter {
  field: string
  op: SkipOp
  value: unknown
  id_value?: number | null
}

type ConditionOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'null' | 'nnull'

interface ConditionRule {
  field: string
  op: ConditionOp
  value?: unknown
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseJson(val: string | null | undefined): unknown {
  if (!val) return null
  try {
    return JSON.parse(val)
  } catch {
    return null
  }
}

function toJsonStr(val: unknown): string | null {
  if (val === null || val === undefined) return null
  if (typeof val === 'string') return val
  return JSON.stringify(val)
}

function coerceBool(val: unknown): boolean {
  if (typeof val === 'boolean') return val
  if (val === 1 || val === '1' || val === 'true') return true
  return false
}

function formatState(s: WorkflowState) {
  return {
    ...s,
    is_initial: coerceBool(s.is_initial),
    is_terminal: coerceBool(s.is_terminal),
    lock_record: coerceBool(s.lock_record),
    skip_if_no_owners: coerceBool(s.skip_if_no_owners),
    skip_criteria: parseJson(s.skip_criteria),
    stage_visibility: s.stage_visibility ?? 'always'
  }
}

function formatTransition(t: WorkflowTransition) {
  return {
    ...t,
    required_roles: parseJson(t.required_roles) as string[] | null,
    actions: parseJson(t.actions) as unknown[] | null,
    condition_rules: parseJson(t.condition_rules) as ConditionRule[] | null
  }
}

// ─── Transition condition rules (conditional branching) ───────────────────────

function isNumericish(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v)
  if (typeof v === 'boolean') return false
  if (typeof v === 'string' && v.trim() !== '') return Number.isFinite(Number(v))
  return false
}

function evalConditionRule(rule: ConditionRule, record: Record<string, unknown>): boolean {
  const recordVal = record[rule.field]
  switch (rule.op) {
    case 'null':
      return recordVal == null || recordVal === ''
    case 'nnull':
      return recordVal != null && recordVal !== ''
    case 'contains':
      return (
        recordVal != null &&
        String(recordVal)
          .toLowerCase()
          .includes(
            String(rule.value ?? '')
              .toLowerCase()
              .trim()
          )
      )
    case 'eq':
      if (isNumericish(recordVal) && isNumericish(rule.value))
        return Number(recordVal) === Number(rule.value)
      return String(recordVal ?? '') === String(rule.value ?? '')
    case 'neq':
      if (isNumericish(recordVal) && isNumericish(rule.value))
        return Number(recordVal) !== Number(rule.value)
      return String(recordVal ?? '') !== String(rule.value ?? '')
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (isNumericish(recordVal) && isNumericish(rule.value)) {
        const a = Number(recordVal)
        const b = Number(rule.value)
        if (rule.op === 'gt') return a > b
        if (rule.op === 'gte') return a >= b
        if (rule.op === 'lt') return a < b
        return a <= b
      }
      // Lexicographic fallback (e.g. ISO date strings); null never matches ordering ops.
      if (recordVal == null || rule.value == null) return false
      const a = String(recordVal)
      const b = String(rule.value)
      if (rule.op === 'gt') return a > b
      if (rule.op === 'gte') return a >= b
      if (rule.op === 'lt') return a < b
      return a <= b
    }
    default:
      return false
  }
}

// AND semantics over all rules. Null / empty / malformed rules → always true
// (unconditioned transitions behave exactly as before).
function evaluateConditionRules(raw: string | null, record: Record<string, unknown>): boolean {
  const rules = parseJson(raw) as ConditionRule[] | null
  if (!rules || !Array.isArray(rules) || rules.length === 0) return true
  return rules.every((r) => {
    if (!r || typeof r !== 'object' || typeof r.field !== 'string' || !r.field) return true
    return evalConditionRule(r, record)
  })
}

async function fetchRecordForConditions(
  collection: string,
  itemId: string
): Promise<Record<string, unknown>> {
  try {
    const row = (await db(collection).where({ id: itemId }).first()) as
      | Record<string, unknown>
      | undefined
    return row ?? {}
  } catch {
    // Table may not exist in dev; condition rules treat missing fields as null.
    return {}
  }
}

function evalFilterOp(op: SkipOp, recordVal: unknown, value: unknown): boolean {
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

async function resolveInstanceOwners(
  stateId: string,
  instanceId: string | null,
  database: typeof db
): Promise<ResolvedOwner[]> {
  if (!instanceId) return []
  const rows = await database('nivaro_pipeline_instance_owners as io')
    .join('nivaro_users as u', 'io.user', 'u.id')
    .where('io.instance', instanceId)
    .andWhere((qb) => qb.where('io.state', stateId).orWhereNull('io.state'))
    .select('u.id', 'u.email', 'u.first_name', 'u.last_name')
  return rows as ResolvedOwner[]
}

async function resolveStateOwners(
  stateId: string,
  instanceId: string | null,
  collection: string,
  itemId: string,
  database: typeof db
): Promise<ResolvedOwner[]> {
  // 1. Load all owner groups for this state, non-default first.
  const groups = await database<OwnerGroup>('nivaro_pipeline_owner_groups')
    .where({ state: stateId })
    .orderBy('sort')
    .orderBy('is_default')

  if (!groups.length) {
    // No configured groups — fall through to instance owners only.
    return dedupeOwners(await resolveInstanceOwners(stateId, instanceId, database))
  }

  // 2. Fetch the record once for filter evaluation.
  let record: Record<string, unknown> = {}
  try {
    const row = (await database(collection).where({ id: itemId }).select('*').first()) as
      | Record<string, unknown>
      | undefined
    if (row) record = row
  } catch {
    // Table may not exist in dev; safe fallback.
  }

  const nonDefault = groups.filter((g) => !coerceBool(g.is_default))
  const defaults = groups.filter((g) => coerceBool(g.is_default))

  // 3. Pre-fetch relations for this collection once (used for dotted-path id_value resolution).
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
    // Non-fatal: relations table may not be populated
  }

  // Helper: evaluate a single RecordFilter against the fetched record.
  // Uses id_value + relation FK lookup when available; falls back to text comparison.
  function evalFilter(f: RecordFilter): boolean {
    if (f.id_value != null && f.field.includes('.')) {
      // New format: resolve via M2O FK — find relation where many_field = dotted path prefix.
      const prefix = f.field.split('.')[0]
      const m2oRel = relations.find((r) => r.many_field === prefix)
      const fkValue = m2oRel ? record[m2oRel.many_field] : null
      return evalFilterOp(f.op, fkValue, f.id_value)
    }
    if (f.id_value != null && !f.field.includes('.')) {
      // Top-level field with id_value — compare directly.
      return evalFilterOp(f.op, record[f.field], f.id_value)
    }
    // Old format: text comparison (backward compat).
    return evalFilterOp(f.op, record[f.field], f.value)
  }

  // 4. Collect all matching non-default groups, then pick the most specific.
  //    Specificity: filter count DESC (more filters = more specific), then priority ASC (lower = higher priority).
  //    This mirrors getCellResult() in pipeline-owner-matrix.tsx.
  const matched: Array<{ group: OwnerGroup; filterCount: number }> = []
  for (const group of nonDefault) {
    const filters = parseJson(group.filters) as RecordFilter[] | null
    if (!filters || filters.length === 0) continue // no filters = universal = default-level
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

  // 5. Fall back to default groups if no specific match.
  if (winningGroups.length === 0) {
    winningGroups = defaults
  }

  // 6. Collect users from winning groups.
  const groupIds = winningGroups.map((g) => g.id)
  let baseOwners: ResolvedOwner[] = []
  if (groupIds.length > 0) {
    baseOwners = (await database('nivaro_pipeline_owner_group_users as ogu')
      .join('nivaro_users as u', 'ogu.user', 'u.id')
      .whereIn('ogu.group', groupIds)
      .select('u.id', 'u.email', 'u.first_name', 'u.last_name')) as ResolvedOwner[]
  }

  // 6. Merge with instance-level manual owners.
  const instanceOwners = await resolveInstanceOwners(stateId, instanceId, database)
  return dedupeOwners([...baseOwners, ...instanceOwners])
}

function dedupeOwners(owners: ResolvedOwner[]): ResolvedOwner[] {
  const seen = new Set<string>()
  const out: ResolvedOwner[] = []
  for (const o of owners) {
    if (seen.has(o.id)) continue
    seen.add(o.id)
    out.push(o)
  }
  return out
}

async function evaluateSkipCriteria(
  stateId: string,
  record: Record<string, unknown>,
  instanceId: string | null,
  collection: string,
  itemId: string,
  database: typeof db
): Promise<boolean> {
  try {
    const state = await database<WorkflowState>('nivaro_workflow_states')
      .where({ id: stateId })
      .first()
    if (!state) return false

    // Standalone skip-if-no-owners flag: skip the state when no owner groups are
    // configured for it (mirrors the no_owners skip-criteria condition).
    if (coerceBool(state.skip_if_no_owners)) {
      const ownerGroupCount = (await database('nivaro_pipeline_owner_groups')
        .where({ state: stateId })
        .count('id as n')
        .first()) as { n: number | string } | undefined
      if (Number(ownerGroupCount?.n ?? 0) === 0) {
        // Also verify there are no manually-assigned instance owners for this state.
        const owners = await resolveStateOwners(stateId, instanceId, collection, itemId, database)
        if (owners.length === 0) return true
      }
    }

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

async function resolveTransitionTarget(
  toStateId: string,
  templateId: string,
  collection: string,
  itemId: string,
  instanceId: string | null,
  database: typeof db,
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

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function pipelinesRoutes(app: FastifyInstance) {
  // ─── Template CRUD (admin only) ───────────────────────────────────────────

  // List templates with state/transition counts
  app.get('/', { preHandler: requireAdmin }, async (_req, reply) => {
    const templates = await db<WorkflowTemplate>('nivaro_workflow_templates').orderBy(
      'updated_at',
      'desc'
    )

    const stateCounts = await db('nivaro_workflow_states')
      .select('template')
      .count('id as count')
      .groupBy('template')
    const stateCountMap = new Map(stateCounts.map((r) => [r.template as string, Number(r.count)]))

    const bindingRows = await db<WorkflowBinding>('nivaro_workflow_bindings').select(
      'template',
      'collection'
    )
    const bindingsMap = new Map<string, string[]>()
    for (const b of bindingRows) {
      const arr = bindingsMap.get(b.template) ?? []
      arr.push(b.collection)
      bindingsMap.set(b.template, arr)
    }

    const data = templates.map((t) => ({
      ...t,
      state_count: stateCountMap.get(t.id) ?? 0,
      collections: bindingsMap.get(t.id) ?? []
    }))
    return reply.send({ data })
  })

  // Get single template with full detail
  app.get('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const template = await db<WorkflowTemplate>('nivaro_workflow_templates').where({ id }).first()
    if (!template) return reply.code(404).send({ error: 'Not found' })

    const states = await db<WorkflowState>('nivaro_workflow_states')
      .where({ template: id })
      .orderBy('sort')
      .orderBy('label')

    const transitions = await db<WorkflowTransition>('nivaro_workflow_transitions')
      .where({ template: id })
      .orderBy('sort')
      .orderBy('label')

    const bindings = await db<WorkflowBinding>('nivaro_workflow_bindings').where({ template: id })

    const bindingIds = bindings.map((b) => b.id)
    const dimensions = bindingIds.length
      ? await db<OwnerDimension>('nivaro_pipeline_owner_dimensions')
          .whereIn('binding', bindingIds)
          .orderBy('sort')
          .select('*')
      : []
    const dimsByBinding = new Map<number, OwnerDimension[]>()
    for (const d of dimensions) {
      const arr = dimsByBinding.get(d.binding) ?? []
      arr.push({ ...d, is_row_axis: coerceBool(d.is_row_axis), required: coerceBool(d.required) })
      dimsByBinding.set(d.binding, arr)
    }
    const bindingsWithDimensions = bindings.map((b) => ({
      ...b,
      dimensions: dimsByBinding.get(b.id) ?? []
    }))

    return reply.send({
      data: {
        ...template,
        states: states.map(formatState),
        transitions: transitions.map(formatTransition),
        bindings: bindingsWithDimensions
      }
    })
  })

  // Create template
  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as Pick<WorkflowTemplate, 'name' | 'description' | 'color' | 'icon'>
    if (!body.name?.trim()) return reply.code(400).send({ error: 'name is required' })

    const id = randomUUID()
    const now = new Date()
    await db('nivaro_workflow_templates').insert({
      id,
      name: body.name.trim(),
      description: body.description ?? null,
      color: body.color ?? null,
      icon: body.icon ?? null,
      created_at: now,
      updated_at: now
    })
    const template = await db<WorkflowTemplate>('nivaro_workflow_templates').where({ id }).first()
    await logActivity({
      action: 'create',
      collection: 'nivaro_workflow_templates',
      item: id,
      user: req.user?.id,
      req
    })
    return reply
      .code(201)
      .send({ data: { ...template, states: [], transitions: [], bindings: [] } })
  })

  // Update template
  app.patch('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as Partial<WorkflowTemplate>
    const existing = await db<WorkflowTemplate>('nivaro_workflow_templates').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    await db('nivaro_workflow_templates')
      .where({ id })
      .update({
        name: body.name ?? existing.name,
        description: body.description !== undefined ? body.description : existing.description,
        color: body.color !== undefined ? body.color : existing.color,
        icon: body.icon !== undefined ? body.icon : existing.icon,
        updated_at: new Date()
      })
    const updated = await db<WorkflowTemplate>('nivaro_workflow_templates').where({ id }).first()
    await logActivity({
      action: 'update',
      collection: 'nivaro_workflow_templates',
      item: id,
      user: req.user?.id,
      req
    })
    return reply.send({ data: updated })
  })

  // Delete template (cascade removes states, transitions, bindings)
  app.delete('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const deleted = await db('nivaro_workflow_templates').where({ id }).delete()
    if (!deleted) return reply.code(404).send({ error: 'Not found' })
    await logActivity({
      action: 'delete',
      collection: 'nivaro_workflow_templates',
      item: id,
      user: req.user?.id,
      req
    })
    return reply.code(204).send()
  })

  // ─── States ───────────────────────────────────────────────────────────────

  app.post('/:id/states', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const template = await db<WorkflowTemplate>('nivaro_workflow_templates').where({ id }).first()
    if (!template) return reply.code(404).send({ error: 'Template not found' })

    const body = req.body as Pick<
      WorkflowState,
      | 'key'
      | 'label'
      | 'color'
      | 'is_initial'
      | 'is_terminal'
      | 'lock_record'
      | 'sort'
      | 'skip_if_no_owners'
    >
    if (!body.key?.trim()) return reply.code(400).send({ error: 'key is required' })
    if (!body.label?.trim()) return reply.code(400).send({ error: 'label is required' })

    const stateId = randomUUID()
    await db('nivaro_workflow_states').insert({
      id: stateId,
      template: id,
      key: body.key.trim(),
      label: body.label.trim(),
      color: body.color ?? null,
      is_initial: body.is_initial ? 1 : 0,
      is_terminal: body.is_terminal ? 1 : 0,
      lock_record: body.lock_record ? 1 : 0,
      skip_if_no_owners: body.skip_if_no_owners ? 1 : 0,
      stage_visibility: body.stage_visibility ?? 'always',
      sort: body.sort ?? 0
    })
    const state = await db<WorkflowState>('nivaro_workflow_states').where({ id: stateId }).first()
    await logActivity({
      action: 'create',
      collection: 'nivaro_workflow_states',
      item: stateId,
      user: req.user?.id,
      req,
      comment: `template:${id}`
    })
    return reply.code(201).send({ data: state ? formatState(state) : state })
  })

  app.patch('/states/:stateId', { preHandler: requireAdmin }, async (req, reply) => {
    const { stateId } = req.params as { stateId: string }
    const state = await db<WorkflowState>('nivaro_workflow_states').where({ id: stateId }).first()
    if (!state) return reply.code(404).send({ error: 'Not found' })

    const body = req.body as Partial<WorkflowState>
    await db('nivaro_workflow_states')
      .where({ id: stateId })
      .update({
        key: body.key?.trim() ?? state.key,
        label: body.label?.trim() ?? state.label,
        color: body.color !== undefined ? body.color : state.color,
        is_initial: body.is_initial !== undefined ? (body.is_initial ? 1 : 0) : state.is_initial,
        is_terminal:
          body.is_terminal !== undefined ? (body.is_terminal ? 1 : 0) : state.is_terminal,
        lock_record:
          body.lock_record !== undefined ? (body.lock_record ? 1 : 0) : state.lock_record,
        skip_if_no_owners:
          body.skip_if_no_owners !== undefined
            ? body.skip_if_no_owners
              ? 1
              : 0
            : state.skip_if_no_owners,
        stage_visibility: body.stage_visibility ?? state.stage_visibility ?? 'always',
        sort: body.sort ?? state.sort
      })
    const updated = await db<WorkflowState>('nivaro_workflow_states').where({ id: stateId }).first()
    await logActivity({
      action: 'update',
      collection: 'nivaro_workflow_states',
      item: stateId,
      user: req.user?.id,
      req
    })
    return reply.send({ data: updated ? formatState(updated) : updated })
  })

  app.delete('/states/:stateId', { preHandler: requireAdmin }, async (req, reply) => {
    const { stateId } = req.params as { stateId: string }
    const deleted = await db('nivaro_workflow_states').where({ id: stateId }).delete()
    if (!deleted) return reply.code(404).send({ error: 'Not found' })
    await logActivity({
      action: 'delete',
      collection: 'nivaro_workflow_states',
      item: stateId,
      user: req.user?.id,
      req
    })
    return reply.code(204).send()
  })

  // ─── Transitions ──────────────────────────────────────────────────────────

  app.post('/:id/transitions', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const template = await db<WorkflowTemplate>('nivaro_workflow_templates').where({ id }).first()
    if (!template) return reply.code(404).send({ error: 'Template not found' })

    const body = req.body as Pick<
      WorkflowTransition,
      | 'from_state'
      | 'to_state'
      | 'label'
      | 'color'
      | 'required_roles'
      | 'actions'
      | 'sort'
      | 'group_label'
      | 'condition_rules'
    >
    if (!body.to_state) return reply.code(400).send({ error: 'to_state is required' })
    if (!body.label?.trim()) return reply.code(400).send({ error: 'label is required' })

    const txId = randomUUID()
    await db('nivaro_workflow_transitions').insert({
      id: txId,
      template: id,
      from_state: body.from_state ?? null,
      to_state: body.to_state,
      label: body.label.trim(),
      color: body.color ?? null,
      required_roles: toJsonStr(body.required_roles),
      actions: toJsonStr(body.actions),
      sort: body.sort ?? 0,
      group_label: body.group_label?.trim() || null,
      condition_rules: toJsonStr(body.condition_rules)
    })
    const tx = await db<WorkflowTransition>('nivaro_workflow_transitions')
      .where({ id: txId })
      .first()
    await logActivity({
      action: 'create',
      collection: 'nivaro_workflow_transitions',
      item: txId,
      user: req.user?.id,
      req,
      comment: `template:${id}`
    })
    return reply.code(201).send({ data: tx ? formatTransition(tx) : tx })
  })

  app.patch('/transitions/:txId', { preHandler: requireAdmin }, async (req, reply) => {
    const { txId } = req.params as { txId: string }
    const tx = await db<WorkflowTransition>('nivaro_workflow_transitions')
      .where({ id: txId })
      .first()
    if (!tx) return reply.code(404).send({ error: 'Not found' })

    const body = req.body as Partial<WorkflowTransition>
    await db('nivaro_workflow_transitions')
      .where({ id: txId })
      .update({
        from_state: body.from_state !== undefined ? (body.from_state ?? null) : tx.from_state,
        to_state: body.to_state ?? tx.to_state,
        label: body.label?.trim() ?? tx.label,
        color: body.color !== undefined ? body.color : tx.color,
        required_roles:
          body.required_roles !== undefined ? toJsonStr(body.required_roles) : tx.required_roles,
        actions: body.actions !== undefined ? toJsonStr(body.actions) : tx.actions,
        sort: body.sort ?? tx.sort,
        group_label:
          body.group_label !== undefined ? body.group_label?.trim() || null : tx.group_label,
        condition_rules:
          body.condition_rules !== undefined ? toJsonStr(body.condition_rules) : tx.condition_rules
      })
    const updated = await db<WorkflowTransition>('nivaro_workflow_transitions')
      .where({ id: txId })
      .first()
    await logActivity({
      action: 'update',
      collection: 'nivaro_workflow_transitions',
      item: txId,
      user: req.user?.id,
      req
    })
    return reply.send({ data: updated ? formatTransition(updated) : updated })
  })

  app.delete('/transitions/:txId', { preHandler: requireAdmin }, async (req, reply) => {
    const { txId } = req.params as { txId: string }
    const deleted = await db('nivaro_workflow_transitions').where({ id: txId }).delete()
    if (!deleted) return reply.code(404).send({ error: 'Not found' })
    await logActivity({
      action: 'delete',
      collection: 'nivaro_workflow_transitions',
      item: txId,
      user: req.user?.id,
      req
    })
    return reply.code(204).send()
  })

  // ─── Bindings ─────────────────────────────────────────────────────────────

  app.post('/:id/bind', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const template = await db<WorkflowTemplate>('nivaro_workflow_templates').where({ id }).first()
    if (!template) return reply.code(404).send({ error: 'Template not found' })

    const body = req.body as { collection: string; state_field?: string }
    if (!body.collection?.trim()) return reply.code(400).send({ error: 'collection is required' })

    // Upsert: update if binding for this collection already exists
    const existing = await db<WorkflowBinding>('nivaro_workflow_bindings')
      .where({ collection: body.collection })
      .first()

    if (existing) {
      await db('nivaro_workflow_bindings')
        .where({ id: existing.id })
        .update({
          template: id,
          state_field: body.state_field ?? existing.state_field
        })
    } else {
      await db('nivaro_workflow_bindings').insert({
        template: id,
        collection: body.collection.trim(),
        state_field: body.state_field ?? null
      })
    }
    const binding = await db<WorkflowBinding>('nivaro_workflow_bindings')
      .where({ collection: body.collection })
      .first()
    await logActivity({
      action: 'create',
      collection: 'nivaro_workflow_bindings',
      item: String(binding?.id ?? ''),
      user: req.user?.id,
      req,
      comment: `template:${id}`
    })
    return reply.code(201).send({ data: binding })
  })

  app.delete('/bindings/:bindingId', { preHandler: requireAdmin }, async (req, reply) => {
    const { bindingId } = req.params as { bindingId: string }
    const deleted = await db('nivaro_workflow_bindings').where({ id: bindingId }).delete()
    if (!deleted) return reply.code(404).send({ error: 'Not found' })
    await logActivity({
      action: 'delete',
      collection: 'nivaro_workflow_bindings',
      item: bindingId,
      user: req.user?.id,
      req
    })
    return reply.code(204).send()
  })

  // ─── Instance endpoints (authenticated, not admin-only) ───────────────────

  // Get pipeline state for a specific item
  app.get('/instance/:collection/:item', { preHandler: requireAuth }, async (req, reply) => {
    const { collection, item } = req.params as { collection: string; item: string }

    const binding = await db<WorkflowBinding>('nivaro_workflow_bindings')
      .where({ collection })
      .first()
    if (!binding) return reply.send({ data: null })

    const instance = await db<WorkflowInstance>('nivaro_workflow_instances')
      .where({ collection, item })
      .first()
    if (!instance)
      return reply.send({
        data: { instance: null, states: [], available_transitions: [], history: [], binding }
      })

    const states = await db<WorkflowState>('nivaro_workflow_states')
      .where({ template: binding.template })
      .orderBy('sort')

    const transitions = await db<WorkflowTransition>('nivaro_workflow_transitions')
      .where({ template: binding.template })
      .orderBy('sort')

    // Filter available transitions for this user
    const currentState = instance.current_state
    const userRole = req.user?.role ?? null
    const isAdmin = req.isAdmin ?? false

    // Load the bound item row once when any transition carries condition rules,
    // so conditional branching can filter the offered transitions.
    const hasConditionRules = transitions.some((tx) => tx.condition_rules)
    const conditionRecord = hasConditionRules
      ? await fetchRecordForConditions(collection, item)
      : {}

    const availableTransitions = transitions
      .filter((tx) => {
        // Transition applies if from_state is null (any) or matches current state
        const fromOk = tx.from_state === null || tx.from_state === currentState
        if (!fromOk) return false
        // Conditional branching: hide transitions whose condition rules don't match the record
        if (tx.condition_rules && !evaluateConditionRules(tx.condition_rules, conditionRecord)) {
          return false
        }
        // Check role requirement
        if (!tx.required_roles) return true
        if (isAdmin) return true
        const roles = parseJson(tx.required_roles) as string[] | null
        if (!roles || roles.length === 0) return true
        return userRole !== null && roles.includes(userRole)
      })
      .map(formatTransition)

    // Get history with joined state labels
    const history = await db('nivaro_workflow_history as h')
      .leftJoin('nivaro_workflow_states as fs', 'h.from_state', 'fs.id')
      .leftJoin('nivaro_workflow_states as ts', 'h.to_state', 'ts.id')
      .leftJoin('nivaro_users as u', 'h.user', 'u.id')
      .where('h.instance', instance.id)
      .orderBy('h.timestamp', 'desc')
      .select(
        'h.id',
        'h.transition',
        'h.from_state',
        'h.to_state',
        'h.comment',
        'h.timestamp',
        'fs.label as from_state_label',
        'fs.color as from_state_color',
        'ts.label as to_state_label',
        'ts.color as to_state_color',
        'u.first_name',
        'u.last_name',
        'u.email as user_email'
      )

    const currentStateObj = states.find((s) => s.id === currentState)

    return reply.send({
      data: {
        instance: {
          ...instance,
          current_state_obj: currentStateObj ? formatState(currentStateObj) : null
        },
        states: states.map(formatState),
        available_transitions: availableTransitions,
        all_transitions: transitions.map(formatTransition),
        history,
        binding
      }
    })
  })

  // Start pipeline instance for an item
  app.post('/instance/:collection/:item/start', { preHandler: requireAuth }, async (req, reply) => {
    const { collection, item } = req.params as { collection: string; item: string }

    const binding = await db<WorkflowBinding>('nivaro_workflow_bindings')
      .where({ collection })
      .first()
    if (!binding) return reply.code(400).send({ error: 'No pipeline bound to this collection' })

    const existing = await db<WorkflowInstance>('nivaro_workflow_instances')
      .where({ collection, item })
      .first()
    if (existing) return reply.code(409).send({ error: 'Pipeline already started for this item' })

    // Find the initial state
    const initialState = await db<WorkflowState>('nivaro_workflow_states')
      .where({ template: binding.template, is_initial: true })
      .first()

    const instanceId = randomUUID()
    await db('nivaro_workflow_instances').insert({
      id: instanceId,
      template: binding.template,
      collection,
      item,
      current_state: initialState?.id ?? null,
      started_at: new Date(),
      completed_at: null
    })

    // Resolve skip criteria — may advance past initial state
    let finalState = initialState
    if (initialState) {
      const resolvedState = await resolveTransitionTarget(
        initialState.id,
        binding.template,
        collection,
        item,
        instanceId,
        db
      )
      const finalStateId = resolvedState?.id ?? initialState.id
      if (finalStateId !== initialState.id) {
        finalState = resolvedState ?? initialState
        await db('nivaro_workflow_instances')
          .where({ id: instanceId })
          .update({
            current_state: finalStateId,
            completed_at: resolvedState && coerceBool(resolvedState.is_terminal) ? new Date() : null
          })
        await db('nivaro_workflow_history').insert({
          instance: instanceId,
          transition: null,
          from_state: initialState.id,
          to_state: finalStateId,
          user: req.user?.id ?? null,
          comment: 'Auto-advanced via skip criteria',
          timestamp: new Date()
        })
      }
    }

    // Write resolved state to state_field if configured
    if (finalState && binding.state_field) {
      try {
        await db(collection)
          .where({ id: item })
          .update({ [binding.state_field]: finalState.key })
      } catch {
        // Collection may not have the field — non-fatal
      }
    }

    const instance = await db<WorkflowInstance>('nivaro_workflow_instances')
      .where({ id: instanceId })
      .first()
    await logActivity({
      action: 'pipeline-start',
      collection,
      item,
      user: req.user?.id,
      req,
      comment: `Started pipeline${finalState ? ` — initial state: ${finalState.label}` : ''}`
    })
    return reply.code(201).send({ data: instance })
  })

  // Execute a transition
  app.post(
    '/instance/:collection/:item/transition',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, item } = req.params as { collection: string; item: string }
      const body = req.body as { transition_id: string; comment?: string }

      if (!body.transition_id) return reply.code(400).send({ error: 'transition_id is required' })

      const instance = await db<WorkflowInstance>('nivaro_workflow_instances')
        .where({ collection, item })
        .first()
      if (!instance) return reply.code(404).send({ error: 'No pipeline instance for this item' })

      if (instance.completed_at) {
        return reply.code(400).send({ error: 'Pipeline is already completed' })
      }

      const transition = await db<WorkflowTransition>('nivaro_workflow_transitions')
        .where({ id: body.transition_id, template: instance.template })
        .first()
      if (!transition) return reply.code(404).send({ error: 'Transition not found' })

      // Validate the transition is valid from current state
      const fromOk =
        transition.from_state === null || transition.from_state === instance.current_state
      if (!fromOk) {
        return reply.code(400).send({ error: 'Transition is not valid from the current state' })
      }

      // Check role permission
      const isAdmin = req.isAdmin ?? false
      if (!isAdmin && transition.required_roles) {
        const roles = parseJson(transition.required_roles) as string[] | null
        if (roles && roles.length > 0) {
          const userRole = req.user?.role ?? null
          if (!userRole || !roles.includes(userRole)) {
            return reply.code(403).send({ error: 'You do not have permission for this transition' })
          }
        }
      }

      // Conditional branching guard: re-fetch the item and revalidate condition
      // rules server-side — the client's view may be stale.
      if (transition.condition_rules) {
        const conditionRecord = await fetchRecordForConditions(collection, item)
        if (!evaluateConditionRules(transition.condition_rules, conditionRecord)) {
          return reply.code(409).send({ error: 'Transition conditions not met' })
        }
      }

      const previousState = instance.current_state

      // Resolve skip criteria — may advance past the nominal target state
      const resolvedTarget = await resolveTransitionTarget(
        transition.to_state,
        instance.template,
        collection,
        item,
        instance.id,
        db
      )
      const newState = resolvedTarget?.id ?? transition.to_state

      // Find new state object
      const newStateObj =
        resolvedTarget ??
        (await db<WorkflowState>('nivaro_workflow_states').where({ id: newState }).first())

      // Update instance
      await db('nivaro_workflow_instances')
        .where({ id: instance.id })
        .update({
          current_state: newState,
          completed_at: newStateObj && coerceBool(newStateObj.is_terminal) ? new Date() : null
        })

      // Write history
      await db('nivaro_workflow_history').insert({
        instance: instance.id,
        transition: transition.id,
        from_state: previousState,
        to_state: newState,
        user: req.user?.id ?? null,
        comment: body.comment ?? null,
        timestamp: new Date()
      })

      // Sync state_field on the record if configured
      const binding = await db<WorkflowBinding>('nivaro_workflow_bindings')
        .where({ collection })
        .first()
      if (binding?.state_field && newStateObj) {
        try {
          await db(collection)
            .where({ id: item })
            .update({ [binding.state_field]: newStateObj.key })
        } catch {
          // Non-fatal: field may not exist on this collection
        }
      }

      const updatedInstance = await db<WorkflowInstance>('nivaro_workflow_instances')
        .where({ id: instance.id })
        .first()

      const prevStateObj = previousState
        ? await db<WorkflowState>('nivaro_workflow_states').where({ id: previousState }).first()
        : null
      const fromLabel = prevStateObj?.label ?? previousState ?? 'Start'
      const toLabel = newStateObj?.label ?? newState
      const transitionLabel = transition.label
      const userComment = body.comment ? ` — "${body.comment}"` : ''

      await logActivity({
        action: 'pipeline-transition',
        collection,
        item,
        user: req.user?.id,
        req,
        comment: `${fromLabel} → ${toLabel} via ${transitionLabel}${userComment}`
      })
      return reply.send({
        data: {
          instance: updatedInstance,
          new_state: newStateObj ? formatState(newStateObj) : null
        }
      })
    }
  )

  // Batch state lookup — all instances for a collection (for collection browser table)
  app.get('/instances/:collection', { preHandler: requireAuth }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const binding = await db<WorkflowBinding>('nivaro_workflow_bindings')
      .where({ collection })
      .first()
    if (!binding) return reply.send({ data: null })

    const rows = await db('nivaro_workflow_instances as i')
      .leftJoin('nivaro_workflow_states as s', 'i.current_state', 's.id')
      .where('i.collection', collection)
      .select(
        'i.item',
        's.key as state_key',
        's.label as state_label',
        's.color as state_color',
        'i.completed_at'
      )

    const byItem: Record<
      string,
      {
        state_key: string | null
        state_label: string | null
        state_color: string | null
        completed_at: Date | null
      }
    > = {}
    for (const r of rows)
      byItem[r.item as string] = {
        state_key: r.state_key as string | null,
        state_label: r.state_label as string | null,
        state_color: r.state_color as string | null,
        completed_at: r.completed_at as Date | null
      }

    return reply.send({ data: { binding, instances: byItem } })
  })

  // List all bindings (for collection browser / admin use)
  app.get('/bindings', { preHandler: requireAdmin }, async (_req, reply) => {
    const bindings = await db<WorkflowBinding>('nivaro_workflow_bindings').select('*')
    return reply.send({ data: bindings })
  })

  // ─── Owner groups (admin only) ────────────────────────────────────────────

  app.get('/states/:stateId/owner-groups', { preHandler: requireAdmin }, async (req, reply) => {
    const { stateId } = req.params as { stateId: string }

    const groups = await db<OwnerGroup>('nivaro_pipeline_owner_groups')
      .where({ state: stateId })
      .orderBy('sort')
      .orderBy('is_default')

    const groupIds = groups.map((g) => g.id)
    const userRows = groupIds.length
      ? ((await db('nivaro_pipeline_owner_group_users as ogu')
          .join('nivaro_users as u', 'ogu.user', 'u.id')
          .whereIn('ogu.group', groupIds)
          .select(
            'ogu.id as link_id',
            'ogu.group',
            'u.id',
            'u.email',
            'u.first_name',
            'u.last_name'
          )) as Array<ResolvedOwner & { link_id: number; group: string }>)
      : []

    const usersByGroup = new Map<string, Array<ResolvedOwner & { link_id: number }>>()
    for (const r of userRows) {
      const arr = usersByGroup.get(r.group) ?? []
      arr.push({
        link_id: r.link_id,
        id: r.id,
        email: r.email,
        first_name: r.first_name,
        last_name: r.last_name
      })
      usersByGroup.set(r.group, arr)
    }

    const data = groups.map((g) => ({
      ...g,
      is_default: coerceBool(g.is_default),
      filters: parseJson(g.filters),
      users: usersByGroup.get(g.id) ?? []
    }))
    return reply.send({ data })
  })

  // Batch: all owner groups for all states in a template, keyed by state id.
  app.get('/:id/owner-groups', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const template = await db('nivaro_workflow_templates').where({ id }).first()
    if (!template) return reply.code(404).send({ error: 'Not found' })

    const states = await db('nivaro_workflow_states').where({ template: id }).select('id')
    const stateIds = states.map((s: { id: string }) => s.id as string)

    if (!stateIds.length) return reply.send({ data: {} })

    const groups = await db<OwnerGroup>('nivaro_pipeline_owner_groups as og')
      .whereIn('og.state', stateIds)
      .orderBy('og.state')
      .orderBy('og.sort')
      .orderBy('og.id')
      .select('og.*')

    const groupIds = groups.map((g) => g.id)
    const groupUsers = groupIds.length
      ? await db('nivaro_pipeline_owner_group_users as ogu')
          .join('nivaro_users as u', 'ogu.user', 'u.id')
          .whereIn('ogu.group', groupIds)
          .select(
            'ogu.id as link_id',
            'ogu.group',
            'u.id',
            'u.email',
            'u.first_name',
            'u.last_name'
          )
      : []

    const usersByGroup = new Map<string, typeof groupUsers>()
    for (const u of groupUsers) {
      const arr = usersByGroup.get(u.group as string) ?? []
      arr.push(u)
      usersByGroup.set(u.group as string, arr)
    }

    const result: Record<string, unknown[]> = {}
    for (const g of groups) {
      const stateKey = g.state as string
      if (!result[stateKey]) result[stateKey] = []
      result[stateKey].push({
        ...g,
        is_default: coerceBool(g.is_default),
        filters: parseJson(g.filters as string),
        users: usersByGroup.get(g.id) ?? []
      })
    }

    return reply.send({ data: result })
  })

  app.post('/states/:stateId/owner-groups', { preHandler: requireAdmin }, async (req, reply) => {
    const { stateId } = req.params as { stateId: string }
    const state = await db<WorkflowState>('nivaro_workflow_states').where({ id: stateId }).first()
    if (!state) return reply.code(404).send({ error: 'State not found' })

    const body = req.body as {
      name?: string | null
      filters?: RecordFilter[] | null
      is_default?: boolean
      sort?: number
      priority?: number
    }

    const id = randomUUID()
    await db('nivaro_pipeline_owner_groups').insert({
      id,
      template: state.template,
      state: stateId,
      name: body.name ?? null,
      filters: toJsonStr(body.filters),
      is_default: body.is_default ? 1 : 0,
      sort: body.sort ?? 0,
      priority: body.priority ?? 0
    })

    const group = await db<OwnerGroup>('nivaro_pipeline_owner_groups').where({ id }).first()
    await logActivity({
      action: 'create',
      collection: 'nivaro_pipeline_owner_groups',
      item: id,
      user: req.user?.id,
      req,
      comment: `state:${stateId}`
    })
    return reply.code(201).send({
      data: group
        ? { ...group, is_default: coerceBool(group.is_default), filters: parseJson(group.filters) }
        : group
    })
  })

  app.patch('/owner-groups/:groupId', { preHandler: requireAdmin }, async (req, reply) => {
    const { groupId } = req.params as { groupId: string }
    const existing = await db<OwnerGroup>('nivaro_pipeline_owner_groups')
      .where({ id: groupId })
      .first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const body = req.body as {
      name?: string | null
      filters?: RecordFilter[] | null
      is_default?: boolean
      sort?: number
      priority?: number
    }
    await db('nivaro_pipeline_owner_groups')
      .where({ id: groupId })
      .update({
        name: body.name !== undefined ? body.name : existing.name,
        filters: body.filters !== undefined ? toJsonStr(body.filters) : existing.filters,
        is_default: body.is_default !== undefined ? (body.is_default ? 1 : 0) : existing.is_default,
        sort: body.sort ?? existing.sort,
        priority: body.priority !== undefined ? body.priority : existing.priority
      })

    const group = await db<OwnerGroup>('nivaro_pipeline_owner_groups')
      .where({ id: groupId })
      .first()
    await logActivity({
      action: 'update',
      collection: 'nivaro_pipeline_owner_groups',
      item: groupId,
      user: req.user?.id,
      req
    })
    return reply.send({
      data: group
        ? { ...group, is_default: coerceBool(group.is_default), filters: parseJson(group.filters) }
        : group
    })
  })

  app.delete('/owner-groups/:groupId', { preHandler: requireAdmin }, async (req, reply) => {
    const { groupId } = req.params as { groupId: string }
    const deleted = await db('nivaro_pipeline_owner_groups').where({ id: groupId }).delete()
    if (!deleted) return reply.code(404).send({ error: 'Not found' })
    await logActivity({
      action: 'delete',
      collection: 'nivaro_pipeline_owner_groups',
      item: groupId,
      user: req.user?.id,
      req
    })
    return reply.send({ success: true })
  })

  app.post('/owner-groups/:groupId/users', { preHandler: requireAdmin }, async (req, reply) => {
    const { groupId } = req.params as { groupId: string }
    const body = req.body as { user: string }
    if (!body.user) return reply.code(400).send({ error: 'user is required' })

    const group = await db<OwnerGroup>('nivaro_pipeline_owner_groups')
      .where({ id: groupId })
      .first()
    if (!group) return reply.code(404).send({ error: 'Owner group not found' })

    const user = await db('nivaro_users').where({ id: body.user }).first()
    if (!user) return reply.code(400).send({ error: 'User not found' })

    // Ignore duplicate (group, user) — return the existing/new link either way.
    const existing = await db<OwnerGroupUser>('nivaro_pipeline_owner_group_users')
      .where({ group: groupId, user: body.user })
      .first()
    let linkId: number
    if (existing) {
      linkId = existing.id
    } else {
      try {
        const [insertedId] = await db('nivaro_pipeline_owner_group_users')
          .insert({ group: groupId, user: body.user })
          .returning('id')
        linkId = typeof insertedId === 'object' ? insertedId.id : insertedId
      } catch {
        const row = await db<OwnerGroupUser>('nivaro_pipeline_owner_group_users')
          .where({ group: groupId, user: body.user })
          .first()
        if (!row) return reply.code(400).send({ error: 'Could not add user' })
        linkId = row.id
      }
    }

    await logActivity({
      action: 'create',
      collection: 'nivaro_pipeline_owner_group_users',
      item: String(linkId),
      user: req.user?.id,
      req,
      comment: `group:${groupId}`
    })
    return reply.code(201).send({
      data: {
        id: linkId,
        group: groupId,
        user: body.user,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name
      }
    })
  })

  app.delete('/owner-group-users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const deleted = await db('nivaro_pipeline_owner_group_users').where({ id }).delete()
    if (!deleted) return reply.code(404).send({ error: 'Not found' })
    await logActivity({
      action: 'delete',
      collection: 'nivaro_pipeline_owner_group_users',
      item: id,
      user: req.user?.id,
      req
    })
    return reply.send({ success: true })
  })

  // ─── Owner dimensions (admin only) ────────────────────────────────────────

  app.get('/bindings/:bindingId/dimensions', { preHandler: requireAdmin }, async (req, reply) => {
    const { bindingId } = req.params as { bindingId: string }
    const dims = await db<OwnerDimension>('nivaro_pipeline_owner_dimensions')
      .where({ binding: bindingId })
      .orderBy('sort')
    const data = dims.map((d) => ({ ...d, is_row_axis: coerceBool(d.is_row_axis) }))
    return reply.send({ data })
  })

  app.post('/bindings/:bindingId/dimensions', { preHandler: requireAdmin }, async (req, reply) => {
    const { bindingId } = req.params as { bindingId: string }
    const binding = await db<WorkflowBinding>('nivaro_workflow_bindings')
      .where({ id: bindingId })
      .first()
    if (!binding) return reply.code(404).send({ error: 'Binding not found' })

    const body = req.body as {
      field: string
      label: string
      sort?: number
      is_row_axis?: boolean
      required?: boolean
    }
    if (!body.field?.trim()) return reply.code(400).send({ error: 'field is required' })
    if (!body.label?.trim()) return reply.code(400).send({ error: 'label is required' })

    if (body.is_row_axis) {
      await db('nivaro_pipeline_owner_dimensions')
        .where({ binding: Number(bindingId) })
        .update({ is_row_axis: 0 })
    }

    const [insertedId] = await db('nivaro_pipeline_owner_dimensions')
      .insert({
        binding: Number(bindingId),
        field: body.field.trim(),
        label: body.label.trim(),
        sort: body.sort ?? 0,
        is_row_axis: body.is_row_axis ? 1 : 0,
        required: body.required ? 1 : 0
      })
      .returning('id')
    const id = typeof insertedId === 'object' ? insertedId.id : insertedId

    const row = await db<OwnerDimension>('nivaro_pipeline_owner_dimensions').where({ id }).first()
    await logActivity({
      action: 'create',
      collection: 'nivaro_pipeline_owner_dimensions',
      item: String(id),
      user: req.user?.id,
      req,
      comment: `binding:${bindingId}`
    })
    return reply.code(201).send({
      data: row
        ? { ...row, is_row_axis: coerceBool(row.is_row_axis), required: coerceBool(row.required) }
        : row
    })
  })

  app.patch('/dimensions/:dimId', { preHandler: requireAdmin }, async (req, reply) => {
    const { dimId } = req.params as { dimId: string }
    const existing = await db<OwnerDimension>('nivaro_pipeline_owner_dimensions')
      .where({ id: dimId })
      .first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const body = req.body as {
      field?: string
      label?: string
      sort?: number
      is_row_axis?: boolean
      required?: boolean
    }
    if (body.is_row_axis === true) {
      await db('nivaro_pipeline_owner_dimensions')
        .where({ binding: existing.binding })
        .whereNot({ id: dimId })
        .update({ is_row_axis: 0 })
    }
    await db('nivaro_pipeline_owner_dimensions')
      .where({ id: dimId })
      .update({
        field: body.field?.trim() ?? existing.field,
        label: body.label?.trim() ?? existing.label,
        sort: body.sort ?? existing.sort,
        is_row_axis:
          body.is_row_axis !== undefined ? (body.is_row_axis ? 1 : 0) : existing.is_row_axis,
        required: body.required !== undefined ? (body.required ? 1 : 0) : existing.required
      })

    const row = await db<OwnerDimension>('nivaro_pipeline_owner_dimensions')
      .where({ id: dimId })
      .first()
    await logActivity({
      action: 'update',
      collection: 'nivaro_pipeline_owner_dimensions',
      item: dimId,
      user: req.user?.id,
      req
    })
    return reply.send({
      data: row
        ? { ...row, is_row_axis: coerceBool(row.is_row_axis), required: coerceBool(row.required) }
        : row
    })
  })

  app.delete('/dimensions/:dimId', { preHandler: requireAdmin }, async (req, reply) => {
    const { dimId } = req.params as { dimId: string }
    const deleted = await db('nivaro_pipeline_owner_dimensions').where({ id: dimId }).delete()
    if (!deleted) return reply.code(404).send({ error: 'Not found' })
    await logActivity({
      action: 'delete',
      collection: 'nivaro_pipeline_owner_dimensions',
      item: dimId,
      user: req.user?.id,
      req
    })
    return reply.send({ success: true })
  })

  // ─── Instance owners (authenticated) ──────────────────────────────────────

  app.get('/instance/:collection/:item/owners', { preHandler: requireAuth }, async (req, reply) => {
    const { collection, item } = req.params as { collection: string; item: string }

    const instance = await db<WorkflowInstance>('nivaro_workflow_instances')
      .where({ collection, item })
      .first()
    if (!instance) return reply.send({ data: [] })

    // Return the raw manually-assigned instance owners so the UI has io.id for deletion.
    const owners = await db('nivaro_pipeline_instance_owners as io')
      .join('nivaro_users as u', 'io.user', 'u.id')
      .where('io.instance', instance.id)
      .select(
        'io.id',
        'io.instance',
        'io.state',
        'io.user',
        'io.added_by',
        'io.added_at',
        'u.first_name',
        'u.last_name',
        'u.email'
      )
    return reply.send({ data: owners })
  })

  app.post(
    '/instance/:collection/:item/owners',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, item } = req.params as { collection: string; item: string }
      const body = req.body as { user: string; state?: string | null }
      if (!body.user) return reply.code(400).send({ error: 'user is required' })

      const instance = await db<WorkflowInstance>('nivaro_workflow_instances')
        .where({ collection, item })
        .first()
      if (!instance) return reply.code(404).send({ error: 'No pipeline instance for this item' })

      // Authorization: caller must be admin or have update permission on this collection.
      // Non-admins may only add themselves or must already be an owner of the instance.
      if (!req.isAdmin) {
        const callerIsOwner = await db('nivaro_pipeline_instance_owners')
          .where({ instance: instance.id, user: req.user!.id })
          .first()
        const callerIsCurrentUser = body.user === req.user!.id
        if (!callerIsOwner && !callerIsCurrentUser) {
          return reply.code(403).send({ error: 'Forbidden' })
        }
      }

      // Validate target user exists.
      const targetUser = await db('nivaro_users').where({ id: body.user }).first()
      if (!targetUser) return reply.code(400).send({ error: 'User not found' })

      // Validate state belongs to this instance's template (if provided).
      if (body.state) {
        const stateRow = await db('nivaro_workflow_states')
          .where({ id: body.state, template: instance.template })
          .first()
        if (!stateRow)
          return reply.code(400).send({ error: 'State does not belong to this pipeline' })
      }

      const newOwner: Omit<InstanceOwner, 'id'> = {
        instance: instance.id,
        state: body.state ?? null,
        user: body.user,
        added_by: req.user?.id ?? null,
        added_at: new Date()
      }
      const [insertedId] = await db('nivaro_pipeline_instance_owners')
        .insert(newOwner)
        .returning('id')
      const id = typeof insertedId === 'object' ? insertedId.id : insertedId

      const row = await db('nivaro_pipeline_instance_owners as io')
        .join('nivaro_users as u', 'io.user', 'u.id')
        .where('io.id', id)
        .select(
          'io.id',
          'io.instance',
          'io.state',
          'io.user',
          'io.added_by',
          'io.added_at',
          'u.first_name',
          'u.last_name',
          'u.email'
        )
        .first()
      await logActivity({
        action: 'create',
        collection: 'nivaro_pipeline_instance_owners',
        item: String(id),
        user: req.user?.id,
        req,
        comment: `${collection}:${item}`
      })
      return reply.code(201).send({ data: row })
    }
  )

  app.delete('/instance-owners/:ownerId', { preHandler: requireAuth }, async (req, reply) => {
    const { ownerId } = req.params as { ownerId: string }

    try {
    // Load the row and join to its instance so we can authorize the caller.
    const ownerRow = (await db('nivaro_pipeline_instance_owners as io')
      .join('nivaro_workflow_instances as wi', 'io.instance', 'wi.id')
      .where('io.id', ownerId)
      .select('io.id', 'io.user', 'io.added_by', 'wi.collection', 'wi.item', 'io.instance')
      .first()) as
      | {
          id: number
          user: string
          added_by: string | null
          collection: string
          item: string
          instance: string
        }
      | undefined

    if (!ownerRow) return reply.code(404).send({ error: 'Not found' })

    // Non-admins may only remove: (a) themselves, or (b) rows they added.
    if (!req.isAdmin) {
      const isSelf = ownerRow.user === req.user!.id
      const isAdder = ownerRow.added_by === req.user!.id
      if (!isSelf && !isAdder) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
    }

    await db('nivaro_pipeline_instance_owners').where({ id: ownerId }).delete()
    await logActivity({
      action: 'delete',
      collection: 'nivaro_pipeline_instance_owners',
      item: ownerId,
      user: req.user?.id,
      req
    })
    return reply.send({ success: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      req.log.error({ err }, 'delete instance-owner failed')
      return reply.code(500).send({ error: msg })
    }
  })

  // ─── Skip criteria (admin only) ───────────────────────────────────────────

  app.patch('/states/:stateId/skip', { preHandler: requireAdmin }, async (req, reply) => {
    const { stateId } = req.params as { stateId: string }
    const state = await db<WorkflowState>('nivaro_workflow_states').where({ id: stateId }).first()
    if (!state) return reply.code(404).send({ error: 'Not found' })

    const body = req.body as { criteria: SkipCriteria | null }
    await db('nivaro_workflow_states')
      .where({ id: stateId })
      .update({ skip_criteria: body.criteria ? JSON.stringify(body.criteria) : null })

    const updated = await db<WorkflowState>('nivaro_workflow_states').where({ id: stateId }).first()
    await logActivity({
      action: 'update',
      collection: 'nivaro_workflow_states',
      item: stateId,
      user: req.user?.id,
      req,
      comment: 'skip_criteria'
    })
    return reply.send({ data: updated ? formatState(updated) : updated })
  })

  // ─── Owner query endpoints (authenticated) ───────────────────────────────────

  // Full owner matrix for a template: all states → groups → users.
  // No record context — returns the raw configured groups.
  // Useful for SDK / admin reporting.
  app.get('/:id/matrix', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const template = await db('nivaro_workflow_templates').where({ id }).first()
    if (!template) return reply.code(404).send({ error: 'Not found' })

    const states = await db<WorkflowState>('nivaro_workflow_states')
      .where({ template: id })
      .orderBy('sort')
    const stateIds = states.map((s) => s.id)

    const groups = stateIds.length
      ? await db<OwnerGroup>('nivaro_pipeline_owner_groups')
          .whereIn('state', stateIds)
          .orderBy('state')
          .orderBy('sort')
          .orderBy('priority')
      : []

    const groupIds = groups.map((g) => g.id)
    const groupUsers = groupIds.length
      ? await db('nivaro_pipeline_owner_group_users as ogu')
          .join('nivaro_users as u', 'ogu.user', 'u.id')
          .whereIn('ogu.group', groupIds)
          .select('ogu.group', 'u.id', 'u.email', 'u.first_name', 'u.last_name')
      : []

    const usersByGroup = new Map<string, ResolvedOwner[]>()
    for (const u of groupUsers) {
      const arr = usersByGroup.get(u.group as string) ?? []
      arr.push({
        id: u.id as string,
        email: u.email as string,
        first_name: u.first_name as string | null,
        last_name: u.last_name as string | null
      })
      usersByGroup.set(u.group as string, arr)
    }

    const matrix: Record<string, unknown[]> = {}
    for (const g of groups) {
      const key = g.state as string
      if (!matrix[key]) matrix[key] = []
      matrix[key].push({
        ...g,
        is_default: coerceBool(g.is_default),
        filters: parseJson(g.filters as string),
        users: usersByGroup.get(g.id) ?? []
      })
    }

    return reply.send({ data: { template, states: states.map(formatState), matrix } })
  })

  // Resolved owners for a specific state given a record's filter context.
  // stateId can be any state in the pipeline — not limited to the current state.
  app.get(
    '/instance/:collection/:item/owners/:stateId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, item, stateId } = req.params as {
        collection: string
        item: string
        stateId: string
      }

      const state = await db<WorkflowState>('nivaro_workflow_states').where({ id: stateId }).first()
      if (!state) return reply.code(404).send({ error: 'State not found' })

      const instance = await db<WorkflowInstance>('nivaro_workflow_instances')
        .where({ collection, item })
        .first()

      const owners = await resolveStateOwners(stateId, instance?.id ?? null, collection, item, db)
      return reply.send({ data: { state: formatState(state), owners } })
    }
  )

  // Resolved owners for ALL states of the bound pipeline given a record's filter context.
  // Returns an object keyed by stateId so callers can look up any state without extra round-trips.
  app.get(
    '/instance/:collection/:item/owners/all',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { collection, item } = req.params as { collection: string; item: string }

      const binding = await db<WorkflowBinding>('nivaro_workflow_bindings')
        .where({ collection })
        .first()
      if (!binding) return reply.send({ data: null })

      const instance = await db<WorkflowInstance>('nivaro_workflow_instances')
        .where({ collection, item })
        .first()

      const states = await db<WorkflowState>('nivaro_workflow_states')
        .where({ template: binding.template })
        .orderBy('sort')

      const result: Record<
        string,
        { state: ReturnType<typeof formatState>; owners: ResolvedOwner[] }
      > = {}
      for (const s of states) {
        result[s.id] = {
          state: formatState(s),
          owners: await resolveStateOwners(s.id, instance?.id ?? null, collection, item, db)
        }
      }

      return reply.send({ data: result })
    }
  )

  // ─── Export a pipeline template as a portable nivaro/pipeline document ────────
  app.get('/:id/export', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const template = await db<WorkflowTemplate>('nivaro_workflow_templates').where({ id }).first()
    if (!template) return reply.code(404).send({ error: 'Not found' })

    const states = await db<WorkflowState>('nivaro_workflow_states')
      .where({ template: id })
      .orderBy('sort')
      .orderBy('label')

    const transitions = await db<WorkflowTransition>('nivaro_workflow_transitions')
      .where({ template: id })
      .orderBy('sort')
      .orderBy('label')

    const idToKey = new Map(states.map((s) => [s.id, s.key]))

    // Owner groups (with their member emails) keyed by state then group.
    const ownerGroupRows = await db('nivaro_pipeline_owner_groups as og')
      .leftJoin('nivaro_pipeline_owner_group_users as ogu', 'og.id', 'ogu.group')
      .leftJoin('nivaro_users as u', 'ogu.user', 'u.id')
      .whereIn(
        'og.state',
        states.map((s) => s.id)
      )
      .select(
        'og.id as group_id',
        'og.state as group_state',
        'og.name as group_name',
        'og.filters as group_filters',
        'og.sort as group_sort',
        'og.is_default as group_is_default',
        'u.email as user_email'
      )
      .orderBy(['og.sort', 'og.id'])

    const groupsByState: Record<
      string,
      Record<
        string,
        {
          name: string | null
          filters: unknown
          sort: number
          is_default: boolean
          users: string[]
        }
      >
    > = {}
    for (const row of ownerGroupRows) {
      const stateKey = row.group_state as string
      const groupKey = row.group_id as string
      if (!groupsByState[stateKey]) groupsByState[stateKey] = {}
      if (!groupsByState[stateKey][groupKey]) {
        groupsByState[stateKey][groupKey] = {
          name: row.group_name as string | null,
          filters: parseJson(row.group_filters as string | null),
          sort: Number(row.group_sort),
          is_default: coerceBool(row.group_is_default),
          users: []
        }
      }
      if (row.user_email) {
        groupsByState[stateKey][groupKey].users.push(row.user_email as string)
      }
    }

    // Bindings + their owner dimensions.
    const exportBindings = await db<WorkflowBinding>('nivaro_workflow_bindings').where({
      template: id
    })
    const exportedDimensions = exportBindings.length
      ? await db<OwnerDimension>('nivaro_pipeline_owner_dimensions')
          .whereIn(
            'binding',
            exportBindings.map((b) => b.id)
          )
          .orderBy('sort')
          .select('*')
      : []
    const dimsByBindingId = new Map<number, OwnerDimension[]>()
    for (const d of exportedDimensions) {
      const arr = dimsByBindingId.get(d.binding) ?? []
      arr.push(d)
      dimsByBindingId.set(d.binding, arr)
    }
    const exportedBindings = exportBindings.map((b) => ({
      collection: b.collection,
      state_field: b.state_field,
      dimensions: (dimsByBindingId.get(b.id) ?? []).map((d) => ({
        field: d.field,
        label: d.label,
        sort: d.sort,
        is_row_axis: coerceBool(d.is_row_axis)
      }))
    }))

    const exportDoc = {
      type: 'nivaro/pipeline',
      version: '1',
      exportedAt: new Date().toISOString(),
      pipeline: {
        name: template.name,
        description: template.description,
        color: template.color,
        icon: template.icon,
        states: states.map((s) => ({
          key: s.key,
          label: s.label,
          color: s.color,
          is_initial: coerceBool(s.is_initial),
          is_terminal: coerceBool(s.is_terminal),
          lock_record: coerceBool(s.lock_record),
          sort: s.sort,
          skip_criteria: parseJson(s.skip_criteria),
          owner_groups: Object.values(groupsByState[s.id] ?? {})
        })),
        bindings: exportedBindings,
        transitions: transitions.map((t) => ({
          from_state: t.from_state ? (idToKey.get(t.from_state) ?? null) : null,
          to_state: idToKey.get(t.to_state) ?? t.to_state,
          label: t.label,
          color: t.color,
          required_roles: parseJson(t.required_roles) as string[] | null,
          actions: parseJson(t.actions) as unknown[] | null,
          sort: t.sort,
          group_label: t.group_label,
          condition_rules: parseJson(t.condition_rules) as ConditionRule[] | null
        }))
      }
    }

    const slug = template.name.toLowerCase().replace(/\s+/g, '-')
    return reply
      .header('Content-Type', 'application/json')
      .header('Content-Disposition', `attachment; filename="${slug}.nivaro.json"`)
      .send(exportDoc)
  })

  // ─── Import a nivaro/pipeline document — bindings not included ────────────────
  app.post('/import', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      const body = req.body as {
        type?: string
        pipeline?: {
          name?: string
          description?: string | null
          color?: string | null
          icon?: string | null
          states?: Array<{
            key: string
            label: string
            color?: string | null
            is_initial?: boolean
            is_terminal?: boolean
            lock_record?: boolean
            sort?: number
            skip_criteria?: SkipCriteria | null
            owner_groups?: Array<{
              name?: string | null
              filters?: RecordFilter[] | null
              is_default?: boolean
              sort?: number
              users?: string[]
            }>
          }>
          bindings?: Array<{
            collection: string
            state_field?: string | null
            dimensions?: Array<{
              field: string
              label: string
              sort?: number
              is_row_axis?: boolean
            }>
          }>
          transitions?: Array<{
            from_state?: string | null
            to_state: string
            label: string
            color?: string | null
            required_roles?: string[] | null
            actions?: unknown[] | null
            sort?: number
            group_label?: string | null
            condition_rules?: ConditionRule[] | null
          }>
        }
      }

      if (body.type !== 'nivaro/pipeline' || !body.pipeline?.name) {
        return reply.code(400).send({ error: 'Invalid pipeline document' })
      }

      const templateId = randomUUID()
      const now = new Date()
      await db('nivaro_workflow_templates').insert({
        id: templateId,
        name: body.pipeline.name,
        description: body.pipeline.description ?? null,
        color: body.pipeline.color ?? null,
        icon: body.pipeline.icon ?? null,
        created_at: now,
        updated_at: now
      })

      const keyToId = new Map<string, string>()

      for (const state of body.pipeline.states ?? []) {
        const stateId = randomUUID()
        keyToId.set(state.key, stateId)
        await db('nivaro_workflow_states').insert({
          id: stateId,
          template: templateId,
          key: state.key,
          label: state.label,
          color: state.color ?? null,
          is_initial: state.is_initial ? 1 : 0,
          is_terminal: state.is_terminal ? 1 : 0,
          lock_record: state.lock_record ? 1 : 0,
          sort: state.sort ?? 0,
          skip_criteria: state.skip_criteria ? JSON.stringify(state.skip_criteria) : null
        })

        for (const groupDef of state.owner_groups ?? []) {
          const groupId = randomUUID()
          await db('nivaro_pipeline_owner_groups').insert({
            id: groupId,
            template: templateId,
            state: stateId,
            name: groupDef.name ?? null,
            filters: groupDef.filters ? JSON.stringify(groupDef.filters) : null,
            is_default: groupDef.is_default ? 1 : 0,
            sort: groupDef.sort ?? 0
          })

          for (const email of groupDef.users ?? []) {
            const user = await db('nivaro_users').where({ email }).first()
            if (!user) continue
            try {
              await db('nivaro_pipeline_owner_group_users').insert({
                group: groupId,
                user: user.id
              })
            } catch {
              // Duplicate (group, user) — ignore.
            }
          }
        }
      }

      // Bindings + dimensions (look up nothing; collection names are portable).
      for (const bindingDef of body.pipeline.bindings ?? []) {
        if (!bindingDef.collection?.trim()) continue
        const [insertedBindingId] = await db('nivaro_workflow_bindings')
          .insert({
            template: templateId,
            collection: bindingDef.collection.trim(),
            state_field: bindingDef.state_field ?? null
          })
          .returning('id')
        const bindingId =
          typeof insertedBindingId === 'object' ? insertedBindingId.id : insertedBindingId

        for (const dim of bindingDef.dimensions ?? []) {
          if (!dim.field?.trim() || !dim.label?.trim()) continue
          await db('nivaro_pipeline_owner_dimensions').insert({
            binding: bindingId,
            field: dim.field.trim(),
            label: dim.label.trim(),
            sort: dim.sort ?? 0,
            is_row_axis: dim.is_row_axis ? 1 : 0
          })
        }
      }

      for (const tx of body.pipeline.transitions ?? []) {
        const toStateId = keyToId.get(tx.to_state)
        if (!toStateId) continue
        const fromStateId = tx.from_state ? (keyToId.get(tx.from_state) ?? null) : null
        await db('nivaro_workflow_transitions').insert({
          id: randomUUID(),
          template: templateId,
          from_state: fromStateId,
          to_state: toStateId,
          label: tx.label,
          color: tx.color ?? null,
          required_roles: toJsonStr(tx.required_roles),
          actions: toJsonStr(tx.actions),
          sort: tx.sort ?? 0,
          group_label: tx.group_label?.trim() || null,
          condition_rules: toJsonStr(tx.condition_rules)
        })
      }

      await logActivity({
        action: 'create',
        collection: 'nivaro_workflow_templates',
        item: templateId,
        user: req.user?.id,
        req,
        comment: 'imported'
      })
      return reply.code(201).send({ data: { id: templateId, name: body.pipeline.name } })
    } catch (err) {
      app.log.error({ err }, 'Pipeline import failed')
      return reply.code(500).send({ error: 'Import failed' })
    }
  })
}
