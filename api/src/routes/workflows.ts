import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'

// ─── Types (mirrors routes/pipelines.ts — same underlying tables) ─────────────

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

interface HistoryRow {
  id: number
  instance: string
  transition: string | null
  from_state: string | null
  to_state: string
  user: string | null
  comment: string | null
  timestamp: Date
}

/** JSON payload stored in a split history row's comment column. */
interface SplitRecord {
  action: 'split'
  children: string[]
  join_state: string
}

/**
 * Split config storage contract:
 * a row in nivaro_workflow_transitions with
 *   from_state = to_state = <join state id>
 *   group_label = `split:{"branches":["<key>",…],"join":"<key>"}`  (state KEYS — 255 char limit)
 *   required_roles = '["__split_config__"]'  (hides it from non-admin transition lists)
 * These rows are config carriers only — they are never executed as transitions.
 */
const SPLIT_PREFIX = 'split:'
const SPLIT_ROLE_SENTINEL = '["__split_config__"]'

interface SplitConfig {
  branches: string[] // state keys
  join: string // state key
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseJson<T = unknown>(val: string | null | undefined): T | null {
  if (!val) return null
  if (typeof val !== 'string') return val as T
  try {
    return JSON.parse(val) as T
  } catch {
    return null
  }
}

function coerceBool(val: unknown): boolean {
  return val === true || val === 1 || val === '1'
}

function parseSplitConfig(tx: WorkflowTransition): SplitConfig | null {
  if (!tx.group_label?.startsWith(SPLIT_PREFIX)) return null
  const cfg = parseJson<SplitConfig>(tx.group_label.slice(SPLIT_PREFIX.length))
  if (!cfg || !Array.isArray(cfg.branches) || typeof cfg.join !== 'string') return null
  return cfg
}

function isSplitConfigRow(tx: WorkflowTransition): boolean {
  return tx.group_label?.startsWith(SPLIT_PREFIX) ?? false
}

function transitionAllowed(tx: WorkflowTransition, req: FastifyRequest): boolean {
  if (req.isAdmin) return true
  if (!tx.required_roles) return true
  const roles = parseJson<string[]>(tx.required_roles)
  if (!roles || roles.length === 0) return true
  const userRole = req.user?.role ?? null
  return userRole !== null && roles.includes(userRole)
}

/**
 * Per-instance access guard: system collections are admin-only; everything else
 * requires the matching collection permission for the requesting user.
 */
async function instanceAccessDenied(
  req: FastifyRequest,
  instance: WorkflowInstance,
  action: 'read' | 'update'
): Promise<boolean> {
  if (req.isAdmin) return false
  if (instance.collection.startsWith('nivaro_')) return true
  if (!req.user) return true
  return !(await can(req.user, action, instance.collection))
}

function formatStateLite(s: WorkflowState) {
  return {
    id: s.id,
    key: s.key,
    label: s.label,
    color: s.color,
    is_terminal: coerceBool(s.is_terminal)
  }
}

/** Find the most recent split on an instance that has not yet been joined. */
async function getOpenSplit(instanceId: string): Promise<SplitRecord | null> {
  const rows = (await db('nivaro_workflow_history')
    .where({ instance: instanceId })
    .where('comment', 'like', '%"action":%')
    .orderBy('timestamp', 'desc')
    .orderBy('id', 'desc')
    .select('*')) as HistoryRow[]

  for (const row of rows) {
    const parsed = parseJson<{ action?: string }>(row.comment)
    if (!parsed?.action) continue
    if (parsed.action === 'join') return null // last lifecycle event was a join — closed
    if (parsed.action === 'split') return parsed as SplitRecord
  }
  return null
}

async function isInstanceTerminal(instance: WorkflowInstance): Promise<boolean> {
  if (instance.completed_at) return true
  if (!instance.current_state) return false
  const state = (await db('nivaro_workflow_states')
    .where({ id: instance.current_state })
    .first()) as WorkflowState | undefined
  return state ? coerceBool(state.is_terminal) : false
}

/**
 * Join check: given a child instance that just reached a terminal state, find its
 * parent's open split. When ALL sibling branches are terminal, auto-transition the
 * parent to the configured join state and record a 'join' history entry.
 */
async function checkJoin(childInstanceId: string, userId: string | null) {
  // Find split history rows that reference this child.
  const candidates = (await db('nivaro_workflow_history')
    .where('comment', 'like', '%"action":"split"%')
    .where('comment', 'like', `%${childInstanceId}%`)
    .orderBy('timestamp', 'desc')
    .orderBy('id', 'desc')
    .select('*')) as HistoryRow[]

  for (const row of candidates) {
    const split = parseJson<SplitRecord>(row.comment)
    if (split?.action !== 'split' || !split.children?.includes(childInstanceId)) continue

    const parentId = row.instance
    // Confirm this split is still the open one on the parent.
    const open = await getOpenSplit(parentId)
    if (!open || JSON.stringify(open.children) !== JSON.stringify(split.children)) continue

    // Are all siblings terminal?
    const children = (await db('nivaro_workflow_instances')
      .whereIn('id', split.children)
      .select('*')) as WorkflowInstance[]
    const terminalFlags = await Promise.all(children.map((c) => isInstanceTerminal(c)))
    if (children.length !== split.children.length || terminalFlags.some((t) => !t)) return null

    const parent = (await db('nivaro_workflow_instances').where({ id: parentId }).first()) as
      | WorkflowInstance
      | undefined
    if (!parent || parent.completed_at) return null

    const joinState = (await db('nivaro_workflow_states')
      .where({ id: split.join_state })
      .first()) as WorkflowState | undefined
    if (!joinState) return null

    const now = new Date()
    await db('nivaro_workflow_instances')
      .where({ id: parentId })
      .update({
        current_state: joinState.id,
        completed_at: coerceBool(joinState.is_terminal) ? now : null
      })
    await db('nivaro_workflow_history').insert({
      instance: parentId,
      transition: null,
      from_state: parent.current_state,
      to_state: joinState.id,
      user: userId,
      comment: JSON.stringify({ action: 'join', children: split.children }),
      timestamp: now
    })

    // Sync state_field on the record if the binding configures one.
    const binding = (await db('nivaro_workflow_bindings')
      .where({ collection: parent.collection })
      .first()) as { state_field: string | null } | undefined
    if (binding?.state_field) {
      try {
        await db(parent.collection)
          .where({ id: parent.item })
          .update({ [binding.state_field]: joinState.key })
      } catch {
        // Non-fatal: field may not exist on this collection
      }
    }

    return { parentId, joinState }
  }
  return null
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function workflowsRoutes(app: FastifyInstance) {
  // ── Template-level split configs (admin) ──────────────────────────────────

  app.get('/templates/:id/splits', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const [transitions, states] = await Promise.all([
      db<WorkflowTransition>('nivaro_workflow_transitions').where({ template: id }).select('*'),
      db<WorkflowState>('nivaro_workflow_states').where({ template: id }).select('*')
    ])
    const byKey = new Map(states.map((s) => [s.key, s]))
    const splits = transitions
      .filter(isSplitConfigRow)
      .map((tx) => {
        const cfg = parseSplitConfig(tx)
        if (!cfg) return null
        return {
          id: tx.id,
          label: tx.label,
          branch_states: cfg.branches,
          branch_state_objs: cfg.branches
            .map((k) => byKey.get(k))
            .filter(Boolean)
            .map((s) => formatStateLite(s as WorkflowState)),
          join_state: cfg.join,
          join_state_obj: byKey.has(cfg.join)
            ? formatStateLite(byKey.get(cfg.join) as WorkflowState)
            : null
        }
      })
      .filter(Boolean)
    return reply.send({ data: splits })
  })

  app.post('/templates/:id/splits', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { branch_states?: string[]; join_state?: string; label?: string }

    if (!Array.isArray(body?.branch_states) || body.branch_states.length < 2) {
      return reply.code(400).send({ error: 'branch_states requires at least 2 state keys' })
    }
    if (!body.join_state) return reply.code(400).send({ error: 'join_state is required' })
    if (body.branch_states.includes(body.join_state)) {
      return reply.code(400).send({ error: 'join_state cannot be one of the branch states' })
    }

    const template = await db('nivaro_workflow_templates').where({ id }).first()
    if (!template) return reply.code(404).send({ error: 'Template not found' })

    const states = (await db('nivaro_workflow_states')
      .where({ template: id })
      .select('*')) as WorkflowState[]
    const byKey = new Map(states.map((s) => [s.key, s]))
    const missing = [...body.branch_states, body.join_state].filter((k) => !byKey.has(k))
    if (missing.length > 0) {
      return reply.code(400).send({ error: `Unknown state keys: ${missing.join(', ')}` })
    }

    const groupLabel = `${SPLIT_PREFIX}${JSON.stringify({
      branches: body.branch_states,
      join: body.join_state
    })}`
    if (groupLabel.length > 255) {
      return reply.code(400).send({ error: 'Split config too large (group_label limit 255)' })
    }

    const joinId = (byKey.get(body.join_state) as WorkflowState).id
    const txId = randomUUID()
    await db('nivaro_workflow_transitions').insert({
      id: txId,
      template: id,
      from_state: joinId,
      to_state: joinId,
      label: body.label?.trim() || 'Parallel Split',
      color: null,
      required_roles: SPLIT_ROLE_SENTINEL,
      actions: null,
      sort: 999,
      group_label: groupLabel
    })

    await logActivity({
      action: 'create',
      collection: 'nivaro_workflow_transitions',
      item: txId,
      user: req.user?.id,
      req,
      comment: `split-config template:${id}`
    })
    return reply.code(201).send({
      data: {
        id: txId,
        label: body.label?.trim() || 'Parallel Split',
        branch_states: body.branch_states,
        join_state: body.join_state
      }
    })
  })

