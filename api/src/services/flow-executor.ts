import { randomUUID } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import { db } from '../db/index.js'
import { assertSafeUrl } from '../lib/ssrf.js'
import { callExternalApi } from './external-apis.js'
import { sendRawMail } from './mail.js'

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
}

export interface ExecutionContext {
  flowId: string
  flowName: string
  trigger: string
  payload: Record<string, unknown>
  log: FastifyBaseLogger
  userId?: string
}

type FlowData = Record<string, unknown>

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce((cur, key) => {
    if (cur !== null && cur !== undefined && typeof cur === 'object') {
      return (cur as Record<string, unknown>)[key]
    }
    return undefined
  }, obj)
}

function resolveTemplate(template: string, data: FlowData): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
    const val = getByPath(data, path.trim())
    return val !== undefined && val !== null ? String(val) : ''
  })
}

function parseOpts(op: FlowOperation): Record<string, unknown> {
  if (!op.options) return {}
  try {
    return JSON.parse(op.options) as Record<string, unknown>
  } catch {
    return {}
  }
}

// ─── Operation handlers ───────────────────────────────────────────────────────

async function runLog(op: FlowOperation, data: FlowData, ctx: ExecutionContext) {
  const opts = parseOpts(op)
  const level = (opts.level as string) ?? 'info'
  const raw = (opts.message as string) ?? op.name
  const message = resolveTemplate(raw, data)
  const meta = { flowId: ctx.flowId, flowName: ctx.flowName, key: op.key }

  if (level === 'warn') ctx.log.warn(meta, message)
  else if (level === 'error') ctx.log.error(meta, message)
  else if (level === 'debug') ctx.log.debug(meta, message)
  else ctx.log.info(meta, message)

  return { status: 'resolve' as const, output: data }
}

async function runCondition(op: FlowOperation, data: FlowData, ctx: ExecutionContext) {
  const opts = parseOpts(op)
  const fieldPath = (opts.field as string) ?? ''
  const operator = (opts.operator as string) ?? 'eq'
  const compareValue = opts.value
  const fieldValue = getByPath(data, fieldPath)

  let result: boolean
  switch (operator) {
    case 'eq':
      result = fieldValue == compareValue
      break
    case 'neq':
      result = fieldValue != compareValue
      break
    case 'gt':
      result = Number(fieldValue) > Number(compareValue)
      break
    case 'gte':
      result = Number(fieldValue) >= Number(compareValue)
      break
    case 'lt':
      result = Number(fieldValue) < Number(compareValue)
      break
    case 'lte':
      result = Number(fieldValue) <= Number(compareValue)
      break
    case 'contains':
      result = String(fieldValue).includes(String(compareValue))
      break
    case 'startsWith':
      result = String(fieldValue).startsWith(String(compareValue))
      break
    case 'endsWith':
      result = String(fieldValue).endsWith(String(compareValue))
      break
    case 'in': {
      const list = String(compareValue)
        .split(',')
        .map((s) => s.trim())
      result = list.includes(String(fieldValue))
      break
    }
    case 'notIn': {
      const list = String(compareValue)
        .split(',')
        .map((s) => s.trim())
      result = !list.includes(String(fieldValue))
      break
    }
    case 'exists':
      result = fieldValue !== null && fieldValue !== undefined
      break
    case 'notExists':
      result = fieldValue === null || fieldValue === undefined
      break
    default:
      result = false
  }

  ctx.log.debug(
    { flowId: ctx.flowId, key: op.key, fieldPath, operator, fieldValue, result },
    'Condition evaluated'
  )
  return { status: (result ? 'resolve' : 'reject') as 'resolve' | 'reject', output: data }
}

