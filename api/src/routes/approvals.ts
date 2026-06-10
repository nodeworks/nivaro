import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { notifyUser } from '../services/notification-channels.js'
import { can } from '../services/permissions.js'
import type { User } from '../types.js'

interface ApprovalChain {
  id: number
  name: string
  collection: string | null
  workflow_template: string | null
  state_key: string | null
  is_active: boolean
  created_at: Date
}

interface ApprovalChainStep {
  id: number
  chain: number
  step_order: number
  approver: string | null
  approver_role: string | null
  label: string | null
}

interface ApprovalInstance {
  id: number
  chain: number
  collection: string
  item: string
  current_step: number
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  started_by: string
  created_at: Date
}

interface StepInput {
  step_order?: number
  approver?: string | null
  approver_role?: string | null
  label?: string | null
}

function formatChain(chain: ApprovalChain, steps: ApprovalChainStep[]) {
  return {
    ...chain,
    is_active: !!chain.is_active,
    steps: steps.filter((s) => s.chain === chain.id).sort((a, b) => a.step_order - b.step_order)
  }
}

async function getOrderedSteps(chainId: number): Promise<ApprovalChainStep[]> {
  return (await db('nivaro_approval_chain_steps')
    .where({ chain: chainId })
    .orderBy('step_order', 'asc')) as ApprovalChainStep[]
}

/** Resolve the users who may decide a step: direct approver, or everyone holding the role. */
async function resolveStepApprovers(step: ApprovalChainStep): Promise<string[]> {
  if (step.approver) return [step.approver]
  if (step.approver_role) {
    const users = (await db('nivaro_users')
      .where({ role: step.approver_role, status: 'active' })
      .select('id')) as Array<{ id: string }>
    return users.map((u) => u.id)
  }
  return []
}

async function isStepApprover(step: ApprovalChainStep, user: User, isAdmin: boolean) {
  if (isAdmin) return true
  if (step.approver && step.approver === user.id) return true
  if (step.approver_role && user.role === step.approver_role) return true
  return false
}

/** Notify all approvers of a step (in-app + email) and post a Teams action card when configured. */
async function notifyStepApprovers(
  app: FastifyInstance,
  instance: ApprovalInstance,
  chain: ApprovalChain,
  step: ApprovalChainStep,
  actorId: string | null
): Promise<void> {
  const approvers = await resolveStepApprovers(step)
  const stepLabel = step.label ?? `Step ${step.step_order + 1}`
  for (const userId of approvers) {
    await notifyUser(app, userId, {
      subject: `Approval requested: ${chain.name}`,
      message: `Your approval (${stepLabel}) is requested for ${instance.collection}/${instance.item}.`,
      collection: instance.collection,
      item: instance.item,
      sender: actorId,
      channels: { inapp: true, email: true }
    })
  }

  // Teams action card — only when an incoming webhook is configured in settings.
  // Lazy import breaks the approvals ↔ message-actions circular dependency.
  try {
    const { sendApprovalCard } = await import('./message-actions.js')
    await sendApprovalCard({
      instance,
      chainName: chain.name,
      stepLabel,
      // Approve/Reject buttons can only be signed for a known user (direct approver)
      approverUserId: step.approver ?? null
    })
  } catch (err) {
    console.warn('[approvals] Teams card failed:', err)
  }
}

export interface DecideResult {
  ok: boolean
  status?: number
  error?: string
  instance?: ApprovalInstance
}

/**
 * Shared approve/reject logic — used by POST /approvals/instances/:id/decide and
 * by the signed Teams/Slack message-action callback.
 */
