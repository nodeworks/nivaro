import { randomUUID } from 'node:crypto'
import { selectInChunks } from '../services/db-batch.js'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  restoreTemplateVersion,
  snapshotTemplateVersion
} from '../services/workflow-template-versions.js'
import { can } from '../services/permissions.js'
import { resolveStateOwners, resolveStateOwnersBatch } from '../services/pipeline-engine.js'
import { syncMaterializedQueueItem } from '../services/queue-materialization.js'
import {
  evaluateTransitionRequirements,
  IDENTIFIER_RE
} from '../services/transition-requirements.js'
import {
  type ConditionRule,
  evalConditionRule,
  evaluateConditionRules,
  fetchRecordForConditions,
  parseConditionRules
} from '../services/workflow-conditions.js'
import { TransitionBlockedError } from '../services/workflow-actions.js'
import {
  applyTransition,
  evaluateSkipCriteriaDetailed,
  resolveTransitionTarget,
  runAutoTransitions,
  syncStateField
} from '../services/workflow-transitions.js'

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
  auto_trigger: boolean | number
  sort: number
  group_label: string | null
  condition_rules: string | null
  requirements: string | null
  /** 'none' (act on click) | 'optional' | 'required' — migration 201. */
  comment_mode?: string | null
}

interface WorkflowBinding {
  id: number
  template: string
  collection: string
  state_field: string | null
  state_field_map: string | null
  auto_start: boolean
  auto_start_state: string | null
  owner_fallback_field: string | null
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

interface OwnerGroup {
  id: string
  template: string
  state: string
  name: string | null
  filters: string | null
  sort: number
  is_default: boolean
  priority: number
  max_wip: number | null
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

// Loosely-typed — `type` is the only key enforcement cares about at read time;
// unrecognized types are stored and echoed back untouched (see
// evaluateTransitionRequirements for the forward-compat handling).
interface ParsedRequirement {
  type: string
  collection?: unknown
  fk_field?: unknown
  fields?: unknown
  labels?: unknown
  title?: unknown
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

/** Only these three mean anything to the panel; anything else is 'none'. */
function normalizeCommentMode(v: unknown): 'none' | 'optional' | 'required' {
  const m = String(v ?? '').toLowerCase()
  return m === 'optional' || m === 'required' ? m : 'none'
}

function formatTransition(t: WorkflowTransition) {
  return {
    ...t,
    required_roles: parseJson(t.required_roles) as string[] | null,
    actions: parseJson(t.actions) as unknown[] | null,
    auto_trigger: coerceBool(t.auto_trigger),
    condition_rules: parseJson(t.condition_rules) as ConditionRule[] | null,
    requirements: parseJson(t.requirements) as ParsedRequirement[] | null
  }
}


// ─── Transition requirements (child-field gates) ───────────────────────────
//
// The gate itself (evaluateTransitionRequirements) lives in
// services/transition-requirements.ts — it's shared by every mutation path
// that can execute a transition, not just this route. This file keeps only
// the 400-message body validator for the create/PATCH routes below.

// 400-message validator for the `requirements` array accepted by the transition
// create/PATCH routes. Only the known `child_fields` shape is validated — other
// `type` values are accepted and stored as-is, mirroring how enforcement treats
// unrecognized types as "no requirement" rather than an error (forward compat
// with the reserved `record_fields` type from the design doc).
function validateRequirements(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) return 'requirements must be an array'
  for (let i = 0; i < value.length; i++) {
    const entry = value[i]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return `requirements[${i}] must be an object`
    }
    const e = entry as Record<string, unknown>
    if (e.type === 'record_fields') {
      if (
        !Array.isArray(e.fields) ||
        e.fields.length === 0 ||
        !e.fields.every((f) => typeof f === 'string' && IDENTIFIER_RE.test(f))
      ) {
        return `requirements[${i}].fields must be a non-empty array of valid identifiers`
      }
      continue
    }
    if (e.type !== 'child_fields') continue
    if (typeof e.collection !== 'string' || !IDENTIFIER_RE.test(e.collection)) {
      return `requirements[${i}].collection must be a valid identifier`
    }
    if (typeof e.fk_field !== 'string' || !IDENTIFIER_RE.test(e.fk_field)) {
      return `requirements[${i}].fk_field must be a valid identifier`
    }
    if (
      !Array.isArray(e.fields) ||
      e.fields.length === 0 ||
      !e.fields.every((f) => typeof f === 'string' && IDENTIFIER_RE.test(f))
    ) {
      return `requirements[${i}].fields must be a non-empty array of valid identifiers`
    }
    if (
      e.display_fields !== undefined &&
      (!Array.isArray(e.display_fields) ||
        !e.display_fields.every((f) => typeof f === 'string' && IDENTIFIER_RE.test(f)))
    ) {
      return `requirements[${i}].display_fields must be an array of valid identifiers`
    }
  }
  return null
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
    await snapshotTemplateVersion(id, req.user?.id, 'before template update')

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
    // Versions FK the template with NO ACTION — clear them before the delete.
    await db('nivaro_workflow_template_versions').where({ template: id }).delete()
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
    await snapshotTemplateVersion(id, req.user?.id, 'before state create')

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
      | 'stage_visibility'
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
    await snapshotTemplateVersion(state.template, req.user?.id, 'before state update')

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
    const existingState = await db<WorkflowState>('nivaro_workflow_states')
      .where({ id: stateId })
      .first('template')
    if (!existingState) return reply.code(404).send({ error: 'Not found' })
    await snapshotTemplateVersion(existingState.template, req.user?.id, 'before state delete')
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
    if (template) await snapshotTemplateVersion(id, req.user?.id, 'before transition create')
    if (!template) return reply.code(404).send({ error: 'Template not found' })