async function runExecScript(op: FlowOperation, data: FlowData, ctx: ExecutionContext) {
  const opts = parseOpts(op)
  const code = (opts.code as string) ?? ''
  const timeoutMs = (opts.timeout_ms as number) ?? 5000

  if (!code.trim()) return { status: 'resolve' as const, output: data }

  const scriptLog = {
    info: (msg: string) => ctx.log.info({ flowId: ctx.flowId, key: op.key }, `[script] ${msg}`),
    warn: (msg: string) => ctx.log.warn({ flowId: ctx.flowId, key: op.key }, `[script] ${msg}`),
    error: (msg: string) => ctx.log.error({ flowId: ctx.flowId, key: op.key }, `[script] ${msg}`)
  }

  try {
    const fn = new Function('data', 'log', `"use strict"; ${code}`)
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Script timed out after ${timeoutMs}ms`)), timeoutMs)
    )
    const run = Promise.resolve().then(() => fn(data, scriptLog) as unknown)
    const result = await Promise.race([run, timeout])

    const output =
      result !== null && result !== undefined && typeof result === 'object'
        ? (result as FlowData)
        : data

    ctx.log.debug({ flowId: ctx.flowId, key: op.key }, 'Script executed')
    return { status: 'resolve' as const, output }
  } catch (err) {
    ctx.log.error({ err, flowId: ctx.flowId, key: op.key }, 'Script execution failed')
    return { status: 'reject' as const, output: { ...data, $error: String(err) } }
  }
}

async function runMail(op: FlowOperation, data: FlowData, ctx: ExecutionContext) {
  const opts = parseOpts(op)
  const to = resolveTemplate((opts.to as string) ?? '', data)
  const subject = resolveTemplate((opts.subject as string) ?? op.name, data)
  const body = resolveTemplate((opts.body as string) ?? '', data)
  const from = opts.from ? resolveTemplate(opts.from as string, data) : undefined

  if (!to) {
    ctx.log.warn({ flowId: ctx.flowId, key: op.key }, 'Mail operation missing recipient, skipping')
    return { status: 'reject' as const, output: { ...data, $error: 'missing recipient' } }
  }

  try {
    await sendRawMail({ to, subject, html: body })
    ctx.log.info({ flowId: ctx.flowId, key: op.key, to }, 'Mail sent')
    return { status: 'resolve' as const, output: data }
  } catch (err) {
    ctx.log.error({ err, flowId: ctx.flowId, key: op.key }, 'Mail send failed')
    return { status: 'reject' as const, output: { ...data, $error: String(err) } }
  }
}

async function runNotification(op: FlowOperation, data: FlowData, ctx: ExecutionContext) {
  const opts = parseOpts(op)
  const recipient = resolveTemplate((opts.recipient as string) ?? '', data)
  const subject = resolveTemplate((opts.subject as string) ?? op.name, data)
  const message = resolveTemplate((opts.message as string) ?? '', data)

  if (!recipient) {
    ctx.log.warn({ flowId: ctx.flowId, key: op.key }, 'Notification missing recipient, skipping')
    return { status: 'reject' as const, output: { ...data, $error: 'missing recipient' } }
  }

  try {
    await db('nivaro_notifications').insert({
      recipient,
      subject,
      message,
      status: 'inbox',
      timestamp: new Date(),
      sender: ctx.userId ?? null,
      collection: null,
      item: null
    })
    ctx.log.info({ flowId: ctx.flowId, key: op.key, recipient }, 'Notification sent')
    return { status: 'resolve' as const, output: data }
  } catch (err) {
    ctx.log.error({ err, flowId: ctx.flowId, key: op.key }, 'Notification insert failed')
    return { status: 'reject' as const, output: { ...data, $error: String(err) } }
  }
}

async function runWebhook(op: FlowOperation, data: FlowData, ctx: ExecutionContext) {
  const opts = parseOpts(op)
  const url = resolveTemplate((opts.url as string) ?? '', data)
  if (!url) {
    ctx.log.warn({ flowId: ctx.flowId, key: op.key }, 'Webhook operation missing url')
    return { status: 'reject' as const, output: { ...data, $error: 'missing url' } }
  }

  const method = ((opts.method as string) ?? 'POST').toUpperCase()
  const extraHeaders = (opts.headers as Record<string, string>) ?? {}
  const isAsync = (opts.async as boolean) ?? false
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extraHeaders }
  const body = method !== 'GET' ? JSON.stringify(data) : undefined

  const doFetch = async () => {
    const res = await fetch(url, { method, headers, body })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    ctx.log.info({ flowId: ctx.flowId, key: op.key, status: res.status }, 'Webhook executed')
    return { ok: res.ok, json }
  }

  try {
    if (isAsync) {
      doFetch().catch((err) =>
        ctx.log.warn({ err, flowId: ctx.flowId, key: op.key }, 'Async webhook failed')
      )
      return { status: 'resolve' as const, output: data }
    }
    const { ok, json } = await doFetch()
    return {
      status: (ok ? 'resolve' : 'reject') as 'resolve' | 'reject',
      output: { ...data, $webhook: json }
    }
  } catch (err) {
    ctx.log.error({ err, flowId: ctx.flowId, key: op.key }, 'Webhook request failed')
    return { status: 'reject' as const, output: { ...data, $error: String(err) } }
  }
}

async function runTransform(op: FlowOperation, data: FlowData, ctx: ExecutionContext) {
  const opts = parseOpts(op)
  const mappings =
    (opts.mappings as Array<{
      from: string
      to: string
      operation: 'copy' | 'set' | 'template' | 'delete'
      value: string
    }>) ?? []

  const out = { ...data }

  for (const m of mappings) {
    switch (m.operation) {
      case 'copy': {
        const val = getByPath(data, m.from)
        if (m.to) out[m.to] = val
        break
      }
      case 'set':
        if (m.from) out[m.from] = m.value
        break
      case 'template':
        if (m.from) out[m.from] = resolveTemplate(m.value, data)
        break
      case 'delete':
        if (m.from) {
          delete out[m.from]
        }
        break
    }
  }

  ctx.log.debug({ flowId: ctx.flowId, key: op.key, count: mappings.length }, 'Transform applied')
  return { status: 'resolve' as const, output: out }
}

async function runRunFlow(op: FlowOperation, data: FlowData, ctx: ExecutionContext) {
  const opts = parseOpts(op)
  const targetFlowId = opts.flow_id as string | undefined
  const wait = (opts.wait as boolean) ?? true

  if (!targetFlowId) {
    ctx.log.warn({ flowId: ctx.flowId, key: op.key }, 'run-flow operation missing flow_id')
    return { status: 'reject' as const, output: { ...data, $error: 'missing flow_id' } }
  }

  const targetFlow = await db<{ id: string; name: string; status: string }>('nivaro_flows')
    .where({ id: targetFlowId })
    .first()

  if (!targetFlow) {
    return { status: 'reject' as const, output: { ...data, $error: 'target flow not found' } }
  }
  if (targetFlow.status !== 'active') {
    return { status: 'reject' as const, output: { ...data, $error: 'target flow inactive' } }
  }

  let payloadOverride: Record<string, unknown> = {}
  if (opts.payload) {
    try {
      const tmpl = resolveTemplate(
        typeof opts.payload === 'string' ? opts.payload : JSON.stringify(opts.payload),
        data
      )
      payloadOverride = JSON.parse(tmpl) as Record<string, unknown>
    } catch {
      /* use empty */
    }
  }

  const subCtx: ExecutionContext = {
    flowId: targetFlowId,
    flowName: targetFlow.name,
    trigger: 'run-flow',
    payload: { ...data, ...payloadOverride },
    log: ctx.log,
    userId: ctx.userId
  }

  if (!wait) {
    executeFlow(subCtx).catch((err) =>
      ctx.log.error({ err, flowId: ctx.flowId, targetFlowId }, 'Sub-flow execution failed')
    )
    return { status: 'resolve' as const, output: data }
  }

  await executeFlow(subCtx)
  return { status: 'resolve' as const, output: data }
}

async function runExternalApi(op: FlowOperation, data: FlowData, ctx: ExecutionContext) {
  const opts = parseOpts(op)
  const resultKey = (opts.result_key as string) ?? '$ext_response'
  const failOnError = (opts.fail_on_error as boolean) ?? true

  let status: number
  let body: unknown

  if (opts.mode === 'predefined') {
    const apiId = opts.api_id as string | number | undefined
    if (!apiId) {
      ctx.log.warn(
        { flowId: ctx.flowId, key: op.key },
        'external-api predefined mode missing api_id'
      )
      return { status: 'reject' as const, output: { ...data, $error: 'missing api_id' } }
    }

    const callOpts: Parameters<typeof callExternalApi>[1] = {
      _log: { triggeredBy: `flow:${ctx.flowId}`, userId: ctx.userId }
    }

    if (opts.endpoint !== undefined) callOpts.endpoint = opts.endpoint as string | number
    if (opts.method_override) callOpts.method = opts.method_override as string
    if (opts.path_override) callOpts.path = resolveTemplate(opts.path_override as string, data)
    if (opts.query) {
      const raw = opts.query as Record<string, string>
      callOpts.query = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [k, resolveTemplate(v, data)])
      )
    }
    if (opts.body) {
      try {
        callOpts.body = JSON.parse(resolveTemplate(opts.body as string, data)) as unknown
      } catch {
        callOpts.body = opts.body as string
      }
    }

    try {
      const result = await callExternalApi(apiId, callOpts)
      status = result.status
      body = result.body
    } catch (err) {
      ctx.log.error({ err, flowId: ctx.flowId, key: op.key }, 'external-api predefined call failed')
      return {
        status: 'reject' as const,
        output: { ...data, $error: 'external API request failed' }
      }
    }
  } else {
    const rawUrl = (opts.url as string) ?? ''
    if (!rawUrl) {
      ctx.log.warn({ flowId: ctx.flowId, key: op.key }, 'external-api custom mode missing url')
      return { status: 'reject' as const, output: { ...data, $error: 'missing url' } }
    }

    const url = resolveTemplate(rawUrl, data)
    try {
      await assertSafeUrl(url)
    } catch (err) {
      ctx.log.warn({ flowId: ctx.flowId, key: op.key, url }, 'external-api blocked by SSRF guard')
      return { status: 'reject' as const, output: { ...data, $error: 'URL not allowed' } }
    }
    const method = ((opts.method as string) ?? 'GET').toUpperCase()
    const timeoutMs = (opts.timeout_ms as number) ?? 10_000
    const extraHeaders = (opts.headers as Record<string, string>) ?? {}
    const reqHeaders: Record<string, string> = { ...extraHeaders }

    const init: RequestInit = { method, headers: reqHeaders }

    if (opts.body && method !== 'GET' && method !== 'HEAD') {
      const resolved = resolveTemplate(opts.body as string, data)
      try {
        init.body = resolved
        if (!Object.keys(reqHeaders).some((h) => h.toLowerCase() === 'content-type')) {
          reqHeaders['Content-Type'] = 'application/json'
        }
      } catch {
        init.body = resolved
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    init.signal = controller.signal

    try {
      const res = await fetch(url, init)
      clearTimeout(timer)
      const text = await res.text()
      let parsed: unknown = text
      if ((res.headers.get('content-type') ?? '').includes('application/json')) {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = text
        }
      }
      status = res.status
      body = parsed
    } catch (err) {
      clearTimeout(timer)
      ctx.log.error({ err, flowId: ctx.flowId, key: op.key }, 'external-api custom call failed')
      return {
        status: 'reject' as const,
        output: { ...data, $error: 'external API request failed' }
      }
    }
  }

  ctx.log.info({ flowId: ctx.flowId, key: op.key, status }, 'external-api executed')

  const response = { status, body }

  if (failOnError && status >= 400) {
    return {
      status: 'reject' as const,
      output: { ...data, [resultKey]: response, $error: `HTTP ${status}` }
    }
  }

  return { status: 'resolve' as const, output: { ...data, [resultKey]: response } }
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

async function runOperation(
  op: FlowOperation,
  data: FlowData,
  ctx: ExecutionContext
): Promise<{ status: 'resolve' | 'reject'; output: FlowData }> {
  switch (op.type) {
    case 'log':
      return runLog(op, data, ctx)
    case 'condition':
      return runCondition(op, data, ctx)
    case 'exec-script':
      return runExecScript(op, data, ctx)
    case 'mail':
      return runMail(op, data, ctx)
    case 'notification':
      return runNotification(op, data, ctx)
    case 'webhook':
      return runWebhook(op, data, ctx)
    case 'transform':
      return runTransform(op, data, ctx)
    case 'run-flow':
      return runRunFlow(op, data, ctx)
    case 'external-api':
      return runExternalApi(op, data, ctx)
    default: {
      const { getOp } = await import('../flows/registry.js')
      const customOp = getOp(op.type)
      if (customOp) {
        try {
          return await customOp.handler(parseOpts(op), data, ctx)
        } catch (err) {
          ctx.log.error(
            { err, flowId: ctx.flowId, key: op.key, type: op.type },
            'Custom op handler threw'
          )
          return { status: 'reject', output: { ...data, $error: 'custom op failed' } }
        }
      }
      ctx.log.debug(
        { flowId: ctx.flowId, key: op.key, type: op.type },
        `Unknown op type '${op.type}', skipping`
      )
      return { status: 'resolve', output: data }
    }
  }
}

// ─── Main executor ────────────────────────────────────────────────────────────

export async function executeFlow(ctx: ExecutionContext): Promise<FlowData> {
  const operations = await db<FlowOperation>('nivaro_flow_operations')
    .where({ flow: ctx.flowId })
    .orderBy('position_y')
    .orderBy('position_x')

  ctx.log.info(
    { flowId: ctx.flowId, flowName: ctx.flowName, trigger: ctx.trigger, ops: operations.length },
    'Flow execution started'
  )

  try {
    await db('nivaro_activity').insert({
      action: 'flow_trigger',
      user: ctx.userId ?? null,
      timestamp: new Date(),
      collection: 'nivaro_flows',
      item: ctx.flowId,
      comment: `trigger:${ctx.trigger}`
    })
  } catch {
    /* non-fatal */
  }

  const runId = randomUUID()
  const startMs = Date.now()
  try {
    await db('nivaro_flow_runs').insert({
      id: runId,
      flow: ctx.flowId,
      trigger: ctx.trigger,
      status: 'running',
      started_at: new Date(),
      input: JSON.stringify(ctx.payload),
      user: ctx.userId ?? null
    })
  } catch (err) {
    ctx.log.warn({ err, flowId: ctx.flowId }, 'Failed to record flow run start')
  }

  let data: FlowData = { ...ctx.payload, $trigger: ctx.trigger }

  try {
    const opMap = new Map(operations.map((op) => [op.id, op]))
    const referencedIds = new Set(
      operations.flatMap((op) => [op.resolve, op.reject]).filter((id): id is string => id != null)
    )
    const rootOps = operations.filter((op) => !referencedIds.has(op.id))

    async function runChain(startId: string, chainData: FlowData): Promise<FlowData> {
      let currentId: string | null = startId
      let d = chainData
      const visited = new Set<string>()
      while (currentId) {
        if (visited.has(currentId)) {
          ctx.log.warn({ flowId: ctx.flowId, opId: currentId }, 'Cycle detected in flow, halting')
          break
        }
        visited.add(currentId)
        const op = opMap.get(currentId)
        if (!op) break
        const opts = parseOpts(op)
        if (opts.async) {
          runOperation(op, d, ctx).catch((err) =>
            ctx.log.warn({ err, flowId: ctx.flowId, key: op.key }, 'Async op failed')
          )
          ctx.log.debug({ flowId: ctx.flowId, key: op.key }, 'Operation fired async, continuing')
          currentId = op.resolve ?? null
        } else {
          const result = await runOperation(op, d, ctx)
          d = result.output
          ctx.log.debug(
            { flowId: ctx.flowId, key: op.key, status: result.status },
            'Operation executed'
          )
          currentId = result.status === 'resolve' ? op.resolve : op.reject
        }
      }
      return d
    }

    if (rootOps.length > 0) {
      // Fan-out: each root branch runs in parallel with the same initial data
      const results = await Promise.all(rootOps.map((root) => runChain(root.id, data)))
      // Merge outputs — last write wins for shared keys
      data = Object.assign(data, ...results)
    } else if (operations.length > 0) {
      ctx.log.warn({ flowId: ctx.flowId }, 'No root operation found, running in positional order')
      for (const op of operations) {
        const result = await runOperation(op, data, ctx)
        data = result.output
        if (result.status === 'reject') break
      }
    }

    await db('nivaro_flow_runs')
      .where({ id: runId })
      .update({
        status: 'success',
        completed_at: new Date(),
        duration_ms: Date.now() - startMs,
        output: JSON.stringify(data)
      })
      .catch((err) =>
        ctx.log.warn({ err, flowId: ctx.flowId }, 'Failed to record flow run success')
      )

    ctx.log.info({ flowId: ctx.flowId }, 'Flow execution complete')
    return data
  } catch (err) {
    ctx.log.error({ err, flowId: ctx.flowId }, 'Operation threw unexpectedly, halting flow')
    await db('nivaro_flow_runs')
      .where({ id: runId })
      .update({
        status: 'error',
        completed_at: new Date(),
        duration_ms: Date.now() - startMs,
        error_message: String(err)
      })
      .catch((updErr) =>
        ctx.log.warn({ err: updErr, flowId: ctx.flowId }, 'Failed to record flow run error')
      )
    throw err
  }
}
