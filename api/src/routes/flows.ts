import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import type { HookAction } from '../hooks/registry.js'
import { hooks } from '../hooks/registry.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { inngest } from '../plugins/inngest.js'
import { logActivity } from '../services/activity.js'
import { executeFlow } from '../services/flow-executor.js'

interface Flow {
  id: string
  name: string
  description: string | null
  status: string
  trigger: string
  trigger_options: string | null
  accountability: string
  created_at: Date
  updated_at: Date
}

interface FlowOperation {
  id: string
  flow: string
  name: string
  key: string
  type: string
  position_x: number
  position_y: number
  options: string | null
  resolve: string | null
  reject: string | null
  created_at: Date
}

interface FlowRun {
  id: string
  flow: string
  trigger: string
  status: string
  started_at: Date
  completed_at: Date | null
  duration_ms: number | null
  input: string | null
  output: string | null
  error_message: string | null
  user: string | null
}

interface FlowVersion {
  id: number
  flow: string
  version: number
  definition: string
  created_by: string | null
  created_at: Date
}

interface FlowVersionDefinition {
  flow: Pick<
    Flow,
    'name' | 'description' | 'status' | 'trigger' | 'trigger_options' | 'accountability'
  >
  operations: Array<Omit<FlowOperation, 'created_at'>>
}

interface EventTriggerOptions {
  timing?: 'before' | 'after'
  types?: string[]
  collections?: string[]
  return_payload?: boolean
}