    const body = req.body as Pick<
      WorkflowTransition,
      | 'from_state'
      | 'to_state'
      | 'label'
      | 'color'
      | 'required_roles'
      | 'actions'
      | 'auto_trigger'
      | 'sort'
      | 'group_label'
      | 'condition_rules'
      | 'requirements'
      | 'comment_mode'
    >
    if (!body.to_state) return reply.code(400).send({ error: 'to_state is required' })
    if (!body.label?.trim()) return reply.code(400).send({ error: 'label is required' })
    const requirementsError = validateRequirements(body.requirements)
    if (requirementsError) return reply.code(400).send({ error: requirementsError })

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
      auto_trigger: body.auto_trigger ? 1 : 0,
      sort: body.sort ?? 0,
      group_label: body.group_label?.trim() || null,
      condition_rules: toJsonStr(body.condition_rules),
      requirements: toJsonStr(body.requirements),
      comment_mode: normalizeCommentMode(body.comment_mode)
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
    await snapshotTemplateVersion(tx.template, req.user?.id, 'before transition update')

    const body = req.body as Partial<WorkflowTransition>
    const requirementsError = validateRequirements(body.requirements)
    if (requirementsError) return reply.code(400).send({ error: requirementsError })

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
        auto_trigger:
          body.auto_trigger !== undefined ? (body.auto_trigger ? 1 : 0) : tx.auto_trigger,
        sort: body.sort ?? tx.sort,
        group_label:
          body.group_label !== undefined ? body.group_label?.trim() || null : tx.group_label,
        condition_rules:
          body.condition_rules !== undefined ? toJsonStr(body.condition_rules) : tx.condition_rules,
        requirements:
          body.requirements !== undefined ? toJsonStr(body.requirements) : tx.requirements,
        comment_mode:
          body.comment_mode !== undefined
            ? normalizeCommentMode(body.comment_mode)
            : tx.comment_mode
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
    const existingTx = await db<WorkflowTransition>('nivaro_workflow_transitions')
      .where({ id: txId })
      .first('template')
    if (existingTx) {
      await snapshotTemplateVersion(existingTx.template, req.user?.id, 'before transition delete')
    }
    let deleted: number
    try {
      deleted = await db('nivaro_workflow_transitions').where({ id: txId }).delete()
    } catch {
      // FK from nivaro_workflow_history — executed transitions carry history
      return reply.code(409).send({
        error: 'This transition has been executed (history exists) and cannot be deleted.'
      })
    }
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
    await snapshotTemplateVersion(id, req.user?.id, 'before binding change')