export async function applyApprovalDecision(opts: {
  app: FastifyInstance
  instanceId: number
  user: User
  isAdmin: boolean
  decision: 'approved' | 'rejected'
  comment?: string | null
}): Promise<DecideResult> {
  const { app, instanceId, user, isAdmin, decision, comment } = opts

  const instance = (await db('nivaro_approval_instances').where({ id: instanceId }).first()) as
    | ApprovalInstance
    | undefined
  if (!instance) return { ok: false, status: 404, error: 'Instance not found' }
  if (instance.status !== 'pending') {
    return { ok: false, status: 409, error: `Instance is already ${instance.status}` }
  }

  const chain = (await db('nivaro_approval_chains').where({ id: instance.chain }).first()) as
    | ApprovalChain
    | undefined
  if (!chain) return { ok: false, status: 404, error: 'Chain not found' }

  const steps = await getOrderedSteps(chain.id)
  const currentStep = steps.find((s) => s.step_order === instance.current_step)
  if (!currentStep) return { ok: false, status: 409, error: 'Current step not found' }

  if (!(await isStepApprover(currentStep, user, isAdmin))) {
    return { ok: false, status: 403, error: 'You are not an approver for the current step' }
  }

  // Guard against double-deciding the same step by the same user
  const already = await db('nivaro_approval_decisions')
    .where({ instance: instance.id, step_order: instance.current_step, user: user.id })
    .first()
  if (already) return { ok: false, status: 409, error: 'You already decided this step' }

  await db('nivaro_approval_decisions').insert({
    instance: instance.id,
    step_order: instance.current_step,
    user: user.id,
    decision,
    comment: comment ?? null,
    decided_at: new Date()
  })

  const itemRef = `${instance.collection}/${instance.item}`

  if (decision === 'rejected') {
    await db('nivaro_approval_instances').where({ id: instance.id }).update({ status: 'rejected' })
    await notifyUser(app, instance.started_by, {
      subject: `Approval rejected: ${chain.name}`,
      message: `Your approval request for ${itemRef} was rejected${comment ? `: ${comment}` : '.'}`,
      collection: instance.collection,
      item: instance.item,
      sender: user.id,
      channels: { inapp: true, email: true }
    })
    const updated = (await db('nivaro_approval_instances')
      .where({ id: instance.id })
      .first()) as ApprovalInstance
    return { ok: true, instance: updated }
  }

  // Approved — advance sequentially or finish
  const idx = steps.findIndex((s) => s.step_order === instance.current_step)
  const nextStep = steps[idx + 1]

  if (!nextStep) {
    await db('nivaro_approval_instances').where({ id: instance.id }).update({ status: 'approved' })
    await notifyUser(app, instance.started_by, {
      subject: `Approval completed: ${chain.name}`,
      message: `Your approval request for ${itemRef} was fully approved.`,
      collection: instance.collection,
      item: instance.item,
      sender: user.id,
      channels: { inapp: true, email: true }
    })
  } else {
    await db('nivaro_approval_instances')
      .where({ id: instance.id })
      .update({ current_step: nextStep.step_order })
    const advanced = (await db('nivaro_approval_instances')
      .where({ id: instance.id })
      .first()) as ApprovalInstance
    // Sequential strictly: the next approver is only notified now
    await notifyStepApprovers(app, advanced, chain, nextStep, user.id)
  }

  const updated = (await db('nivaro_approval_instances')
    .where({ id: instance.id })
    .first()) as ApprovalInstance
  return { ok: true, instance: updated }
}