interface WebhookTriggerOptions {
  method?: string
  async?: boolean
  auth_type?: 'none' | 'bearer' | 'hmac-sha256'
  secret?: string
  return_response?: boolean
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────

function toJsonString(val: unknown): string | null {
  if (val === null || val === undefined) return null
  if (typeof val === 'string') return val
  return JSON.stringify(val)
}

function parseJsonField(val: string | null | undefined): Record<string, unknown> | null {
  if (!val) return null
  try {
    return JSON.parse(val) as Record<string, unknown>
  } catch {
    return null
  }
}

// ─── Flow versioning ──────────────────────────────────────────────────────────

/**
 * Snapshot the CURRENT full definition (flow row + operations) of a flow into
 * nivaro_flow_versions with the next version number. Best-effort: failures are
 * logged but never block the mutation that triggered the snapshot.
 */
async function snapshotFlowVersion(
  log: FastifyInstance['log'],
  flowId: string,
  userId?: string
): Promise<number | null> {
  try {
    const flow = await db<Flow>('nivaro_flows').where({ id: flowId }).first()
    if (!flow) return null
    const operations = await db<FlowOperation>('nivaro_flow_operations')
      .where({ flow: flowId })
      .orderBy('position_y')
      .orderBy('position_x')
    const definition: FlowVersionDefinition = {
      flow: {
        name: flow.name,
        description: flow.description,
        status: flow.status,
        trigger: flow.trigger,
        trigger_options: flow.trigger_options,
        accountability: flow.accountability
      },
      operations: operations.map((op) => ({
        id: op.id,
        flow: op.flow,
        name: op.name,
        key: op.key,
        type: op.type,
        position_x: op.position_x,
        position_y: op.position_y,
        options: op.options,
        resolve: op.resolve,
        reject: op.reject
      }))
    }
    const maxRow = await db('nivaro_flow_versions')
      .where({ flow: flowId })
      .max('version as max')
      .first()
    const nextVersion = Number((maxRow as { max: number | null } | undefined)?.max ?? 0) + 1
    await db('nivaro_flow_versions').insert({
      flow: flowId,
      version: nextVersion,
      definition: JSON.stringify(definition),
      created_by: userId ?? null,
      created_at: new Date()
    })
    return nextVersion
  } catch (err) {
    log.warn({ err, flowId }, 'Failed to snapshot flow version')
    return null
  }
}

/** Op PATCH bodies that only move nodes on the canvas don't deserve a version. */
function opPatchIsStructural(body: Partial<FlowOperation>): boolean {
  const structural = ['options', 'resolve', 'reject', 'type', 'key', 'name']
  return Object.keys(body).some((k) => structural.includes(k))
}

// ─── Cron helpers ─────────────────────────────────────────────────────────────

function flowCronId(flowId: string) {
  return `flow:${flowId}`
}

async function sendFlowEvent(
  log: FastifyInstance['log'],
  flowId: string,
  flowName: string,
  trigger: string,
  payload?: Record<string, unknown>
) {
  try {
    await inngest.send({
      name: 'cms/flow.triggered',
      data: { flowId, flowName, trigger, payload: payload ?? {} }
    })
  } catch (err) {
    log.warn({ err, flowId }, 'Flow event not delivered to Inngest (dev server may be offline)')
  }
}

function scheduleFlow(app: FastifyInstance, flow: Flow) {
  const opts = flow.trigger_options
    ? (JSON.parse(flow.trigger_options) as Record<string, unknown>)
    : {}
  const expression = opts.cron as string | undefined
  if (!expression) {
    app.log.warn({ flowId: flow.id }, 'Schedule flow missing cron expression, skipping')
    return
  }
  app.cron.schedule(flowCronId(flow.id), expression, async () => {
    app.log.info({ flowId: flow.id, name: flow.name }, 'Scheduled flow triggered')
    await executeFlow({
      flowId: flow.id,
      flowName: flow.name,
      trigger: 'schedule',
      payload: {},
      log: app.log
    })
    await sendFlowEvent(app.log, flow.id, flow.name, 'schedule')
  })
}

function unscheduleFlow(app: FastifyInstance, flowId: string) {
  app.cron.unschedule(flowCronId(flowId))
}

export async function loadScheduledFlows(app: FastifyInstance) {
  const flows = await db<Flow>('nivaro_flows').where({ trigger: 'schedule', status: 'active' })
  for (const flow of flows) {
    try {
      scheduleFlow(app, flow)
    } catch (err) {
      app.log.error({ err, flowId: flow.id }, 'Failed to schedule flow at startup')
    }
  }
  if (flows.length > 0) app.log.info({ count: flows.length }, 'Scheduled flows loaded')
}

// ─── Event hook helpers ───────────────────────────────────────────────────────

const ITEM_ACTIONS: HookAction[] = ['create', 'update', 'delete']

function flowHookTag(flowId: string) {
  return `flow-event:${flowId}`
}

function registerEventFlowHook(app: FastifyInstance, flow: Flow) {
  const opts = flow.trigger_options ? (JSON.parse(flow.trigger_options) as EventTriggerOptions) : {}
  const timing = opts.timing ?? 'after'
  const rawTypes = (opts.types ?? []).filter((t) =>
    ITEM_ACTIONS.includes(t as HookAction)
  ) as HookAction[]
  const actions: HookAction[] = rawTypes.length ? rawTypes : ITEM_ACTIONS
  const collections: Array<string | '*'> = (opts.collections ?? []).length
    ? (opts.collections as string[])
    : ['*']
  const tag = flowHookTag(flow.id)

  for (const action of actions) {
    for (const collection of collections) {
      // biome-ignore lint/complexity/noForEach: inner loop captures flow/action/collection
      const returnPayload = timing === 'before' && (opts.return_payload ?? false)
      const hookFn = async (ctx: import('../hooks/registry.js').HookContext) => {
        const execCtx = {
          flowId: flow.id,
          flowName: flow.name,
          trigger: `${timing}:${action}`,
          payload: {
            collection: ctx.collection,
            action: ctx.action,
            keys: ctx.keys ?? [],
            payload: ctx.payload ?? {},
            previousData: ctx.previousData ?? {}
          },
          log: app.log,
          userId: ctx.user?.id
        }
        if (returnPayload) {
          try {
            const result = await executeFlow(execCtx)
            // Merge exec-script's returned payload back into ctx so the items service writes it
            if (ctx.payload && result?.payload && typeof result.payload === 'object') {
              Object.assign(ctx.payload, result.payload as Record<string, unknown>)
            }
          } catch (err) {
            app.log.error({ err, flowId: flow.id }, 'Before-event flow failed')
          }
        } else {
          executeFlow(execCtx).catch((err) =>
            app.log.error({ err, flowId: flow.id }, 'Event flow execution failed')
          )
        }
      }
      if (timing === 'before') hooks.before(collection, action, hookFn, { extensionId: tag })
      else hooks.after(collection, action, hookFn, { extensionId: tag })
    }
  }

  app.log.debug({ flowId: flow.id, timing, actions, collections }, 'Event flow hook registered')
}

function unregisterEventFlowHook(flowId: string) {
  hooks.removeExtensionHooks(flowHookTag(flowId))
}

export async function loadEventFlows(app: FastifyInstance) {
  const flows = await db<Flow>('nivaro_flows').where({ trigger: 'event', status: 'active' })
  for (const flow of flows) {
    try {
      registerEventFlowHook(app, flow)
    } catch (err) {
      app.log.error({ err, flowId: flow.id }, 'Failed to register event flow hook at startup')
    }
  }
  if (flows.length > 0) app.log.info({ count: flows.length }, 'Event flow hooks loaded')
}

export async function fireSystemEvent(
  app: FastifyInstance,
  eventType: 'login' | 'logout',
  payload: Record<string, unknown>
) {
  const flows = await db<Flow>('nivaro_flows').where({ trigger: 'event', status: 'active' })
  for (const flow of flows) {
    const opts = flow.trigger_options
      ? (JSON.parse(flow.trigger_options) as EventTriggerOptions)
      : {}
    if ((opts.types ?? []).includes(eventType)) {
      executeFlow({
        flowId: flow.id,
        flowName: flow.name,
        trigger: eventType,
        payload,
        log: app.log
      }).catch((err) =>
        app.log.error({ err, flowId: flow.id }, `System event ${eventType} flow failed`)
      )
    }
  }
}

// ─── Inbound webhook route (public — no requireAdmin) ─────────────────────────

export async function webhookFlowRoute(app: FastifyInstance) {
  app.post<{ Params: { flowId: string } }>('/webhook/:flowId', async (req, reply) => {
    const { flowId } = req.params
    const flow = await db<Flow>('nivaro_flows')
      .where({ id: flowId, trigger: 'webhook', status: 'active' })
      .first()
    if (!flow) return reply.code(404).send({ error: 'Not found' })

    const opts = flow.trigger_options
      ? (JSON.parse(flow.trigger_options) as WebhookTriggerOptions)
      : {}

    if (
      opts.method &&
      opts.method !== '*' &&
      req.method.toUpperCase() !== opts.method.toUpperCase()
    ) {
      return reply.code(405).send({ error: `Method ${req.method} not allowed` })
    }

    if (opts.auth_type && opts.auth_type !== 'none') {
      if (!opts.secret) {
        // Auth type configured but no secret saved — misconfigured, refuse all requests
        app.log.error(
          { flowId: flow.id, auth_type: opts.auth_type },
          'Webhook flow misconfigured: auth_type set but no secret'
        )
        return reply.code(500).send({ error: 'Webhook misconfigured' })
      }
      if (opts.auth_type === 'bearer') {
        const authHeader = (req.headers.authorization as string) ?? ''
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
        try {
          if (!timingSafeEqual(Buffer.from(token), Buffer.from(opts.secret))) {
            return reply.code(401).send({ error: 'Unauthorized' })
          }
        } catch {
          return reply.code(401).send({ error: 'Unauthorized' })
        }
      } else if (opts.auth_type === 'hmac-sha256') {
        const sigHeader = (req.headers['x-signature-256'] as string) ?? ''
        const bodyStr = req.body ? JSON.stringify(req.body) : ''
        const expected = `sha256=${createHmac('sha256', opts.secret).update(bodyStr).digest('hex')}`
        try {
          if (!timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected))) {
            return reply.code(401).send({ error: 'Invalid signature' })
          }
        } catch {
          return reply.code(401).send({ error: 'Invalid signature' })
        }
      }
    }

    const payload = (req.body as Record<string, unknown>) ?? {}

    if (opts.async) {
      executeFlow({
        flowId: flow.id,
        flowName: flow.name,
        trigger: 'webhook',
        payload,
        log: app.log
      }).catch((err) => app.log.error({ err, flowId: flow.id }, 'Async webhook flow failed'))
      return reply.code(202).send({ ok: true, async: true })
    }

    try {
      const result = await executeFlow({
        flowId: flow.id,
        flowName: flow.name,
        trigger: 'webhook',
        payload,
        log: app.log
      })
      return reply.send(opts.return_response ? { ok: true, data: result } : { ok: true })
    } catch (err) {
      app.log.error({ err, flowId: flow.id }, 'Webhook flow execution failed')
      return reply.code(500).send({ error: 'Webhook execution failed' })
    }
  })
}

