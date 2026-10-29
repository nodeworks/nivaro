import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  buildWakeBody,
  type DeliveryRow,
  discardDelivery,
  retryDelivery,
  sendTestWakeUp
} from '../services/agent-trigger-delivery.js'
import {
  AGENT_TRIGGER_CONDITION_OPS,
  AGENT_TRIGGER_EVENTS,
  AgentTriggerInputError,
  type AgentTriggerRow,
  agentTriggersReady,
  assertUsableOwner,
  bustAgentTriggerCache,
  MAX_ATTEMPTS_CAP,
  maskTrigger,
  normalizeTriggerInput,
  type TriggerInput
} from '../services/agent-triggers.js'
import { maskBodySecrets } from '../services/secret-mask.js'

/**
 * Agent triggers (#3210), under /api/agent-triggers — administrators only.
 *
 *   GET    /                       {ready, triggers (masked) + 7-day delivery counts, events, ops}
 *   POST   /                       create
 *   GET    /:id   PATCH /:id   DELETE /:id (its deliveries go with it)
 *   POST   /:id/test               a signed test ping to the endpoint (no record)
 *   POST   /:id/preview {item}     the body a wake-up for that record would carry (nothing sent)
 *   GET    /deliveries             ?trigger=&status=&limit= — the delivery log; status=dead = dead letters
 *   GET    /deliveries/:id         one delivery with its body and the endpoint's answer
 *   POST   /deliveries/:id/retry   send a dead (or waiting) delivery once more, now
 *   POST   /deliveries/:id/discard drop a dead or waiting delivery
 *
 * Writes are refused to MCP tool calls and connected apps (OAUTH_NO_WRITE): an agent must not
 * point a trigger, which carries record data and a secret, at itself.
 */

const DELIVERY_STATUSES = ['sending', 'retrying', 'delivered', 'dead', 'discarded', 'skipped']

function notReady(reply: FastifyReply) {
  return reply.code(409).send({
    error: 'Agent triggers need database migration 510.',
    code: 'NOT_READY'
  })
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof AgentTriggerInputError) return reply.code(400).send({ error: err.message })
  const e = err as { statusCode?: number; message?: string }
  if (e?.statusCode && e.statusCode < 500)
    return reply.code(e.statusCode).send({ error: e.message ?? 'Refused' })
  throw err
}

function refuseAgent(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.mcpInner) {
    reply.code(403).send({ error: 'An assistant cannot change agent triggers' })
    return true
  }
  return false
}