  app.delete('/templates/:id/splits/:splitId', { preHandler: requireAdmin }, async (req, reply) => {
    const { id, splitId } = req.params as { id: string; splitId: string }
    const row = (await db('nivaro_workflow_transitions')
      .where({ id: splitId, template: id })
      .first()) as WorkflowTransition | undefined
    if (!row || !isSplitConfigRow(row)) return reply.code(404).send({ error: 'Not found' })
    await db('nivaro_workflow_transitions').where({ id: splitId }).delete()
    await logActivity({
      action: 'delete',
      collection: 'nivaro_workflow_transitions',
      item: splitId,
      user: req.user?.id,
      req,
      comment: `split-config template:${id}`
    })
    return reply.code(204).send()
  })

  // ── Instance split (authenticated) ────────────────────────────────────────

  app.post('/instance/:id/split', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { branch_states?: string[]; join_state?: string }

    if (!Array.isArray(body?.branch_states) || body.branch_states.length < 2) {
      return reply.code(400).send({ error: 'branch_states requires at least 2 states' })
    }
    if (!body.join_state) return reply.code(400).send({ error: 'join_state is required' })

    const instance = (await db('nivaro_workflow_instances').where({ id }).first()) as
      | WorkflowInstance
      | undefined
    if (!instance) return reply.code(404).send({ error: 'Instance not found' })
    if (await instanceAccessDenied(req, instance, 'update')) {
      return reply.code(403).send({ error: 'You do not have permission to modify this record' })
    }
    if (instance.completed_at) {
      return reply.code(400).send({ error: 'Workflow is already completed' })
    }

    const existing = await getOpenSplit(id)
    if (existing) {
      return reply.code(409).send({ error: 'Instance already has active parallel branches' })
    }

    // Resolve states by id or key within the instance template.
    const states = (await db('nivaro_workflow_states')
      .where({ template: instance.template })
      .select('*')) as WorkflowState[]
    const resolve = (ref: string) => states.find((s) => s.id === ref || s.key === ref) ?? null

    const branchStates = body.branch_states.map(resolve)
    const joinState = resolve(body.join_state)
    if (branchStates.some((s) => !s) || !joinState) {
      return reply.code(400).send({ error: 'One or more states not found on this template' })
    }
    if (branchStates.some((s) => s?.id === joinState.id)) {
      return reply.code(400).send({ error: 'join_state cannot be one of the branch states' })
    }

    const now = new Date()
    const childIds: string[] = []
    for (const state of branchStates as WorkflowState[]) {
      const childId = randomUUID()
      childIds.push(childId)
      await db('nivaro_workflow_instances').insert({
        id: childId,
        template: instance.template,
        collection: instance.collection,
        item: instance.item,
        current_state: state.id,
        started_at: now,
        completed_at: coerceBool(state.is_terminal) ? now : null
      })
      await db('nivaro_workflow_history').insert({
        instance: childId,
        transition: null,
        from_state: null,
        to_state: state.id,
        user: req.user?.id ?? null,
        comment: JSON.stringify({ action: 'branch', parent: id }),
        timestamp: now
      })
    }

    // Record the split on the parent (children + join target encoded in comment JSON).
    await db('nivaro_workflow_history').insert({
      instance: id,
      transition: null,
      from_state: instance.current_state,
      to_state: instance.current_state ?? joinState.id,
      user: req.user?.id ?? null,
      comment: JSON.stringify({
        action: 'split',
        children: childIds,
        join_state: joinState.id
      } satisfies SplitRecord),
      timestamp: now
    })

    await logActivity({
      action: 'update',
      collection: 'nivaro_workflow_instances',
      item: id,
      user: req.user?.id,
      req,
      comment: `split into ${childIds.length} branches`
    })

    // Degenerate case: every branch state is terminal — join immediately.
    let joined = null
    if ((branchStates as WorkflowState[]).every((s) => coerceBool(s.is_terminal))) {
      joined = await checkJoin(childIds[0], req.user?.id ?? null)
    }

    return reply.code(201).send({
      data: {
        parent: id,
        children: childIds,
        join_state: formatStateLite(joinState),
        joined: !!joined
      }
    })
  })

  // ── Branch status (authenticated) ─────────────────────────────────────────

  app.get('/instance/:id/branches', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const instance = (await db('nivaro_workflow_instances').where({ id }).first()) as
      | WorkflowInstance
      | undefined
    if (!instance) return reply.code(404).send({ error: 'Instance not found' })
    if (await instanceAccessDenied(req, instance, 'read')) {
      return reply.code(403).send({ error: 'You do not have permission to read this record' })
    }

    const [states, transitions] = await Promise.all([
      db<WorkflowState>('nivaro_workflow_states')
        .where({ template: instance.template })
        .orderBy('sort')
        .select('*'),
      db<WorkflowTransition>('nivaro_workflow_transitions')
        .where({ template: instance.template })
        .orderBy('sort')
        .select('*')
    ])
    const stateById = new Map(states.map((s) => [s.id, s]))
    const stateByKey = new Map(states.map((s) => [s.key, s]))

    // Template-defined split configs (used for the Split affordance in the panel).
    const splitConfigs = transitions
      .filter(isSplitConfigRow)
      .map((tx) => {
        const cfg = parseSplitConfig(tx)
        if (!cfg) return null
        return {
          id: tx.id,
          label: tx.label,
          branch_states: cfg.branches
            .map((k) => stateByKey.get(k))
            .filter(Boolean)
            .map((s) => formatStateLite(s as WorkflowState)),
          join_state: stateByKey.has(cfg.join)
            ? formatStateLite(stateByKey.get(cfg.join) as WorkflowState)
            : null
        }
      })
      .filter((c) => c && c.branch_states.length >= 2 && c.join_state)

    const split = await getOpenSplit(id)
    if (!split) {
      return reply.send({
        data: {
          parent: instance,
          active: false,
          branches: [],
          join_state: null,
          waiting_on: 0,
          total: 0,
          split_configs: splitConfigs
        }
      })
    }

    const children = (await db('nivaro_workflow_instances')
      .whereIn('id', split.children)
      .select('*')) as WorkflowInstance[]
    // Preserve split order
    children.sort((a, b) => split.children.indexOf(a.id) - split.children.indexOf(b.id))

    const branches = children.map((child) => {
      const state = child.current_state ? (stateById.get(child.current_state) ?? null) : null
      const terminal = !!child.completed_at || (state ? coerceBool(state.is_terminal) : false)
      const available = terminal
        ? []
        : transitions
            .filter((tx) => !isSplitConfigRow(tx))
            .filter((tx) => tx.from_state === null || tx.from_state === child.current_state)
            .filter((tx) => transitionAllowed(tx, req))
            .map((tx) => ({
              id: tx.id,
              label: tx.label,
              color: tx.color,
              to_state: tx.to_state,
              group_label: tx.group_label
            }))
      return {
        instance_id: child.id,
        state: state ? formatStateLite(state) : null,
        terminal,
        available_transitions: available
      }
    })

    const joinState = stateById.get(split.join_state) ?? null
    const waitingOn = branches.filter((b) => !b.terminal).length

    return reply.send({
      data: {
        parent: instance,
        active: true,
        branches,
        join_state: joinState ? formatStateLite(joinState) : null,
        waiting_on: waitingOn,
        total: branches.length,
        split_configs: splitConfigs
      }
    })
  })

  // ── Transition a specific instance by id (used for branch children) ───────

  app.post('/instance/:id/transition', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { transition_id?: string; comment?: string }
    if (!body?.transition_id) return reply.code(400).send({ error: 'transition_id is required' })

    const instance = (await db('nivaro_workflow_instances').where({ id }).first()) as
      | WorkflowInstance
      | undefined
    if (!instance) return reply.code(404).send({ error: 'Instance not found' })
    if (await instanceAccessDenied(req, instance, 'update')) {
      return reply.code(403).send({ error: 'You do not have permission to modify this record' })
    }
    if (instance.completed_at) {
      return reply.code(400).send({ error: 'This branch is already completed' })
    }

    const transition = (await db('nivaro_workflow_transitions')
      .where({ id: body.transition_id, template: instance.template })
      .first()) as WorkflowTransition | undefined
    if (!transition || isSplitConfigRow(transition)) {
      return reply.code(404).send({ error: 'Transition not found' })
    }

    const fromOk =
      transition.from_state === null || transition.from_state === instance.current_state
    if (!fromOk) {
      return reply.code(400).send({ error: 'Transition is not valid from the current state' })
    }
    if (!transitionAllowed(transition, req)) {
      return reply.code(403).send({ error: 'You do not have permission for this transition' })
    }

    const newStateObj = (await db('nivaro_workflow_states')
      .where({ id: transition.to_state })
      .first()) as WorkflowState | undefined
    const isTerminal = newStateObj ? coerceBool(newStateObj.is_terminal) : false
    const now = new Date()

    await db('nivaro_workflow_instances')
      .where({ id })
      .update({
        current_state: transition.to_state,
        completed_at: isTerminal ? now : null
      })
    await db('nivaro_workflow_history').insert({
      instance: id,
      transition: transition.id,
      from_state: instance.current_state,
      to_state: transition.to_state,
      user: req.user?.id ?? null,
      comment: body.comment ?? null,
      timestamp: now
    })
    await logActivity({
      action: 'update',
      collection: 'nivaro_workflow_instances',
      item: id,
      user: req.user?.id,
      req,
      comment: `${instance.collection}:${instance.item}`
    })

    // If this branch just reached a terminal state, check whether the parent can join.
    let joined: Awaited<ReturnType<typeof checkJoin>> = null
    if (isTerminal) {
      try {
        joined = await checkJoin(id, req.user?.id ?? null)
      } catch (err) {
        app.log.error({ err, instance: id }, 'Workflow join check failed')
      }
    }

    const updated = await db('nivaro_workflow_instances').where({ id }).first()
    return reply.send({
      data: {
        instance: updated,
        new_state: newStateObj ? formatStateLite(newStateObj) : null,
        joined: !!joined,
        parent_state: joined ? formatStateLite(joined.joinState) : null
      }
    })
  })
}