export async function approvalsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // ── Chains CRUD (admin) ────────────────────────────────────────────────────

  app.get('/chains', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
    const chains = (await db('nivaro_approval_chains').orderBy('name')) as ApprovalChain[]
    const steps = (await db('nivaro_approval_chain_steps').orderBy(
      'step_order'
    )) as ApprovalChainStep[]
    return reply.send({ data: chains.map((c) => formatChain(c, steps)) })
  })

  app.get<{ Params: { id: string } }>('/chains/:id', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
    const chain = (await db('nivaro_approval_chains')
      .where({ id: Number(req.params.id) })
      .first()) as ApprovalChain | undefined
    if (!chain) return reply.code(404).send({ error: 'Not found' })
    const steps = await getOrderedSteps(chain.id)
    return reply.send({ data: formatChain(chain, steps) })
  })

  app.post<{
    Body: {
      name?: string
      collection?: string | null
      workflow_template?: string | null
      state_key?: string | null
      is_active?: boolean
      steps?: StepInput[]
    }
  }>('/chains', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
    const {
      name,
      collection,
      workflow_template,
      state_key,
      is_active = true,
      steps = []
    } = req.body ?? {}
    if (!name) return reply.code(400).send({ error: 'name is required' })
    for (const s of steps) {
      if (!s.approver && !s.approver_role) {
        return reply.code(400).send({ error: 'Each step needs an approver or approver_role' })
      }
    }

    const [chain] = (await db('nivaro_approval_chains')
      .insert({
        name,
        collection: collection ?? null,
        workflow_template: workflow_template ?? null,
        state_key: state_key ?? null,
        is_active,
        created_at: new Date()
      })
      .returning('*')) as unknown as [ApprovalChain]

    if (steps.length) {
      await db('nivaro_approval_chain_steps').insert(
        steps.map((s, i) => ({
          chain: chain.id,
          step_order: s.step_order ?? i,
          approver: s.approver ?? null,
          approver_role: s.approver_role ?? null,
          label: s.label ?? null
        }))
      )
    }

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_approval_chains',
      item: String(chain.id),
      req
    })

    return reply.code(201).send({ data: formatChain(chain, await getOrderedSteps(chain.id)) })
  })

  app.patch<{
    Params: { id: string }
    Body: {
      name?: string
      collection?: string | null
      workflow_template?: string | null
      state_key?: string | null
      is_active?: boolean
      steps?: StepInput[]
    }
  }>('/chains/:id', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
    const id = Number(req.params.id)
    const existing = (await db('nivaro_approval_chains').where({ id }).first()) as
      | ApprovalChain
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const body = req.body ?? {}
    const allowed = ['name', 'collection', 'workflow_template', 'state_key', 'is_active']
    const patch = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)))
    if (Object.keys(patch).length) {
      await db('nivaro_approval_chains').where({ id }).update(patch)
    }

    // Replace-all steps strategy
    if (Array.isArray(body.steps)) {
      for (const s of body.steps) {
        if (!s.approver && !s.approver_role) {
          return reply.code(400).send({ error: 'Each step needs an approver or approver_role' })
        }
      }
      await db('nivaro_approval_chain_steps').where({ chain: id }).delete()
      if (body.steps.length) {
        await db('nivaro_approval_chain_steps').insert(
          body.steps.map((s, i) => ({
            chain: id,
            step_order: s.step_order ?? i,
            approver: s.approver ?? null,
            approver_role: s.approver_role ?? null,
            label: s.label ?? null
          }))
        )
      }
    }

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_approval_chains',
      item: String(id),
      req
    })

    const updated = (await db('nivaro_approval_chains').where({ id }).first()) as ApprovalChain
    return reply.send({ data: formatChain(updated, await getOrderedSteps(id)) })
  })

  app.delete<{ Params: { id: string } }>('/chains/:id', async (req, reply) => {
    if (!req.isAdmin) return reply.code(403).send({ error: 'Forbidden' })
    const id = Number(req.params.id)
    const existing = (await db('nivaro_approval_chains').where({ id }).first()) as
      | ApprovalChain
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const instanceCount = await db('nivaro_approval_instances')
      .where({ chain: id })
      .count<{ count: string | number }>({ count: '*' })
      .first()
    if (Number(instanceCount?.count ?? 0) > 0) {
      return reply.code(409).send({ error: 'Chain has approval instances and cannot be deleted' })
    }

    await db('nivaro_approval_chain_steps').where({ chain: id }).delete()
    await db('nivaro_approval_chains').where({ id }).delete()

    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_approval_chains',
      item: String(id),
      req
    })

    return reply.code(204).send()
  })

  // ── Instances ─────────────────────────────────────────────────────────────

  // POST /start — begin an approval on a record
  app.post<{ Body: { chain_id?: number; collection?: string; item?: string } }>(
    '/start',
    async (req, reply) => {
      const { chain_id, collection, item } = req.body ?? {}
      if (!chain_id || !collection || item == null || item === '') {
        return reply.code(400).send({ error: 'chain_id, collection, and item are required' })
      }
      if (!(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      const chain = (await db('nivaro_approval_chains')
        .where({ id: Number(chain_id) })
        .first()) as ApprovalChain | undefined
      if (!chain) return reply.code(404).send({ error: 'Chain not found' })
      if (!chain.is_active) return reply.code(400).send({ error: 'Chain is not active' })
      if (chain.collection && chain.collection !== collection) {
        return reply.code(400).send({ error: `Chain is configured for ${chain.collection}` })
      }

      const steps = await getOrderedSteps(chain.id)
      if (!steps.length) return reply.code(400).send({ error: 'Chain has no steps' })

      const existing = await db('nivaro_approval_instances')
        .where({ chain: chain.id, collection, item: String(item), status: 'pending' })
        .first()
      if (existing) {
        return reply.code(409).send({ error: 'A pending approval already exists for this item' })
      }

      const [instance] = (await db('nivaro_approval_instances')
        .insert({
          chain: chain.id,
          collection,
          item: String(item),
          current_step: steps[0].step_order,
          status: 'pending',
          started_by: req.user!.id,
          created_at: new Date()
        })
        .returning('*')) as unknown as [ApprovalInstance]

      await logActivity({
        action: 'create',
        user: req.user?.id,
        collection: 'nivaro_approval_instances',
        item: String(instance.id),
        req
      })

      // Only the first step's approver(s) are notified — strictly sequential
      await notifyStepApprovers(app, instance, chain, steps[0], req.user!.id)

      return reply.code(201).send({ data: instance })
    }
  )

  // POST /instances/:id/decide — approve or reject the current step
  app.post<{ Params: { id: string }; Body: { decision?: string; comment?: string | null } }>(
    '/instances/:id/decide',
    async (req, reply) => {
      const { decision, comment } = req.body ?? {}
      if (decision !== 'approved' && decision !== 'rejected') {
        return reply.code(400).send({ error: "decision must be 'approved' or 'rejected'" })
      }

      const result = await applyApprovalDecision({
        app,
        instanceId: Number(req.params.id),
        user: req.user!,
        isAdmin: !!req.isAdmin,
        decision,
        comment
      })

      if (!result.ok) {
        return reply.code(result.status ?? 400).send({ error: result.error })
      }

      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection: 'nivaro_approval_instances',
        item: req.params.id,
        req
      })

      return reply.send({ data: result.instance })
    }
  )

  // GET /instances?collection=&item= — instances + decisions + chain/step labels
  app.get<{ Querystring: { collection?: string; item?: string; status?: string } }>(
    '/instances',
    async (req, reply) => {
      const { collection, item, status } = req.query

      let query = db('nivaro_approval_instances as i')
        .join('nivaro_approval_chains as ch', 'i.chain', 'ch.id')
        .leftJoin('nivaro_users as su', 'i.started_by', 'su.id')
        .select(
          'i.*',
          'ch.name as chain_name',
          'su.first_name as starter_first',
          'su.last_name as starter_last'
        )
        .orderBy('i.created_at', 'desc')
      if (collection) query = query.where('i.collection', collection)
      if (item) query = query.where('i.item', String(item))
      if (status) query = query.where('i.status', status)

      const instances = (await query) as Array<ApprovalInstance & Record<string, unknown>>
      if (!instances.length) return reply.send({ data: [] })

      const instanceIds = instances.map((i) => i.id)
      const chainIds = [...new Set(instances.map((i) => i.chain))]

      const decisions = (await db('nivaro_approval_decisions as d')
        .leftJoin('nivaro_users as u', 'd.user', 'u.id')
        .whereIn('d.instance', instanceIds)
        .select('d.*', 'u.first_name', 'u.last_name')
        .orderBy('d.decided_at', 'asc')) as Array<Record<string, unknown>>

      const steps = (await db('nivaro_approval_chain_steps as s')
        .leftJoin('nivaro_users as u', 's.approver', 'u.id')
        .leftJoin('nivaro_roles as r', 's.approver_role', 'r.id')
        .whereIn('s.chain', chainIds)
        .select(
          's.*',
          'u.first_name as approver_first',
          'u.last_name as approver_last',
          'r.name as approver_role_name'
        )
        .orderBy('s.step_order', 'asc')) as Array<ApprovalChainStep & Record<string, unknown>>

      const data = instances.map((inst) => ({
        ...inst,
        started_by_name: [inst.starter_first, inst.starter_last].filter(Boolean).join(' ') || null,
        starter_first: undefined,
        starter_last: undefined,
        steps: steps
          .filter((s) => s.chain === inst.chain)
          .map((s) => ({
            ...s,
            approver_name: [s.approver_first, s.approver_last].filter(Boolean).join(' ') || null,
            approver_first: undefined,
            approver_last: undefined
          })),
        decisions: decisions
          .filter((d) => d.instance === inst.id)
          .map((d) => ({
            ...d,
            user_name: [d.first_name, d.last_name].filter(Boolean).join(' ') || null,
            first_name: undefined,
            last_name: undefined
          }))
      }))

      return reply.send({ data })
    }
  )
}