async function withOwnerNames(rows: AgentTriggerRow[]) {
  const ids = [...new Set(rows.map((r) => String(r.owner)))]
  const people = ids.length
    ? ((await db('nivaro_users')
        .whereIn('id', ids)
        .select('id', 'first_name', 'last_name', 'email')) as Array<{
        id: string
        first_name: string | null
        last_name: string | null
        email: string | null
      }>)
    : []
  const name = new Map(
    people.map((p) => [
      String(p.id).toLowerCase(),
      [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email || null
    ])
  )
  return rows.map((r) => ({ ...r, owner_name: name.get(String(r.owner).toLowerCase()) ?? null }))
}

async function deliveryCounts(): Promise<
  Map<number, { delivered: number; dead: number; retrying: number; skipped: number }>
> {
  const since = new Date(Date.now() - 7 * 86_400_000)
  const rows = (await db('nivaro_agent_trigger_deliveries')
    .where('created_at', '>=', since)
    .groupBy('trigger_id', 'status')
    .select('trigger_id', 'status')
    .count('* as n')
    .catch(() => [])) as Array<{ trigger_id: number; status: string; n: number | string }>
  const out = new Map<
    number,
    { delivered: number; dead: number; retrying: number; skipped: number }
  >()
  for (const r of rows) {
    const id = Number(r.trigger_id)
    const c = out.get(id) ?? { delivered: 0, dead: 0, retrying: 0, skipped: 0 }
    if (r.status === 'delivered') c.delivered += Number(r.n)
    else if (r.status === 'dead') c.dead += Number(r.n)
    else if (r.status === 'retrying' || r.status === 'sending') c.retrying += Number(r.n)
    else if (r.status === 'skipped') c.skipped += Number(r.n)
    out.set(id, c)
  }
  return out
}

/** A delivery for the log: the body's secrets masked, the record kept (admins only read it). */
function deliveryView(d: DeliveryRow, full: boolean) {
  const base = {
    id: Number(d.id),
    trigger_id: Number(d.trigger_id),
    delivery_id: d.delivery_key,
    event: d.event,
    collection: d.collection,
    item: d.item,
    status: d.status,
    attempts: d.attempts,
    max_attempts: d.max_attempts,
    next_attempt_at: d.next_attempt_at,
    last_status_code: d.last_status_code,
    last_error: d.last_error,
    latency_ms: d.latency_ms,
    delivered_at: d.delivered_at,
    created_at: d.created_at,
    updated_at: d.updated_at
  }
  if (!full) return base
  return {
    ...base,
    request_body: maskBodySecrets(d.request_body),
    response_body: maskBodySecrets(d.response_body)
  }
}

export async function agentTriggerRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async () => {
    const ready = await agentTriggersReady()
    const meta = {
      events: AGENT_TRIGGER_EVENTS,
      ops: AGENT_TRIGGER_CONDITION_OPS,
      max_attempts_cap: MAX_ATTEMPTS_CAP
    }
    if (!ready) return { data: { ready, triggers: [], ...meta } }
    const rows = (await db('nivaro_agent_triggers').orderBy('name', 'asc')) as AgentTriggerRow[]
    const counts = await deliveryCounts()
    const triggers = (await withOwnerNames(rows)).map((r) => ({
      ...maskTrigger(r),
      last_7_days: counts.get(Number(r.id)) ?? { delivered: 0, dead: 0, retrying: 0, skipped: 0 }
    }))
    return { data: { ready, triggers, ...meta } }
  })

  app.post<{ Body: TriggerInput }>('/', async (req, reply) => {
    if (refuseAgent(req, reply)) return
    if (!(await agentTriggersReady())) return notReady(reply)
    try {
      const body = req.body ?? {}
      const cols = normalizeTriggerInput(body)
      const owner = String(cols.owner ?? req.user!.id)
      await assertUsableOwner(owner)
      const now = new Date()
      await db('nivaro_agent_triggers').insert({
        enabled: true,
        ...cols,
        owner,
        created_by: req.user!.id,
        created_at: now,
        updated_at: now
      })
      const row = (await db('nivaro_agent_triggers')
        .where({ name: cols.name, created_by: req.user!.id })
        .orderBy('id', 'desc')
        .first()) as AgentTriggerRow
      bustAgentTriggerCache()
      await logActivity({
        action: 'agent-trigger-create',
        user: req.user!.id,
        collection: 'nivaro_agent_triggers',
        item: String(row.id),
        comment: `${row.name} → ${new URL(row.url).host}`,
        req
      })
      return reply.code(201).send({ data: maskTrigger((await withOwnerNames([row]))[0]) })
    } catch (err) {
      return sendError(reply, err)
    }
  })

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    if (!(await agentTriggersReady())) return notReady(reply)
    const row = (await db('nivaro_agent_triggers')
      .where({ id: Number(req.params.id) })
      .first()) as AgentTriggerRow | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return { data: maskTrigger((await withOwnerNames([row]))[0]) }
  })

  app.patch<{ Params: { id: string }; Body: TriggerInput }>('/:id', async (req, reply) => {
    if (refuseAgent(req, reply)) return
    if (!(await agentTriggersReady())) return notReady(reply)
    const id = Number(req.params.id)
    const existing = (await db('nivaro_agent_triggers').where({ id }).first()) as
      | AgentTriggerRow
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    try {
      const cols = normalizeTriggerInput(req.body ?? {}, existing)
      if (cols.owner) await assertUsableOwner(String(cols.owner))
      await db('nivaro_agent_triggers')
        .where({ id })
        .update({ ...cols, updated_at: new Date() })
      bustAgentTriggerCache()
      const row = (await db('nivaro_agent_triggers').where({ id }).first()) as AgentTriggerRow
      const changed = Object.keys(cols).filter((k) => k !== 'signing_secret' && k !== 'headers')
      if (cols.signing_secret !== undefined) changed.push('secret')
      if (cols.headers !== undefined) changed.push('headers')
      await logActivity({
        action: 'agent-trigger-update',
        user: req.user!.id,
        collection: 'nivaro_agent_triggers',
        item: String(id),
        comment: `${row.name}: ${changed.join(', ') || 'no change'}`,
        req
      })
      return { data: maskTrigger((await withOwnerNames([row]))[0]) }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    if (refuseAgent(req, reply)) return
    if (!(await agentTriggersReady())) return notReady(reply)
    const id = Number(req.params.id)
    const row = (await db('nivaro_agent_triggers').where({ id }).first()) as
      | AgentTriggerRow
      | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    await db('nivaro_agent_trigger_deliveries').where({ trigger_id: id }).delete()
    await db('nivaro_agent_triggers').where({ id }).delete()
    bustAgentTriggerCache()
    await logActivity({
      action: 'agent-trigger-delete',
      user: req.user!.id,
      collection: 'nivaro_agent_triggers',
      item: String(id),
      comment: row.name,
      req
    })
    return reply.code(204).send()
  })

  app.post<{ Params: { id: string } }>('/:id/test', async (req, reply) => {
    if (refuseAgent(req, reply)) return
    if (!(await agentTriggersReady())) return notReady(reply)
    const row = (await db('nivaro_agent_triggers')
      .where({ id: Number(req.params.id) })
      .first()) as AgentTriggerRow | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    const d = await sendTestWakeUp(row)
    return { data: d ? deliveryView(d, true) : null }
  })

  app.post<{ Params: { id: string }; Body: { item?: string | number } }>(
    '/:id/preview',
    async (req, reply) => {
      if (!(await agentTriggersReady())) return notReady(reply)
      const row = (await db('nivaro_agent_triggers')
        .where({ id: Number(req.params.id) })
        .first()) as AgentTriggerRow | undefined
      if (!row) return reply.code(404).send({ error: 'Not found' })
      const item = req.body?.item
      if (item == null || item === '') return reply.code(400).send({ error: 'item is required' })
      const built = await buildWakeBody(
        row,
        { collection: row.collection, item: String(item), event: 'update' },
        'preview'
      )
      if (!built.ok) return { data: { sent: false, skipped: built.reason, body: null } }
      return { data: { sent: false, skipped: null, body: built.body, truncated: built.truncated } }
    }
  )

  app.get<{ Querystring: { trigger?: string; status?: string; limit?: string; before?: string } }>(
    '/deliveries',
    async (req, reply) => {
      if (!(await agentTriggersReady())) return notReady(reply)
      const q = db('nivaro_agent_trigger_deliveries').orderBy('id', 'desc')
      if (req.query.trigger) q.where('trigger_id', Number(req.query.trigger))
      const status = req.query.status
      if (status === 'failed') q.whereIn('status', ['dead', 'retrying'])
      else if (status && DELIVERY_STATUSES.includes(status)) q.where('status', status)
      if (req.query.before && /^\d+$/.test(req.query.before))
        q.where('id', '<', Number(req.query.before))
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200)
      const rows = (await q
        .limit(limit)
        .select(
          'id',
          'trigger_id',
          'delivery_key',
          'event',
          'collection',
          'item',
          'status',
          'attempts',
          'max_attempts',
          'next_attempt_at',
          'last_status_code',
          'last_error',
          'latency_ms',
          'delivered_at',
          'created_at',
          'updated_at'
        )) as DeliveryRow[]
      return { data: rows.map((r) => deliveryView(r, false)), has_more: rows.length === limit }
    }
  )

  app.get<{ Params: { id: string } }>('/deliveries/:id', async (req, reply) => {
    if (!(await agentTriggersReady())) return notReady(reply)
    const d = (await db('nivaro_agent_trigger_deliveries')
      .where({ id: Number(req.params.id) })
      .first()) as DeliveryRow | undefined
    if (!d) return reply.code(404).send({ error: 'Not found' })
    return { data: deliveryView(d, true) }
  })

  app.post<{ Params: { id: string } }>('/deliveries/:id/retry', async (req, reply) => {
    if (refuseAgent(req, reply)) return
    if (!(await agentTriggersReady())) return notReady(reply)
    try {
      const d = await retryDelivery(Number(req.params.id))
      if (!d) return reply.code(404).send({ error: 'Not found' })
      await logActivity({
        action: 'agent-trigger-retry',
        user: req.user!.id,
        collection: 'nivaro_agent_triggers',
        item: String(d.trigger_id),
        comment: `delivery ${d.delivery_key}: ${d.status}`,
        req
      })
      return { data: deliveryView(d, true) }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  app.post<{ Params: { id: string } }>('/deliveries/:id/discard', async (req, reply) => {
    if (refuseAgent(req, reply)) return
    if (!(await agentTriggersReady())) return notReady(reply)
    const ok = await discardDelivery(Number(req.params.id))
    if (!ok)
      return reply.code(409).send({ error: 'Only a dead or waiting delivery can be discarded' })
    return { data: { discarded: true } }
  })
}
