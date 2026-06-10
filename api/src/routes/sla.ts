import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'

interface SlaRule {
  id: number
  workflow_template: string
  state_key: string
  name: string
  duration_hours: number
  warning_threshold_pct: number
  business_hours_only: boolean
  notify_on_warning: boolean
  notify_on_breach: boolean
  escalation_user: string | null
  is_active: boolean
  created_at: Date
  updated_at: Date
  // joined
  template_name?: string
}

function formatRule(row: SlaRule): SlaRule {
  return {
    ...row,
    business_hours_only: !!row.business_hours_only,
    notify_on_warning: !!row.notify_on_warning,
    notify_on_breach: !!row.notify_on_breach,
    is_active: !!row.is_active
  }
}

function businessHoursElapsed(from: Date, to: Date): number {
  let hours = 0
  const current = new Date(from)
  while (current < to) {
    const day = current.getDay() // 0=Sun, 6=Sat
    const hour = current.getHours()
    if (day >= 1 && day <= 5 && hour >= 9 && hour < 17) {
      hours++
    }
    current.setHours(current.getHours() + 1)
  }
  return hours
}

async function computeStatus(collection: string, item: string) {
  // Find the current workflow instance for this collection+item
  const instance = await db('nivaro_workflow_instances')
    .where({ collection, item })
    .orderBy('started_at', 'desc')
    .first()

  if (!instance || !instance.current_state) {
    return { status: 'none' }
  }

  // Find active SLA rule for this workflow_template + state_key
  const rule = await db<SlaRule>('nivaro_sla_rules')
    .where({
      workflow_template: instance.template,
      state_key: instance.current_state,
      is_active: true
    })
    .first()

  if (!rule) {
    return { status: 'none' }
  }

  // Find when instance entered current state (most recent history entry for that state)
  const historyEntry = await db('nivaro_workflow_history')
    .where({ instance: instance.id, to_state: instance.current_state })
    .orderBy('created_at', 'desc')
    .first()

  if (!historyEntry) {
    return { status: 'none' }
  }

  const enteredAt = new Date(historyEntry.created_at)
  const now = new Date()

  const elapsedHours = rule.business_hours_only
    ? businessHoursElapsed(enteredAt, now)
    : (now.getTime() - enteredAt.getTime()) / (1000 * 60 * 60)

  const pctUsed = (elapsedHours / rule.duration_hours) * 100
  const status =
    pctUsed >= 100 ? 'breached' : pctUsed >= rule.warning_threshold_pct ? 'warning' : 'on_track'

  return {
    status,
    state_key: instance.current_state,
    sla_rule: formatRule(rule),
    entered_at: enteredAt,
    elapsed_hours: elapsedHours,
    total_hours: rule.duration_hours,
    pct_used: pctUsed,
    collection,
    item
  }
}

const BATCH_CAP = 500