// ─── Admin routes ─────────────────────────────────────────────────────────────

export async function flowsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async (_req, reply) => {
    const flows = await db<Flow>('nivaro_flows').orderBy('updated_at', 'desc')
    const counts = await db('nivaro_flow_operations')
      .select('flow')
      .count('id as count')
      .groupBy('flow')
    const countMap = new Map(counts.map((r) => [r.flow as string, Number(r.count)]))
    const cronJobs = new Map(app.cron.list().map((j) => [j.id, j]))
    return reply.send({
      data: flows.map((f) => ({
        ...f,
        trigger_options: parseJsonField(f.trigger_options),
        operation_count: countMap.get(f.id) ?? 0,
        next_run: cronJobs.get(flowCronId(f.id))?.nextRun ?? null
      }))
    })
  })

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const flow = await db<Flow>('nivaro_flows').where({ id }).first()
    if (!flow) return reply.code(404).send({ error: 'Not found' })
    const operations = await db<FlowOperation>('nivaro_flow_operations')
      .where({ flow: id })
      .orderBy('position_y')
      .orderBy('position_x')
    const cronJob = app.cron.list().find((j) => j.id === flowCronId(id))
    return reply.send({
      data: {
        ...flow,
        trigger_options: parseJsonField(flow.trigger_options),
        operations: operations.map((op) => ({ ...op, options: parseJsonField(op.options) })),
        next_run: cronJob?.nextRun ?? null
      }
    })
  })

  app.post('/', async (req, reply) => {
    const body = req.body as Pick<
      Flow,
      'name' | 'description' | 'status' | 'trigger' | 'trigger_options' | 'accountability'
    >
    const id = randomUUID()
    const now = new Date()
    await db('nivaro_flows').insert({
      id,
      name: body.name,
      description: body.description ?? null,
      status: body.status ?? 'inactive',
      trigger: body.trigger,
      trigger_options: toJsonString(body.trigger_options),
      accountability: body.accountability ?? 'all',
      created_at: now,
      updated_at: now
    })
    const flow = await db<Flow>('nivaro_flows').where({ id }).first()
    if (flow) {
      if (flow.trigger === 'schedule' && flow.status === 'active') scheduleFlow(app, flow)
      if (flow.trigger === 'event' && flow.status === 'active') registerEventFlowHook(app, flow)
    }
    await logActivity({
      action: 'create',
      collection: 'nivaro_flows',
      item: id,
      user: req.user?.id,
      req
    })
    return reply.code(201).send({
      data: flow ? { ...flow, trigger_options: parseJsonField(flow.trigger_options) } : flow
    })
  })

  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as Partial<Flow>
    // Version the previous definition when the trigger configuration changes
    if ('trigger' in body || 'trigger_options' in body) {
      await snapshotFlowVersion(app.log, id, req.user?.id)
    }
    await db('nivaro_flows')
      .where({ id })
      .update({
        ...body,
        trigger_options: toJsonString(body.trigger_options),
        updated_at: new Date()
      })
    const flow = await db<Flow>('nivaro_flows').where({ id }).first()
    if (!flow) return reply.code(404).send({ error: 'Not found' })

    unscheduleFlow(app, id)
    if (flow.trigger === 'schedule' && flow.status === 'active') scheduleFlow(app, flow)

    unregisterEventFlowHook(id)
    if (flow.trigger === 'event' && flow.status === 'active') registerEventFlowHook(app, flow)

    await logActivity({
      action: 'update',
      collection: 'nivaro_flows',
      item: id,
      user: req.user?.id,
      req
    })
    return reply.send({ data: { ...flow, trigger_options: parseJsonField(flow.trigger_options) } })
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    unscheduleFlow(app, id)
    unregisterEventFlowHook(id)
    const deleted = await db('nivaro_flows').where({ id }).delete()
    if (!deleted) return reply.code(404).send({ error: 'Not found' })
    await logActivity({
      action: 'delete',
      collection: 'nivaro_flows',
      item: id,
      user: req.user?.id,
      req
    })
    return reply.code(204).send()
  })

  app.post('/:id/operations', async (req, reply) => {
    const { id } = req.params as { id: string }
    const flow = await db<Flow>('nivaro_flows').where({ id }).first()
    if (!flow) return reply.code(404).send({ error: 'Flow not found' })
    const body = req.body as Pick<
      FlowOperation,
      'name' | 'key' | 'type' | 'position_x' | 'position_y' | 'options' | 'resolve' | 'reject'
    >
    await snapshotFlowVersion(app.log, id, req.user?.id)
    const opId = randomUUID()
    await db('nivaro_flow_operations').insert({
      id: opId,
      flow: id,
      name: body.name,
      key: body.key,
      type: body.type,
      position_x: body.position_x ?? 0,
      position_y: body.position_y ?? 0,
      options: toJsonString(body.options),
      resolve: body.resolve ?? null,
      reject: body.reject ?? null,
      created_at: new Date()
    })
    const op = await db<FlowOperation>('nivaro_flow_operations').where({ id: opId }).first()
    await logActivity({
      action: 'create',
      collection: 'nivaro_flow_operations',
      item: opId,
      user: req.user?.id,
      req,
      comment: `flow:${id}`
    })
    return reply.code(201).send({ data: op ? { ...op, options: parseJsonField(op.options) } : op })
  })

  app.patch('/:id/operations/:opId', async (req, reply) => {
    const { id, opId } = req.params as { id: string; opId: string }
    const op = await db<FlowOperation>('nivaro_flow_operations')
      .where({ id: opId, flow: id })
      .first()
    if (!op) return reply.code(404).send({ error: 'Not found' })
    const opBody = req.body as Partial<FlowOperation>
    if (opPatchIsStructural(opBody)) {
      await snapshotFlowVersion(app.log, id, req.user?.id)
    }
    await db('nivaro_flow_operations')
      .where({ id: opId, flow: id })
      .update({ ...opBody, options: toJsonString(opBody.options) })
    const updated = await db<FlowOperation>('nivaro_flow_operations').where({ id: opId }).first()
    await logActivity({
      action: 'update',
      collection: 'nivaro_flow_operations',
      item: opId,
      user: req.user?.id,
      req
    })
    return reply.send({
      data: updated ? { ...updated, options: parseJsonField(updated.options) } : updated
    })
  })

  app.delete('/:id/operations/:opId', async (req, reply) => {
    const { id, opId } = req.params as { id: string; opId: string }
    await snapshotFlowVersion(app.log, id, req.user?.id)
    const deleted = await db('nivaro_flow_operations').where({ id: opId, flow: id }).delete()
    if (!deleted) return reply.code(404).send({ error: 'Not found' })
    await logActivity({
      action: 'delete',
      collection: 'nivaro_flow_operations',
      item: opId,
      user: req.user?.id,
      req
    })
    return reply.code(204).send()
  })

  app.post('/:id/trigger', async (req, reply) => {
    const { id } = req.params as { id: string }
    const flow = await db<Flow>('nivaro_flows').where({ id }).first()
    if (!flow) return reply.code(404).send({ error: 'Not found' })
    if (flow.status !== 'active') return reply.code(400).send({ error: 'Flow is not active' })
    const payload = (req.body as Record<string, unknown>) ?? {}
    await executeFlow({
      flowId: id,
      flowName: flow.name,
      trigger: 'manual',
      payload,
      log: app.log,
      userId: req.user?.id
    })
    await sendFlowEvent(app.log, id, flow.name, 'manual', payload)
    await logActivity({
      action: 'run',
      collection: 'nivaro_flows',
      item: id,
      user: req.user?.id,
      req
    })
    return reply.send({ ok: true, flowId: id })
  })

  app.get('/runs/:runId', async (req, reply) => {
    const { runId } = req.params as { runId: string }
    const run = await db<FlowRun>('nivaro_flow_runs').where({ id: runId }).first()
    if (!run) return reply.code(404).send({ error: 'Not found' })
    return reply.send({
      data: { ...run, input: parseJsonField(run.input), output: parseJsonField(run.output) }
    })
  })

  app.get('/:id/runs', async (req, reply) => {
    const { id } = req.params as { id: string }
    const q = req.query as { limit?: string; offset?: string; status?: string }
    const limit = Math.min(q.limit ? Number(q.limit) : 50, 200)
    const offset = q.offset ? Number(q.offset) : 0
    const baseQuery = db<FlowRun>('nivaro_flow_runs').where({ flow: id })
    if (q.status) baseQuery.andWhere({ status: q.status })
    const countQuery = db('nivaro_flow_runs').where({ flow: id })
    if (q.status) countQuery.andWhere({ status: q.status })
    const [runs, countRows] = await Promise.all([
      baseQuery.clone().orderBy('started_at', 'desc').limit(limit).offset(offset),
      countQuery.count('id as count')
    ])
    const total = Number((countRows[0] as { count: string | number }).count)
    return reply.send({
      data: runs.map((r) => ({
        ...r,
        input: parseJsonField(r.input),
        output: parseJsonField(r.output)
      })),
      total,
      limit,
      offset
    })
  })

  // ─── Versions ───────────────────────────────────────────────────────────────

  app.get('/:id/versions', async (req, reply) => {
    const { id } = req.params as { id: string }
    const versions = await db<FlowVersion>('nivaro_flow_versions as v')
      .leftJoin('nivaro_users as u', 'u.id', 'v.created_by')
      .where('v.flow', id)
      .orderBy('v.version', 'desc')
      .select(
        'v.id',
        'v.version',
        'v.created_by',
        'v.created_at',
        'u.first_name',
        'u.last_name',
        'u.email as user_email'
      )
    return reply.send({ data: versions })
  })

  app.get('/:id/versions/:version', async (req, reply) => {
    const { id, version } = req.params as { id: string; version: string }
    const row = await db<FlowVersion>('nivaro_flow_versions')
      .where({ flow: id, version: Number(version) })
      .first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    let definition: FlowVersionDefinition | null = null
    try {
      definition = JSON.parse(row.definition) as FlowVersionDefinition
    } catch {
      /* corrupt */
    }
    return reply.send({
      data: {
        id: row.id,
        flow: row.flow,
        version: row.version,
        created_by: row.created_by,
        created_at: row.created_at,
        definition
      }
    })
  })

  app.post('/:id/versions/:version/restore', async (req, reply) => {
    const { id, version } = req.params as { id: string; version: string }
    const flow = await db<Flow>('nivaro_flows').where({ id }).first()
    if (!flow) return reply.code(404).send({ error: 'Flow not found' })
    const row = await db<FlowVersion>('nivaro_flow_versions')
      .where({ flow: id, version: Number(version) })
      .first()
    if (!row) return reply.code(404).send({ error: 'Version not found' })

    let definition: FlowVersionDefinition
    try {
      definition = JSON.parse(row.definition) as FlowVersionDefinition
    } catch {
      return reply.code(400).send({ error: 'Stored version definition is corrupt' })
    }

    // Snapshot the current state first so the restore itself is reversible
    await snapshotFlowVersion(app.log, id, req.user?.id)

    await db('nivaro_flows')
      .where({ id })
      .update({
        name: definition.flow.name,
        description: definition.flow.description ?? null,
        status: definition.flow.status ?? 'inactive',
        trigger: definition.flow.trigger,
        trigger_options: toJsonString(definition.flow.trigger_options),
        accountability: definition.flow.accountability ?? 'all',
        updated_at: new Date()
      })

    // Replace operations from the stored definition (ids preserved so links survive)
    await db('nivaro_flow_operations').where({ flow: id }).delete()
    const now = new Date()
    for (const op of definition.operations ?? []) {
      await db('nivaro_flow_operations').insert({
        id: op.id,
        flow: id,
        name: op.name,
        key: op.key,
        type: op.type,
        position_x: op.position_x ?? 0,
        position_y: op.position_y ?? 0,
        options: toJsonString(op.options),
        resolve: null,
        reject: null,
        created_at: now
      })
    }
    // Second pass — wire resolve/reject after all rows exist
    for (const op of definition.operations ?? []) {
      if (op.resolve || op.reject) {
        await db('nivaro_flow_operations')
          .where({ id: op.id })
          .update({
            resolve: op.resolve ?? null,
            reject: op.reject ?? null
          })
      }
    }

    // Re-register schedule + event hooks against the restored definition
    const restored = await db<Flow>('nivaro_flows').where({ id }).first()
    unscheduleFlow(app, id)
    unregisterEventFlowHook(id)
    if (restored) {
      if (restored.trigger === 'schedule' && restored.status === 'active')
        scheduleFlow(app, restored)
      if (restored.trigger === 'event' && restored.status === 'active')
        registerEventFlowHook(app, restored)
    }

    await logActivity({
      action: 'update',
      collection: 'nivaro_flows',
      item: id,
      user: req.user?.id,
      req,
      comment: `restored version ${version}`
    })
    return reply.send({ data: { ok: true, restored_version: Number(version) } })
  })

  app.get('/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string }
    const flow = await db<Flow>('nivaro_flows').where({ id }).first()
    if (!flow) return reply.code(404).send({ error: 'Not found' })
    const operations = await db<FlowOperation>('nivaro_flow_operations')
      .where({ flow: id })
      .orderBy('position_y')
      .orderBy('position_x')
    const idToKey = new Map(operations.map((op) => [op.id, op.key]))
    const exportDoc = {
      type: 'nivaro/flow',
      version: '1',
      exportedAt: new Date().toISOString(),
      flow: {
        name: flow.name,
        description: flow.description,
        status: flow.status,
        trigger: flow.trigger,
        trigger_options: parseJsonField(flow.trigger_options),
        accountability: flow.accountability,
        operations: operations.map((op) => ({
          key: op.key,
          name: op.name,
          type: op.type,
          position_x: op.position_x,
          position_y: op.position_y,
          options: parseJsonField(op.options),
          resolve: op.resolve ? (idToKey.get(op.resolve) ?? null) : null,
          reject: op.reject ? (idToKey.get(op.reject) ?? null) : null
        }))
      }
    }
    const slug = flow.name.toLowerCase().replace(/\s+/g, '-')
    return reply
      .header('Content-Type', 'application/json')
      .header('Content-Disposition', `attachment; filename="${slug}.nivaro.json"`)
      .send(exportDoc)
  })

  app.post('/import', async (req, reply) => {
    try {
      const body = req.body as {
        type?: string
        flow?: {
          name?: string
          description?: string | null
          trigger?: string
          trigger_options?: unknown
          accountability?: string
          operations?: Array<{
            key: string
            name: string
            type: string
            position_x?: number
            position_y?: number
            options?: unknown
            resolve?: string | null
            reject?: string | null
          }>
        }
      }
      if (body.type !== 'nivaro/flow' || !body.flow?.name) {
        return reply.code(400).send({ error: 'Invalid flow document' })
      }
      const flowId = randomUUID()
      const now = new Date()
      await db('nivaro_flows').insert({
        id: flowId,
        name: body.flow.name,
        description: body.flow.description ?? null,
        status: 'inactive',
        trigger: body.flow.trigger ?? 'manual',
        trigger_options: toJsonString(body.flow.trigger_options),
        accountability: body.flow.accountability ?? 'all',
        created_at: now,
        updated_at: now
      })
      const operations = body.flow.operations ?? []
      const keyToId = new Map<string, string>()
      for (const op of operations) {
        const opId = randomUUID()
        keyToId.set(op.key, opId)
        await db('nivaro_flow_operations').insert({
          id: opId,
          flow: flowId,
          name: op.name,
          key: op.key,
          type: op.type,
          position_x: op.position_x ?? 0,
          position_y: op.position_y ?? 0,
          options: toJsonString(op.options),
          resolve: op.resolve ?? null,
          reject: op.reject ?? null,
          created_at: now
        })
      }
      for (const op of operations) {
        const opId = keyToId.get(op.key)
        if (!opId) continue
        await db('nivaro_flow_operations')
          .where({ id: opId })
          .update({
            resolve: op.resolve ? (keyToId.get(op.resolve) ?? null) : null,
            reject: op.reject ? (keyToId.get(op.reject) ?? null) : null
          })
      }
      await logActivity({
        action: 'create',
        collection: 'nivaro_flows',
        item: flowId,
        user: req.user?.id,
        req,
        comment: 'imported'
      })
      return reply.code(201).send({ data: { id: flowId, name: body.flow.name } })
    } catch (err) {
      app.log.error({ err }, 'Flow import failed')
      return reply.code(500).send({ error: 'Import failed' })
    }
  })
}