    const body = req.body as {
      collection: string
      state_field?: string
      state_field_map?: Record<string, unknown> | string | null
      auto_start?: boolean | number
      auto_start_state?: string | null
      owner_fallback_field?: string | null
    }
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
          state_field: body.state_field ?? existing.state_field,
          state_field_map:
            body.state_field_map !== undefined
              ? toJsonStr(body.state_field_map)
              : existing.state_field_map,
          auto_start:
            body.auto_start !== undefined ? (body.auto_start ? 1 : 0) : existing.auto_start,
          auto_start_state:
            body.auto_start_state !== undefined
              ? body.auto_start_state || null
              : existing.auto_start_state,
          owner_fallback_field:
            body.owner_fallback_field !== undefined
              ? body.owner_fallback_field?.trim() || null
              : existing.owner_fallback_field
        })
    } else {
      await db('nivaro_workflow_bindings').insert({
        template: id,
        collection: body.collection.trim(),
        state_field: body.state_field ?? null,
        state_field_map: toJsonStr(body.state_field_map ?? null),
        auto_start: body.auto_start ? 1 : 0,
        auto_start_state: body.auto_start_state ?? null,
        owner_fallback_field: body.owner_fallback_field?.trim() || null
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
    const existingBinding = await db<WorkflowBinding>('nivaro_workflow_bindings')
      .where({ id: bindingId })
      .first('template')
    if (existingBinding) {
      await snapshotTemplateVersion(existingBinding.template, req.user?.id, 'before binding delete')
    }
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

  app.patch('/bindings/:bindingId', { preHandler: requireAdmin }, async (req, reply) => {
    const { bindingId } = req.params as { bindingId: string }
    const body = req.body as Partial<
      Pick<
        WorkflowBinding,
        | 'state_field'
        | 'state_field_map'
        | 'auto_start'
        | 'auto_start_state'
        | 'owner_fallback_field'
      >
    >
    const existing = await db<WorkflowBinding>('nivaro_workflow_bindings')
      .where({ id: bindingId })
      .first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    await snapshotTemplateVersion(existing.template, req.user?.id, 'before binding update')
    await db('nivaro_workflow_bindings')
      .where({ id: bindingId })
      .update({
        state_field:
          body.state_field !== undefined ? body.state_field || null : existing.state_field,
        state_field_map:
          body.state_field_map !== undefined
            ? toJsonStr(body.state_field_map)
            : existing.state_field_map,
        auto_start: body.auto_start !== undefined ? (body.auto_start ? 1 : 0) : existing.auto_start,
        auto_start_state:
          body.auto_start_state !== undefined
            ? body.auto_start_state || null
            : existing.auto_start_state,
        owner_fallback_field:
          body.owner_fallback_field !== undefined
            ? body.owner_fallback_field?.trim() || null
            : existing.owner_fallback_field
      })
    const updated = await db<WorkflowBinding>('nivaro_workflow_bindings')
      .where({ id: bindingId })
      .first()
    await logActivity({
      action: 'update',
      collection: 'nivaro_workflow_bindings',
      item: bindingId,
      user: req.user?.id,
      req
    })
    return reply.send({ data: { ...updated, auto_start: coerceBool(updated?.auto_start) } })
  })

  // ─── Instance endpoints (authenticated, not admin-only) ───────────────────

  // Flow map — transition volumes for a template over a period (Sankey).
  app.get('/:id/flow-map', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const days = Math.min(730, Math.max(1, Number((req.query as { days?: string }).days) || 90))
    const since = new Date(Date.now() - days * 86_400_000)

    const states = (await db<WorkflowState>('nivaro_workflow_states')
      .where({ template: id })
      .orderBy('sort')) as WorkflowState[]
    if (states.length === 0) return reply.send({ data: { states: [], flows: [] } })
    const stateIds = states.map((s) => s.id)
    const sortById = new Map(states.map((s, i) => [s.id, i]))

    const rows = (await db('nivaro_workflow_history')
      .whereIn('to_state', stateIds)
      .where('timestamp', '>=', since)
      .whereNotNull('from_state')
      .groupBy('from_state', 'to_state')
      .select('from_state', 'to_state')
      .count({ n: '*' })) as Array<{ from_state: string; to_state: string; n: number | string }>

    const flows = rows
      .filter((r) => sortById.has(r.from_state) && sortById.has(r.to_state))
      .map((r) => ({
        from: r.from_state,
        to: r.to_state,
        count: Number(r.n),
        back: (sortById.get(r.to_state) ?? 0) < (sortById.get(r.from_state) ?? 0)
      }))
      .sort((a, b) => b.count - a.count)

    return reply.send({
      data: {
        states: states.map((s) => ({ id: s.id, label: s.label, color: s.color })),
        flows,
        days
      }
    })
  })

  // Replay — daily state distribution reconstruction for the time-lapse.
  // Baseline = each instance's state at window start (aggregated in SQL);
  // then transition events sweep forward as +1/-1 deltas per day.
  app.get('/:id/replay', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const days = Math.min(365, Math.max(7, Number((req.query as { days?: string }).days) || 90))
    const start = new Date(Date.now() - days * 86_400_000)
    start.setHours(0, 0, 0, 0)

    const states = (await db<WorkflowState>('nivaro_workflow_states')
      .where({ template: id })
      .orderBy('sort')) as WorkflowState[]
    if (states.length === 0) return reply.send({ data: { states: [], days: [] } })
    const stateIds = new Set(states.map((s) => s.id))

    // Baseline: latest transition per instance BEFORE the window → state counts
    const baseline = (await db.raw(
      `SELECT h.to_state AS state, COUNT(*) AS n FROM (
         SELECT instance, to_state,
                ROW_NUMBER() OVER (PARTITION BY instance ORDER BY timestamp DESC) AS rn
         FROM nivaro_workflow_history
         WHERE timestamp < ? AND instance IN (
           SELECT id FROM nivaro_workflow_instances WHERE template = ?
         )
       ) h WHERE h.rn = 1 GROUP BY h.to_state`,
      [start, id]
    )) as Array<{ state: string; n: number | string }>

    // Events inside the window (chronological)
    const events = (await db.raw(
      `SELECT h.from_state, h.to_state, h.timestamp
       FROM nivaro_workflow_history h
       JOIN nivaro_workflow_instances wi ON wi.id = h.instance
       WHERE wi.template = ? AND h.timestamp >= ?
       ORDER BY h.timestamp ASC`,
      [id, start]
    )) as Array<{ from_state: string | null; to_state: string | null; timestamp: Date }>

    const counts = new Map<string, number>()
    for (const b of baseline) {
      if (stateIds.has(b.state)) counts.set(b.state, Number(b.n))
    }

    const dayMs = 86_400_000
    const result: Array<{ date: string; counts: Record<string, number> }> = []
    let ei = 0
    for (let d = 0; d <= days; d++) {
      const dayEnd = start.getTime() + (d + 1) * dayMs
      while (ei < events.length && new Date(events[ei].timestamp).getTime() < dayEnd) {
        const ev = events[ei]
        if (ev.from_state && stateIds.has(ev.from_state)) {
          counts.set(ev.from_state, Math.max(0, (counts.get(ev.from_state) ?? 0) - 1))
        }
        if (ev.to_state && stateIds.has(ev.to_state)) {
          counts.set(ev.to_state, (counts.get(ev.to_state) ?? 0) + 1)
        }
        ei++
      }
      result.push({
        date: new Date(start.getTime() + d * dayMs).toISOString().slice(0, 10),
        counts: Object.fromEntries(counts)
      })
    }

    return reply.send({
      data: {
        states: states.map((st) => ({
          id: st.id,
          label: st.label,
          color: st.color,
          is_terminal: coerceBool(st.is_terminal)
        })),
        days: result
      }
    })
  })

  // Simulate — dry-run a record through its pipeline: every transition with
  // per-rule condition results and role checks, resolved owners for every
  // state, and the SLA rule that would arm in each. Read-only.
  app.post('/simulate', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as { collection?: string; item_id?: string | number }
    if (!body.collection || body.item_id == null) {
      return reply.code(400).send({ error: 'collection and item_id are required' })
    }
    const collection = body.collection
    const item = String(body.item_id)
    if (!req.isAdmin && !(await can(req.user!, 'read', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const binding = await db<WorkflowBinding>('nivaro_workflow_bindings')
      .where({ collection })
      .first()
    const instance = await db<WorkflowInstance>('nivaro_workflow_instances')
      .where({ collection, item })
      .first()
    if (!binding && !instance) {
      return reply.send({ data: null })
    }
    const template = binding?.template ?? instance?.template
    const states = await db<WorkflowState>('nivaro_workflow_states')
      .where({ template })
      .orderBy('sort')
    const transitions = await db<WorkflowTransition>('nivaro_workflow_transitions')
      .where({ template })
      .orderBy('sort')

    const record = await fetchRecordForConditions(collection, item)
    const initialState = states.find((s) => coerceBool(s.is_initial)) ?? states[0]
    const currentState = instance?.current_state ?? initialState?.id ?? null

    // Owners for every state in one batched resolve
    const ownerMap = await resolveStateOwnersBatch(
      states.map((s) => ({
        key: s.id,
        stateId: s.id,
        instanceId: instance?.id ?? null,
        collection,
        itemId: item
      }))
    )

    // SLA rules by state key
    const slaRules = template
      ? await db('nivaro_sla_rules').where({ workflow_template: template, is_active: true })
      : []
    const slaByKey = new Map(slaRules.map((r) => [String(r.state_key), r]))

    const userRole = req.user?.role ?? null
    const isAdmin = req.isAdmin ?? false

    const simTransitions = transitions.map((tx) => {
      const fromOk = tx.from_state === null || tx.from_state === currentState
      const rules = (parseJson(tx.condition_rules) as ConditionRule[] | null) ?? []
      const ruleResults = rules
        .filter((r) => r && typeof r === 'object' && typeof r.field === 'string' && r.field)
        .map((r) => ({
          field: r.field,
          op: r.op,
          value: r.value ?? null,
          record_value: record[r.field] ?? null,
          passed: evalConditionRule(r, record)
        }))
      const conditionsPass = ruleResults.every((r) => r.passed)
      const roles = (parseJson(tx.required_roles) as string[] | null) ?? []
      const rolePass =
        isAdmin || roles.length === 0 || (userRole != null && roles.includes(userRole))
      return {
        id: tx.id,
        label: tx.label,
        from_state: tx.from_state,
        to_state: tx.to_state,
        from_ok: fromOk,
        condition_rules: ruleResults,
        conditions_pass: conditionsPass,
        required_roles: roles,
        role_pass: rolePass,
        available: fromOk && conditionsPass && rolePass
      }
    })

    const simStates = states.map((s) => {
      const rule = slaByKey.get(String(s.key))
      return {
        id: s.id,
        key: s.key,
        label: s.label,
        color: s.color,
        is_initial: coerceBool(s.is_initial),
        is_terminal: coerceBool(s.is_terminal),
        is_current: s.id === currentState,
        owners: ownerMap.get(s.id) ?? [],
        sla_rule: rule
          ? {
              name: rule.name,
              duration_hours: rule.duration_hours,
              warning_threshold_pct: rule.warning_threshold_pct,
              business_hours_only: !!rule.business_hours_only
            }
          : null
      }
    })

    return reply.send({
      data: {
        template,
        has_instance: !!instance,
        current_state: currentState,
        states: simStates,
        transitions: simTransitions
      }
    })
  })

  // Get pipeline state for a specific item
  app.get('/instance/:collection/:item', { preHandler: requireAuth }, async (req, reply) => {
    const { collection, item } = req.params as { collection: string; item: string }

    const binding = await db<WorkflowBinding>('nivaro_workflow_bindings')
      .where({ collection })
      .first()

    const instance = await db<WorkflowInstance>('nivaro_workflow_instances')
      .where({ collection, item })
      .first()

    // No binding and no instance — nothing to show
    if (!binding && !instance) return reply.send({ data: null })

    // No binding but instance exists (e.g. addendums) — derive template from instance
    const effectiveBinding =
      binding ?? ({ template: instance!.template, collection } as WorkflowBinding)

    if (!instance)
      return reply.send({
        data: {
          instance: null,
          states: [],
          available_transitions: [],
          history: [],
          binding: effectiveBinding
        }
      })

    const states = await db<WorkflowState>('nivaro_workflow_states')
      .where({ template: effectiveBinding.template })
      .orderBy('sort')

    const transitions = await db<WorkflowTransition>('nivaro_workflow_transitions')
      .where({ template: effectiveBinding.template })
      .orderBy('sort')

    // Filter available transitions for this user
    const currentState = instance.current_state
    const userRole = req.user?.role ?? null
    const isAdmin = req.isAdmin ?? false

    // Load the bound item row once when any transition carries condition rules,
    // so conditional branching can filter the offered transitions.
    const hasConditionRules = transitions.some((tx) => tx.condition_rules)
    const conditionRecord = hasConditionRules
      ? await fetchRecordForConditions(collection, item, transitions.map((tx) => tx.condition_rules))
      : {}

    const availableTransitions = transitions
      .filter((tx) => {
        // Auto transitions fire from the engine, never from users
        if (coerceBool(tx.auto_trigger)) return false
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
        binding: effectiveBinding
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
        finalState = (resolvedState as unknown as WorkflowState | null) ?? initialState
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

      // Automatic transitions belong to the engine — never user-executable
      if (coerceBool(transition.auto_trigger)) {
        return reply.code(400).send({ error: 'Automatic transitions cannot be executed manually' })
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

      // Transition requirements gate: block on incomplete child-row data before
      // even considering condition rules — a data-entry gate takes priority over
      // conditional branching, and API callers can't bypass it.
      if (transition.requirements) {
        const blocking = await evaluateTransitionRequirements(
          db,
          transition.requirements,
          item,
          req.log,
          collection
        )
        if (blocking) {
          return reply.code(422).send({ error: 'TRANSITION_REQUIREMENTS', requirements: blocking })
        }
      }

      // Conditional branching guard: re-fetch the item and revalidate condition
      // rules server-side — the client's view may be stale.
      if (transition.condition_rules) {
        const conditionRecord = await fetchRecordForConditions(collection, item, [
          transition.condition_rules
        ])
        if (!evaluateConditionRules(transition.condition_rules, conditionRecord)) {
          return reply.code(409).send({ error: 'Transition conditions not met' })
        }
      }

      // Shared mutation chain (instance update, history, materialized queue
      // sync, state_field mirror incl. state_field_map, transition actions).
      // A blocking action failure (e.g. MDSi submission) aborts BEFORE any
      // mutation — the record stays in its current state and the client gets
      // the error to display.
      let applied: Awaited<ReturnType<typeof applyTransition>>
      try {
        applied = await applyTransition({
          instance,
          transition: transition as unknown as Parameters<typeof applyTransition>[0]['transition'],
          userId: req.user?.id ?? null,
          comment: body.comment ?? null,
          source: 'manual'
        })
      } catch (err) {
        if (err instanceof TransitionBlockedError) {
          return reply.code(422).send({ error: err.message })
        }
        throw err
      }
      const { updatedInstance, newStateObj, previousState } = applied

      // Chained automation: fire any auto transitions now valid from the new state
      await runAutoTransitions(collection, item)

      const prevStateObj = previousState
        ? await db<WorkflowState>('nivaro_workflow_states').where({ id: previousState }).first()
        : null
      const fromLabel = prevStateObj?.label ?? previousState ?? 'Start'
      const toLabel = newStateObj?.label ?? 'Unknown'
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
          new_state: newStateObj ? formatState(newStateObj as unknown as WorkflowState) : null
        }
      })
    }
  )

  // Batch state lookup — all instances for a collection (for collection browser table)
  // `ids` (comma list) scopes the response to just those records — the
  // collection browser only needs state badges for the page it is rendering.
  // Without it this returns EVERY instance for the collection: on workflows
  // (88k) that was a 13s response and the single biggest cost of a browse.
  // The unscoped form is kept for callers that genuinely need the whole map.
  app.get('/instances/:collection', { preHandler: requireAuth }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const rawIds = (req.query as { ids?: string })?.ids
    const ids = rawIds
      ? rawIds.split(',').map((v) => v.trim()).filter(Boolean).slice(0, 500)
      : null
    const binding = await db<WorkflowBinding>('nivaro_workflow_bindings')
      .where({ collection })
      .first()
    if (!binding) return reply.send({ data: null })
    if (ids && ids.length === 0) {
      return reply.send({ data: { binding, instances: {} } })
    }

    const rows = await db('nivaro_workflow_instances as i')
      .leftJoin('nivaro_workflow_states as s', 'i.current_state', 's.id')
      .where('i.collection', collection)
      .modify((qb) => {
        if (ids) qb.whereIn('i.item', ids)
      })
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
    // The workflows template carries ~3.9k owner groups (legacy owner sync) —
    // a single whereIn blows MSSQL's ~2100 bound-parameter cap and 500s the
    // whole matrix. Chunked like every other id-scaling whereIn.
    const groupUsers = await selectInChunks(groupIds, 2000, (chunk) =>
      db('nivaro_pipeline_owner_group_users as ogu')
        .join('nivaro_users as u', 'ogu.user', 'u.id')
        .whereIn('ogu.group', chunk)
        .select(
          'ogu.id as link_id',
          'ogu.group',
          'u.id',
          'u.email',
          'u.first_name',
          'u.last_name'
        )
    )

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
      max_wip?: number | null
    }
    await db('nivaro_pipeline_owner_groups')
      .where({ id: groupId })
      .update({
        name: body.name !== undefined ? body.name : existing.name,
        filters: body.filters !== undefined ? toJsonStr(body.filters) : existing.filters,
        is_default: body.is_default !== undefined ? (body.is_default ? 1 : 0) : existing.is_default,
        sort: body.sort ?? existing.sort,
        priority: body.priority !== undefined ? body.priority : existing.priority,
        max_wip: body.max_wip !== undefined ? body.max_wip : existing.max_wip
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

  // POST /instance/:collection/owners/batch {ids} → resolved owner display
  // names per record, one batched engine pass (browser Owners columns).
  app.post('/instance/:collection/owners/batch', { preHandler: requireAuth }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { ids } = (req.body ?? {}) as { ids?: Array<string | number> }
    const idList = (ids ?? []).map(String).filter(Boolean).slice(0, 500)
    if (!idList.length) return reply.send({ data: {} })
    const instances = (await db('nivaro_workflow_instances')
      .where({ collection })
      .whereIn('item', idList)
      .select('id', 'item', 'current_state')) as Array<{
      id: string
      item: string
      current_state: string | null
    }>
    const requests = instances
      .filter((i) => i.current_state)
      .map((i) => ({
        key: String(i.item),
        stateId: i.current_state as string,
        instanceId: i.id,
        collection,
        itemId: String(i.item)
      }))
    const byKey = await resolveStateOwnersBatch(requests)
    const out: Record<string, Array<{ id: string; name: string }>> = {}
    for (const [k, owners] of byKey)
      out[k] = owners.map((o) => ({
        id: o.id,
        name: `${o.first_name ?? ''} ${o.last_name ?? ''}`.trim() || o.email
      }))
    return reply.send({ data: out })
  })

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
    await snapshotTemplateVersion(state.template, req.user?.id, 'before skip-criteria update')

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

      const instance = await db<WorkflowInstance>('nivaro_workflow_instances')
        .where({ collection, item })
        .first()

      // No collection binding is fine when the record has its OWN instance —
      // addendum workflows start from the layout's template (nivaro_addendums
      // is never bound), and the chain resolves from the instance's template.
      const templateId = binding?.template ?? instance?.template
      if (!templateId) return reply.send({ data: null })

      const states = await db<WorkflowState>('nivaro_workflow_states')
        .where({ template: templateId })
        .orderBy('sort')

      // Skip prediction needs the record row (field_compare/lookup_compare
      // criteria) — one fetch shared across states. Best-effort: an unreadable
      // record just means no skip flags, never a failed response.
      let record: Record<string, unknown> = {}
      try {
        const r = await db(collection).where({ id: item }).first()
        if (r) record = r as Record<string, unknown>
      } catch {
        record = {}
      }

      // ── Path relevance ──────────────────────────────────────────────────
      // A template can hold branch states (Oracle vs Beeline submission, CAR
      // vs REQ endings) that this record will never visit. BFS the explicit
      // transition graph from the initial state and mark reachable states.
      // Edges survive when they are FORWARD (send-backs never extend a path)
      // and either (a) their DISCRIMINATOR conditions pass — eq/neq/in/notin
      // against the record (workflow_type eq 3 → Beeline) — or (b) the record
      // actually took them (history), which covers skip-jump edges that exist
      // only in history (Manager → VP when L2/Peer were skipped). Progress-
      // style conditions (related_some lines, requisition nnull, within_days…)
      // are treated as "will pass eventually" — they gate WHEN a transition
      // fires, not WHICH branch the record belongs to. NOTE a departed state
      // deliberately keeps its condition-passing template edges too: after a
      // send-back the record re-walks from an earlier state, and restricting a
      // left state to only its taken edges dead-ended the path at any state
      // that was only ever left backward (PO/Completed vanished).
      const onPath = new Set<string>()
      try {
        const transitions = (await db<WorkflowTransition>('nivaro_workflow_transitions')
          .where({ template: templateId })
          .whereNotNull('from_state')
          .select('from_state', 'to_state', 'condition_rules')) as Array<{
          from_state: string
          to_state: string
          condition_rules: string | null
        }>
        const historyRows = instance
          ? ((await db('nivaro_workflow_history')
              .where({ instance: instance.id })
              .select('from_state', 'to_state')) as Array<{
              from_state: string | null
              to_state: string
            }>)
          : []
        const takenEdges = new Set(
          historyRows.filter((h) => h.from_state).map((h) => `${h.from_state}:${h.to_state}`)
        )

        const conditioned = transitions.filter((t) => t.condition_rules)
        const conditionRecord =
          conditioned.length > 0
            ? await fetchRecordForConditions(collection, item, conditioned.map((t) => t.condition_rules))
            : record
        const DISCRIMINATOR_OPS = new Set(['eq', 'neq', 'in', 'notin'])
        const passes = (t: { condition_rules: string | null }) => {
          const rules = parseConditionRules(t.condition_rules)
          if (!rules) return true
          return rules.every((r) => {
            if (!r || typeof r !== 'object' || typeof r.field !== 'string' || !r.field) return true
            if (!DISCRIMINATOR_OPS.has(String(r.op))) return true
            return evalConditionRule(r, conditionRecord)
          })
        }

        // Send-backs are backward edges (to a lower-sort state); following them
        // in the BFS resurrects pruned branches (Beeline → Oracle Approval →
        // send-back → Oracle Submission puts the Oracle branch back on a
        // Beeline record's path). Forward flow only.
        const sortOf = new Map(states.map((s) => [s.id, s.sort ?? 0]))
        const fwd = new Map<string, string[]>()
        for (const t of transitions) {
          if ((sortOf.get(t.to_state) ?? 0) < (sortOf.get(t.from_state) ?? 0)) continue
          if (!passes(t) && !takenEdges.has(`${t.from_state}:${t.to_state}`)) continue
          const arr = fwd.get(t.from_state) ?? []
          arr.push(t.to_state)
          fwd.set(t.from_state, arr)
        }
        // Skip-jumps write history edges that exist in NO template transition
        // (Manager → VP when the states between were skipped) — feed them into
        // the graph so a historically-taken shortcut keeps the path connected.
        for (const key of takenEdges) {
          const [fromId, toId] = key.split(':')
          if ((sortOf.get(toId) ?? 0) < (sortOf.get(fromId) ?? 0)) continue
          const arr = fwd.get(fromId) ?? []
          if (!arr.includes(toId)) {
            arr.push(toId)
            fwd.set(fromId, arr)
          }
        }

        const queue = states.filter((s) => coerceBool(s.is_initial)).map((s) => s.id)
        while (queue.length) {
          const id = queue.shift() as string
          if (onPath.has(id)) continue
          onPath.add(id)
          for (const next of fwd.get(id) ?? []) if (!onPath.has(next)) queue.push(next)
        }
        // History + current state are always relevant, whatever the graph says.
        for (const h of historyRows) onPath.add(h.to_state)
        if (instance?.current_state) onPath.add(instance.current_state)
        // A template with no initial state (or a broken graph) yields nothing —
        // degrade to showing everything rather than an empty chain.
        if (onPath.size === 0) for (const s of states) onPath.add(s.id)
      } catch {
        // Relevance is a display refinement — on any failure fall back to
        // "everything is on the path" rather than an empty chain.
        for (const s of states) onPath.add(s.id)
      }

      const result: Record<
        string,
        {
          state: ReturnType<typeof formatState>
          owners: ResolvedOwner[]
          skipped: boolean
          skip_reasons: string[]
          on_path: boolean
        }
      > = {}
      await Promise.all(
        states.map(async (s) => {
          const [owners, skip] = await Promise.all([
            resolveStateOwners(s.id, instance?.id ?? null, collection, item, db),
            // The current state was already entered — a skip flag on it would
            // read as a contradiction.
            s.id === instance?.current_state
              ? Promise.resolve({ skipped: false, reasons: [] as string[] })
              : evaluateSkipCriteriaDetailed(
                  s.id,
                  record,
                  instance?.id ?? null,
                  collection,
                  item,
                  db
                )
          ])
          result[s.id] = {
            state: formatState(s),
            owners,
            skipped: skip.skipped,
            skip_reasons: skip.reasons,
            on_path: onPath.has(s.id)
          }
        })
      )

      return reply.send({ data: result })
    }
  )

  // ─── Export a pipeline template as a portable nivaro/pipeline document ────────
  // ─── Template versions (config snapshots + restore) ───────────────────────

  app.get('/:id/versions', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const rows = await db('nivaro_workflow_template_versions as v')
      .leftJoin('nivaro_users as u', 'v.created_by', 'u.id')
      .where({ 'v.template': id })
      .orderBy('v.version', 'desc')
      .limit(100)
      .select(
        'v.id',
        'v.version',
        'v.note',
        'v.created_at',
        db.raw("CONCAT(u.first_name, ' ', u.last_name) as created_by_name")
      )
    return reply.send({ data: rows })
  })

  app.get('/:id/versions/:versionId', { preHandler: requireAdmin }, async (req, reply) => {
    const { id, versionId } = req.params as { id: string; versionId: string }
    const row = await db('nivaro_workflow_template_versions')
      .where({ template: id, id: Number(versionId) })
      .first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return reply.send({
      data: { ...row, snapshot: JSON.parse((row as { snapshot: string }).snapshot) }
    })
  })

  app.post(
    '/:id/versions/:versionId/restore',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id, versionId } = req.params as { id: string; versionId: string }
      // Snapshot the CURRENT config first so the restore itself is reversible.
      await snapshotTemplateVersion(id, req.user?.id, 'before restore')
      let result: Awaited<ReturnType<typeof restoreTemplateVersion>>
      try {
        result = await restoreTemplateVersion(id, Number(versionId))
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : 'Restore failed' })
      }
      await logActivity({
        action: 'update',
        collection: 'nivaro_workflow_templates',
        item: id,
        user: req.user?.id,
        req,
        comment: `restore-version:${versionId}`
      })
      return reply.send({ data: result })
    }
  )

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