export interface SlaBatchEntry {
  state_key: string
  elapsed_hours: number
  duration_hours: number
  warning_threshold_pct: number
  status: 'ok' | 'warning' | 'breached'
  remaining_hours: number
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/**
 * Batch SLA status for many items in one collection. Same logic as
 * computeStatus() but resolved with three set-based queries instead of
 * three queries per item. Items without an instance, state, active rule,
 * or history entry are omitted from the result map.
 */
async function computeStatusBatch(
  collection: string,
  ids: string[]
): Promise<Record<string, SlaBatchEntry>> {
  const out: Record<string, SlaBatchEntry> = {}
  if (ids.length === 0) return out

  // Latest workflow instance per item
  const instances = await db('nivaro_workflow_instances')
    .where({ collection })
    .whereIn('item', ids)
    .orderBy('started_at', 'desc')

  const latestByItem = new Map<string, (typeof instances)[number]>()
  for (const inst of instances) {
    const key = String(inst.item)
    if (!latestByItem.has(key)) latestByItem.set(key, inst)
  }

  const candidates = [...latestByItem.values()].filter((i) => i.current_state)
  if (candidates.length === 0) return out

  // Active SLA rules for the involved templates
  const templates = [...new Set(candidates.map((i) => String(i.template)))]
  const rules = await db<SlaRule>('nivaro_sla_rules')
    .where({ is_active: true })
    .whereIn('workflow_template', templates)

  const ruleFor = (template: unknown, state: unknown) =>
    rules.find(
      (r) => String(r.workflow_template) === String(template) && r.state_key === String(state)
    )

  const withRules = candidates.filter((i) => ruleFor(i.template, i.current_state))
  if (withRules.length === 0) return out

  // Most recent entry into the current state, per instance
  const history = await db('nivaro_workflow_history')
    .whereIn(
      'instance',
      withRules.map((i) => i.id)
    )
    .orderBy('created_at', 'desc')

  const enteredAt = new Map<string, Date>()
  for (const h of history) {
    const key = `${h.instance}::${h.to_state}`
    if (!enteredAt.has(key)) enteredAt.set(key, new Date(h.created_at))
  }

  const now = new Date()
  for (const inst of withRules) {
    const rule = ruleFor(inst.template, inst.current_state)!
    const entered = enteredAt.get(`${inst.id}::${inst.current_state}`)
    if (!entered) continue

    const elapsedHours = rule.business_hours_only
      ? businessHoursElapsed(entered, now)
      : (now.getTime() - entered.getTime()) / (1000 * 60 * 60)

    const pctUsed = (elapsedHours / rule.duration_hours) * 100
    const status: SlaBatchEntry['status'] =
      pctUsed >= 100 ? 'breached' : pctUsed >= rule.warning_threshold_pct ? 'warning' : 'ok'

    out[String(inst.item)] = {
      state_key: String(inst.current_state),
      elapsed_hours: round1(elapsedHours),
      duration_hours: rule.duration_hours,
      warning_threshold_pct: rule.warning_threshold_pct,
      status,
      remaining_hours: round1(rule.duration_hours - elapsedHours)
    }
  }

  return out
}

export async function slaRoutes(app: FastifyInstance) {
  // ─── Admin CRUD ──────────────────────────────────────────────────────────────

  // GET /sla/rules — list all SLA rules, optional ?workflow= filter
  app.get('/rules', { preHandler: requireAdmin }, async (req, reply) => {
    const { workflow } = req.query as { workflow?: string }

    let query = db<SlaRule>('nivaro_sla_rules as s')
      .leftJoin('nivaro_workflow_templates as t', 's.workflow_template', 't.id')
      .select('s.*', 't.name as template_name')
      .orderBy('s.id')

    if (workflow) {
      query = query.where('s.workflow_template', workflow)
    }

    const rows = await query
    return reply.send({ data: rows.map(formatRule) })
  })

  // GET /sla/rules/:id — get one rule
  app.get('/rules/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }

    const row = await db<SlaRule>('nivaro_sla_rules as s')
      .leftJoin('nivaro_workflow_templates as t', 's.workflow_template', 't.id')
      .select('s.*', 't.name as template_name')
      .where('s.id', id)
      .first()

    if (!row) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data: formatRule(row) })
  })

  // POST /sla/rules — create rule
  app.post('/rules', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as {
      workflow_template: string
      state_key: string
      name: string
      duration_hours: number
      warning_threshold_pct?: number
      business_hours_only?: boolean
      notify_on_warning?: boolean
      notify_on_breach?: boolean
      escalation_user?: string | null
      is_active?: boolean
    }

    if (!body.workflow_template || !body.state_key || !body.name || !body.duration_hours) {
      return reply
        .code(400)
        .send({ error: 'workflow_template, state_key, name, and duration_hours are required' })
    }

    const now = new Date()
    const [row] = await db('nivaro_sla_rules')
      .insert({
        workflow_template: body.workflow_template,
        state_key: body.state_key,
        name: body.name,
        duration_hours: body.duration_hours,
        warning_threshold_pct: body.warning_threshold_pct ?? 80,
        business_hours_only: body.business_hours_only ? 1 : 0,
        notify_on_warning: body.notify_on_warning !== false ? 1 : 0,
        notify_on_breach: body.notify_on_breach !== false ? 1 : 0,
        escalation_user: body.escalation_user ?? null,
        is_active: body.is_active !== false ? 1 : 0,
        created_at: now,
        updated_at: now
      })
      .returning('id')

    const insertedId = typeof row === 'object' ? row.id : row
    const created = await db<SlaRule>('nivaro_sla_rules').where({ id: insertedId }).first()

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_sla_rules',
      item: String(insertedId),
      req
    })

    return reply.code(201).send({ data: formatRule(created!) })
  })

  // PATCH /sla/rules/:id — update rule
  app.patch('/rules/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db<SlaRule>('nivaro_sla_rules').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const body = req.body as Partial<{
      workflow_template: string
      state_key: string
      name: string
      duration_hours: number
      warning_threshold_pct: number
      business_hours_only: boolean
      notify_on_warning: boolean
      notify_on_breach: boolean
      escalation_user: string | null
      is_active: boolean
    }>

    const patch: Record<string, unknown> = { updated_at: new Date() }
    if (body.workflow_template !== undefined) patch.workflow_template = body.workflow_template
    if (body.state_key !== undefined) patch.state_key = body.state_key
    if (body.name !== undefined) patch.name = body.name
    if (body.duration_hours !== undefined) patch.duration_hours = body.duration_hours
    if (body.warning_threshold_pct !== undefined)
      patch.warning_threshold_pct = body.warning_threshold_pct
    if (body.business_hours_only !== undefined)
      patch.business_hours_only = body.business_hours_only ? 1 : 0
    if (body.notify_on_warning !== undefined)
      patch.notify_on_warning = body.notify_on_warning ? 1 : 0
    if (body.notify_on_breach !== undefined) patch.notify_on_breach = body.notify_on_breach ? 1 : 0
    if ('escalation_user' in body) patch.escalation_user = body.escalation_user ?? null
    if (body.is_active !== undefined) patch.is_active = body.is_active ? 1 : 0

    await db('nivaro_sla_rules').where({ id }).update(patch)
    const updated = await db<SlaRule>('nivaro_sla_rules').where({ id }).first()

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_sla_rules',
      item: id,
      req
    })

    return reply.send({ data: formatRule(updated!) })
  })

  // DELETE /sla/rules/:id — delete rule
  app.delete('/rules/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db<SlaRule>('nivaro_sla_rules').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    await db('nivaro_sla_rules').where({ id }).delete()
    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_sla_rules',
      item: id,
      req
    })

    return reply.code(204).send()
  })

  // ─── Status endpoints (requireAuth — non-admin can see SLA status) ───────────

  // GET /sla/status/:collection/:item — compute SLA status for a specific record
  app.get('/status/:collection/:item', { preHandler: requireAuth }, async (req, reply) => {
    const { collection, item } = req.params as { collection: string; item: string }
    const result = await computeStatus(collection, item)
    return reply.send(result)
  })

  // GET /sla/status?collection=X&items=id1,id2,id3 — batch status
  app.get('/status', { preHandler: requireAuth }, async (req, reply) => {
    const { collection, items } = req.query as { collection?: string; items?: string }

    if (!collection || !items) {
      return reply.code(400).send({ error: 'collection and items query params are required' })
    }

    const ids = items
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const results = await Promise.all(ids.map((id) => computeStatus(collection, id)))
    return reply.send({ data: results })
  })

  // POST /sla/status/batch — { collection, ids[] } →
  // { data: { [id]: { state_key, elapsed_hours, duration_hours,
  //                   warning_threshold_pct, status, remaining_hours } } }
  // Items without an active SLA are omitted — empty map means "no SLA data".
  app.post('/status/batch', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as { collection?: string; ids?: unknown }

    if (!body.collection || typeof body.collection !== 'string' || !Array.isArray(body.ids)) {
      return reply.code(400).send({ error: 'collection and ids[] are required' })
    }

    const allowed = await can(req.user!, 'read', body.collection)
    if (!allowed) return reply.code(403).send({ error: 'Forbidden' })

    const ids = body.ids
      .slice(0, BATCH_CAP)
      .map((v) => String(v))
      .filter(Boolean)

    const data = await computeStatusBatch(body.collection, ids)
    return reply.send({ data })
  })
}
