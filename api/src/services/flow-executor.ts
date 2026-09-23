import { randomUUID } from 'node:crypto'
import type { FastifyBaseLogger } from 'fastify'
import { db } from '../db/index.js'
import { assertSafeUrl } from '../lib/ssrf.js'
import { callExternalApi } from './external-apis.js'
import { resolveSweepItems } from './flow-sweep-items.js'
import { renderMailTemplate, sendRawMail } from './mail.js'
import { NOTIFY_CATEGORIES, NOTIFY_CATEGORY_LABELS, notifyUser } from './notification-channels.js'

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

export interface FlowTraceStep {
  key: string
  name: string
  type: string
  status: 'resolve' | 'reject' | 'async'
  preview?: unknown
}

export interface ExecutionContext {
  flowId: string
  flowName: string
  trigger: string
  payload: Record<string, unknown>
  log: FastifyBaseLogger
  userId?: string
  /** Test mode: side-effect ops (mail/notification/webhook/external-api/custom)
   *  render but don't send — a preview lands in the trace instead. */
  dryRun?: boolean
  /** When provided, executeFlow appends one step per executed operation. */
  trace?: FlowTraceStep[]
}

type FlowData = Record<string, unknown>

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getByPath(obj: unknown, path: string): unknown {
  const keys = path.split('.')
  let cur: unknown = obj
  for (let i = 0; i < keys.length; i++) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    // Literal dotted keys win — item-read results store relation paths flat
    // ('creator.email'), so check the remaining path as one key first.
    const rest = keys.slice(i).join('.')
    if (rest in (cur as Record<string, unknown>)) return (cur as Record<string, unknown>)[rest]
    cur = (cur as Record<string, unknown>)[keys[i]]
  }
  return cur
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

/** Split a mail op's `to` into addresses (comma / semicolon / whitespace). */
const splitAddresses = (to: string) => [
  ...new Set(
    to
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.includes('@'))
  )
]

/**
 * Why THIS address is on a flow mail: the trigger payload's
 * `recipient_reasons` (owners, by the transition payload) first, then the
 * record's own people (creator / contacts, expanded by the flow's item-read
 * step). Null when nothing explains it — the footer then stays silent
 * rather than inventing a reason.
 */
function reasonForRecipient(email: string, data: Record<string, unknown>): string | null {
  const key = email.trim().toLowerCase()
  const reasons = data.recipient_reasons as Record<string, string> | undefined
  if (reasons && typeof reasons[key] === 'string') return reasons[key]
  const rec = data.record as Record<string, unknown> | undefined
  // item-read stores dotted fields FLAT ('creator.email'); a harness payload
  // carries the nested object. Read either shape.
  const emailAt = (field: string): string | null => {
    const v = rec?.[field]
    if (v && typeof v === 'object' && typeof (v as { email?: unknown }).email === 'string')
      return String((v as { email: string }).email).toLowerCase()
    const flat = rec?.[`${field}.email`]
    return typeof flat === 'string' && flat.includes('@') ? flat.toLowerCase() : null
  }
  if (emailAt('creator') === key || emailAt('user_created') === key)
    return 'you created this record'
  if (emailAt('additional_contact') === key) return 'you are the additional contact on this record'
  if (emailAt('internal_contact') === key) return 'you are the internal contact on this record'
  return null
}

async function runMail(op: FlowOperation, data: FlowData, ctx: ExecutionContext) {
  const opts = parseOpts(op)
  const to = resolveTemplate((opts.to as string) ?? '', data)
  const subject = resolveTemplate((opts.subject as string) ?? op.name, data)
  const templateName = typeof opts.template === 'string' ? opts.template.trim() : ''
  const from = opts.from ? resolveTemplate(opts.from as string, data) : undefined
  // `split` sends ONE email per address: the body renders per recipient, so
  // the why-me footer and every link resolve for that person (portal vs
  // admin) instead of the shared, no-recipient defaults.
  const split = opts.split === true
  // `why` is a template ("you own {{to_state.label}}"); without it a split
  // send reads the payload's per-recipient reasons.
  const whyTemplate = typeof opts.why === 'string' ? opts.why.trim() : ''

  if (!to) {
    ctx.log.warn({ flowId: ctx.flowId, key: op.key }, 'Mail operation missing recipient, skipping')
    return { status: 'reject' as const, output: { ...data, $error: 'missing recipient' } }
  }

  const dataRec = data as Record<string, unknown>
  // Optional `category` op option pins the recipient's notification-rules
  // row (reports / workflow / alerts …) instead of sniffing the subject.
  const category = NOTIFY_CATEGORIES.find((c) => c === opts.category)
  // Optional named mail template (core or extension-registered): rendered with
  // the FULL flow data as its context, replacing the plain-text body. A plain
  // body still gets the branded chrome via sendRawMail's auto-wrap.
  const renderBody = async (context: Record<string, unknown>) => {
    let body = resolveTemplate((opts.body as string) ?? '', context as FlowData)
    if (templateName) {
      try {
        body = await renderMailTemplate(templateName, context)
      } catch (err) {
        ctx.log.warn(
          { err, flowId: ctx.flowId, key: op.key, template: templateName },
          'Mail template failed to render, falling back to body'
        )
      }
    }
    return body
  }
  // Per-recipient context: why + rules link + the record link in THEIR app.
  const contextFor = async (email: string): Promise<Record<string, unknown>> => {
    // No stated reason → the honest default: the recipient's rules for the
    // op's category let it through (the same fallback notifyUser uses).
    const why =
      (whyTemplate
        ? resolveTemplate(whyTemplate, { ...data, recipient_email: email } as FlowData)
        : reasonForRecipient(email, dataRec)) ||
      (category
        ? `your notification rules for "${NOTIFY_CATEGORY_LABELS[category]}" send you email`
        : null)
    const { whyContext } = await import('./mail.js')
    const ctxWhy = await whyContext(email, why)
    const out: Record<string, unknown> = { ...dataRec, recipient_email: email, ...ctxWhy }
    try {
      const { userIdForEmail, recordLink } = await import('./app-links.js')
      const userId = await userIdForEmail(email)
      const col = (dataRec.subject_collection ?? dataRec.collection) as string | undefined
      const item = (dataRec.subject_item ?? dataRec.item) as string | number | undefined
      if (userId && col && item != null && typeof dataRec.record_url === 'string') {
        const current = String(dataRec.record_url)
        const q = current.includes('?') ? current.slice(current.indexOf('?') + 1) : undefined
        out.record_url = await recordLink(col, item, { recipientUserId: userId, query: q })
      }
    } catch {
      /* shared link stays */
    }
    return out
  }
  const sharedWhy = whyTemplate ? resolveTemplate(whyTemplate, data) : null
  const recordContext = {
    collection: typeof dataRec.collection === 'string' ? dataRec.collection : undefined,
    item:
      dataRec.item != null
        ? String(dataRec.item)
        : Array.isArray(dataRec.keys) && dataRec.keys[0] != null
          ? String(dataRec.keys[0])
          : undefined
  }
  const logTemplate = templateName || `flow:${op.key}`

  if (ctx.dryRun) {
    // Preview for ONE recipient in split mode — the harness names the person
    // it is rendering for; otherwise the first address stands in.
    const addresses = splitAddresses(to)
    const previewFor =
      typeof dataRec.__preview_recipient === 'string' &&
      addresses.includes(String(dataRec.__preview_recipient).toLowerCase())
        ? String(dataRec.__preview_recipient).toLowerCase()
        : addresses[0]
    const context =
      split && previewFor
        ? await contextFor(previewFor)
        : sharedWhy
          ? { ...dataRec, ...(await (await import('./mail.js')).whyContext(to, sharedWhy)) }
          : dataRec
    const body = await renderBody(context)
    return {
      status: 'resolve' as const,
      output: {
        ...data,
        [`$preview_${op.key}`]: {
          op: 'mail',
          to,
          from,
          subject,
          body,
          split,
          why: (context as { why?: string }).why ?? null
        }
      }
    }
  }

  try {
    if (split) {
      const addresses = splitAddresses(to)
      let sent = 0
      const failures: string[] = []
      for (const email of addresses) {
        const context = await contextFor(email)
        const body = await renderBody(context)
        try {
          await sendRawMail({
            to: email,
            subject,
            html: body,
            why: (context as { why?: string }).why ?? null,
            template: logTemplate,
            ...(category ? { category } : {}),
            ...recordContext
          })
          sent++
        } catch (err) {
          failures.push(`${email}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      ctx.log.info({ flowId: ctx.flowId, key: op.key, sent, failures }, 'Mail sent (split)')
      if (sent === 0 && failures.length > 0) throw new Error(failures.join('; '))
      return { status: 'resolve' as const, output: data }
    }
    const context = sharedWhy
      ? { ...dataRec, ...(await (await import('./mail.js')).whyContext(to, sharedWhy)) }
      : dataRec
    const body = await renderBody(context)
    await sendRawMail({
      to,
      subject,
      html: body,
      why: sharedWhy,
      template: logTemplate,
      ...(category ? { category } : {}),
      ...recordContext
    })
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

  if (ctx.dryRun) {
    return {
      status: 'resolve' as const,
      output: {
        ...data,
        [`$preview_${op.key}`]: { op: 'notification', recipient, subject, message }
      }
    }
  }

  // A meaningful click target: explicit op options win (templated), else the
  // triggering record's collection + first key — a flow notification about a
  // record should open that record.
  const linkCollection =
    resolveTemplate((opts.collection as string) ?? '', data) ||
    (typeof data.collection === 'string' ? data.collection : '') ||
    null
  const keys = data.keys as unknown[] | undefined
  const linkItem =
    resolveTemplate((opts.item as string) ?? '', data) ||
    (data.item != null ? String(data.item) : '') ||
    (Array.isArray(keys) && keys.length > 0 ? String(keys[0]) : '') ||
    null
  try {
    // Through the channel stack (inbox row + live socket + push + outbox
    // retry, recipient's notification rules applied) — not a raw insert.
    // `always_inbox` defaults ON: a flow author configured this
    // notification on purpose, so record mutes / "already viewing" never
    // swallow it; set the option to false to opt into those suppressions.
    const { getIo } = await import('./io-holder.js')
    const appShim = { io: getIo() ?? undefined } as unknown as Parameters<typeof notifyUser>[0]
    const category = NOTIFY_CATEGORIES.find((c) => c === opts.category)
    await notifyUser(appShim, recipient, {
      subject,
      message,
      sender: ctx.userId ?? null,
      collection: linkCollection,
      item: linkCollection ? linkItem : null,
      ...(category ? { category } : {}),
      always_inbox: opts.always_inbox !== false,
      channels: { inapp: true, email: false }
    })
    ctx.log.info({ flowId: ctx.flowId, key: op.key, recipient }, 'Notification sent')
    return { status: 'resolve' as const, output: data }
  } catch (err) {
    ctx.log.error({ err, flowId: ctx.flowId, key: op.key }, 'Notification send failed')
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

  if (ctx.dryRun) {
    return {
      status: 'resolve' as const,
      output: {
        ...data,
        [`$preview_${op.key}`]: { op: 'webhook', url, method, headers, body: body ?? null }
      }
    }
  }

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
    userId: ctx.userId,
    dryRun: ctx.dryRun,
    trace: ctx.trace
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

    if (ctx.dryRun) {
      return {
        status: 'resolve' as const,
        output: {
          ...data,
          [`$preview_${op.key}`]: {
            op: 'external-api',
            mode: 'predefined',
            api_id: apiId,
            endpoint: callOpts.endpoint ?? null,
            path: callOpts.path ?? null,
            method: callOpts.method ?? null,
            query: callOpts.query ?? null,
            body: callOpts.body ?? null
          }
        }
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

    if (ctx.dryRun) {
      return {
        status: 'resolve' as const,
        output: {
          ...data,
          [`$preview_${op.key}`]: {
            op: 'external-api',
            mode: 'custom',
            url,
            method: init.method ?? 'GET',
            body: typeof init.body === 'string' ? init.body : null
          }
        }
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
  // The run wrapper reads this to decide the obligation's outcome: a push
  // that returned a non-2xx "matched" (an op ran) but did not land.
  const httpStatus = { __http_status: status }

  if (failOnError && status >= 400) {
    return {
      status: 'reject' as const,
      output: { ...data, [resultKey]: response, ...httpStatus, $error: `HTTP ${status}` }
    }
  }

  return { status: 'resolve' as const, output: { ...data, [resultKey]: response, ...httpStatus } }
}

const COLLECTION_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

async function runItemRead(op: FlowOperation, data: FlowData, ctx: ExecutionContext) {
  const opts = parseOpts(op)
  const collection = resolveTemplate((opts.collection as string) ?? '', data)
  let id = resolveTemplate((opts.id as string) ?? '', data)
  const fields = (Array.isArray(opts.fields) ? opts.fields : []).filter(
    (f): f is string => typeof f === 'string' && f.length > 0
  )
  const resultKey = (opts.result_key as string) || 'record'

  if (!collection || !COLLECTION_RE.test(collection) || /^nivaro_/i.test(collection)) {
    ctx.log.warn({ flowId: ctx.flowId, key: op.key, collection }, 'item-read: invalid target')
    return { status: 'reject' as const, output: { ...data, $error: 'item-read: invalid target' } }
  }

  // Filter mode: instead of a direct id, locate the first row matching
  // templated column equalities (e.g. { workflow: '{{item}}' }).
  if (!id && opts.filter && typeof opts.filter === 'object') {
    try {
      let q = db(collection)
      for (const [col, tpl] of Object.entries(opts.filter as Record<string, string>)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) continue
        const val = resolveTemplate(String(tpl), data)
        if (val === '')
          return {
            status: 'reject' as const,
            output: { ...data, $error: 'item-read: unresolved filter' }
          }
        q = q.where(col, val)
      }
      const row = (await q.orderBy('id', 'desc').first('id')) as { id: unknown } | undefined
      if (!row) {
        return { status: 'reject' as const, output: { ...data, $error: 'item-read: no match' } }
      }
      id = String(row.id)
    } catch (err) {
      ctx.log.error({ err, flowId: ctx.flowId, key: op.key }, 'item-read filter failed')
      return { status: 'reject' as const, output: { ...data, $error: 'item-read filter failed' } }
    }
  }

  if (!id) {
    ctx.log.warn({ flowId: ctx.flowId, key: op.key, collection }, 'item-read: no id')
    return { status: 'reject' as const, output: { ...data, $error: 'item-read: no id' } }
  }

  try {
    // Reuses the workflow-condition record fetcher: raw row + dotted M2O paths
    // (up to 3 segments) resolved as flat 'a.b.c' keys on the result.
    const { fetchRecordForConditions } = await import('./workflow-conditions.js')
    const ruleSet = JSON.stringify(fields.map((f) => ({ field: f, op: 'nnull' })))
    const record = await fetchRecordForConditions(collection, id, [ruleSet])
    ctx.log.debug({ flowId: ctx.flowId, key: op.key, collection, id }, 'item-read executed')
    return { status: 'resolve' as const, output: { ...data, [resultKey]: record } }
  } catch (err) {
    ctx.log.error({ err, flowId: ctx.flowId, key: op.key }, 'item-read failed')
    return { status: 'reject' as const, output: { ...data, $error: 'item-read failed' } }
  }
}

// ─── workflow-auto-sweep ──────────────────────────────────────────────────────
// Re-evaluates auto_trigger transitions for the OPEN workflow instances of a
// collection (optionally only those sitting in the listed state keys). Built
// for "run right after this import" flows: a staged import writes through raw
// SQL, so no item hook fires for the rows it changed — the flow is what closes
// the loop (e.g. staged-import-completed → condition import_key eq
// orders → this op on the bound collection). Idempotent: an instance whose
// conditions do not pass is untouched.
async function runWorkflowAutoSweep(op: FlowOperation, data: FlowData, ctx: ExecutionContext) {
  const opts = parseOpts(op)
  const collection = resolveTemplate((opts.collection as string) ?? '', data)
  const stateKeys = String(resolveTemplate((opts.states as string) ?? '', data))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const limit = Math.min(Math.max(Number(opts.limit) || 5000, 1), 20000)
  const resultKey = (opts.result_key as string) || 'auto_sweep'
  // `items` scopes the sweep to explicit record ids (a template like
  // {{linked.record_ids}} or a literal list). Configured-but-empty means
  // "nothing to evaluate" — it must never widen back to the whole collection.
  const items = resolveSweepItems(opts.items, data, resolveTemplate, getByPath)
  // Raw imports leave every stored rollup on the touched records stale, and a
  // condition may read one — so a scoped sweep recomputes them first. Off by
  // default for a full scan (thousands of rows × every rollup).
  const recalcRollups =
    opts.recalc_rollups === undefined || opts.recalc_rollups === null
      ? Boolean(items)
      : Boolean(opts.recalc_rollups)

  if (!collection || !COLLECTION_RE.test(collection) || /^nivaro_/i.test(collection)) {
    ctx.log.warn(
      { flowId: ctx.flowId, key: op.key, collection },
      'workflow-auto-sweep: invalid target'
    )
    return {
      status: 'reject' as const,
      output: { ...data, $error: 'workflow-auto-sweep: invalid target' }
    }
  }

  try {
    const templates = (await db('nivaro_workflow_bindings')
      .where({ collection })
      .pluck('template')) as string[]
    if (templates.length === 0) {
      return {
        status: 'reject' as const,
        output: { ...data, $error: `workflow-auto-sweep: ${collection} has no workflow binding` }
      }
    }
    let q = db('nivaro_workflow_instances as i')
      .join('nivaro_workflow_states as s', 's.id', 'i.current_state')
      .whereIn('i.template', templates)
      .where('i.collection', collection)
      .whereNull('i.completed_at')
    if (stateKeys.length > 0) q = q.whereIn('s.key', stateKeys)
    let rows: Array<{ item: string; current_state: string }>
    if (items) {
      rows = []
      // MSSQL caps bound parameters (~2100) — chunk the id list.
      for (let i = 0; i < items.length && rows.length < limit; i += 1000) {
        const chunk = items.slice(i, i + 1000)
        rows.push(
          ...((await q
            .clone()
            .whereIn('i.item', chunk)
            .select('i.item', 'i.current_state')) as Array<{
            item: string
            current_state: string
          }>)
        )
      }
      rows = rows.slice(0, limit)
    } else {
      rows = (await q.select('i.item', 'i.current_state').limit(limit)) as Array<{
        item: string
        current_state: string
      }>
    }

    if (ctx.dryRun) {
      return {
        status: 'resolve' as const,
        output: {
          ...data,
          [`$preview_${op.key}`]: {
            op: 'workflow-auto-sweep',
            collection,
            states: stateKeys,
            scoped_to: items ? items.length : null,
            recalc_rollups: recalcRollups,
            would_evaluate: rows.length
          },
          [resultKey]: { evaluated: rows.length, transitioned: 0, dry_run: true }
        }
      }
    }

    const { runAutoTransitions } = await import('./workflow-transitions.js')
    let rollupFields: string[] = []
    if (recalcRollups) {
      const { recalcStoredRollupsForRecords } = await import('./rollups.js')
      // Scoped ids first (a completed record is still a stale one), else the
      // rows about to be evaluated.
      const targets = items ?? rows.map((r) => String(r.item))
      rollupFields = (await recalcStoredRollupsForRecords(collection, targets)).fields
    }
    let transitioned = 0
    const moved: string[] = []
    for (const row of rows) {
      await runAutoTransitions(collection, String(row.item))
      const after = (await db('nivaro_workflow_instances')
        .where({ collection, item: String(row.item) })
        .first('current_state')) as { current_state: string } | undefined
      if (after && after.current_state !== row.current_state) {
        transitioned++
        if (moved.length < 200) moved.push(String(row.item))
      }
    }
    ctx.log.info(
      {
        flowId: ctx.flowId,
        key: op.key,
        collection,
        scoped_to: items ? items.length : null,
        rollups_recalced: rollupFields,
        evaluated: rows.length,
        transitioned
      },
      'workflow-auto-sweep executed'
    )
    return {
      status: 'resolve' as const,
      output: {
        ...data,
        [resultKey]: {
          evaluated: rows.length,
          transitioned,
          items: moved,
          rollups_recalced: rollupFields
        }
      }
    }
  } catch (err) {
    ctx.log.error({ err, flowId: ctx.flowId, key: op.key }, 'workflow-auto-sweep failed')
    return { status: 'reject' as const, output: { ...data, $error: 'workflow-auto-sweep failed' } }
  }
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

async function runOperation(
  op: FlowOperation,
  data: FlowData,
  ctx: ExecutionContext
): Promise<{ status: 'resolve' | 'reject'; output: FlowData }> {
  emitFirehose('flow-op', {
    flow_id: ctx.flowId,
    flow: ctx.flowName,
    op: op.key ?? op.id,
    type: op.type,
    trigger: ctx.trigger
  })
  const started = Date.now()
  const result = await runOperationInner(op, data, ctx)
  // Live flow runs (#287): watchers of the flows room see steps as they land.
  emitWatch('flows', 'flow:step', {
    flow_id: ctx.flowId,
    op: op.key ?? op.id,
    type: op.type,
    status: result.status,
    ms: Date.now() - started
  })
  return result
}

async function runOperationInner(
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
    case 'item-read':
      return runItemRead(op, data, ctx)
    case 'workflow-auto-sweep':
      return runWorkflowAutoSweep(op, data, ctx)
    default: {
      const { getOp } = await import('../flows/registry.js')
      const customOp = getOp(op.type)
      if (customOp) {
        if (ctx.dryRun) {
          return {
            status: 'resolve' as const,
            output: {
              ...data,
              [`$preview_${op.key}`]: { op: op.type, note: 'custom op skipped in dry run' }
            }
          }
        }
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

// ── Per-flow concurrency lock (#623) ─────────────────────────────────────────
// Flows whose trigger_options carry `concurrency: 'skip'` refuse to run while
// a previous run of the SAME flow is still going — the overlapping trigger is
// recorded as a 'skipped' run instead of executing. Default (no option) keeps
// the historic parallel behaviour. In-process only, like the trace buffer.
const runningFlows = new Set<string>()

// ── Flow error notifications (#622) ──────────────────────────────────────────
// At most one notification per flow per hour, in-process.
const lastErrorNotifyAt = new Map<string, number>()

async function resolveFlowCreator(flowId: string): Promise<string | null> {
  // nivaro_flows carries no creator column (base schema) — read one off the
  // row defensively in case a deployment added it, then fall back to the
  // EARLIEST flow-version snapshot's author (routes/flows.ts stamps created_by
  // on every version), the closest available "creator".
  try {
    const flowRow = (await db('nivaro_flows').where({ id: flowId }).first()) as
      | Record<string, unknown>
      | undefined
    const direct = flowRow?.user_created ?? flowRow?.created_by
    if (direct != null && direct !== '') return String(direct)
  } catch {
    /* fall through */
  }
  try {
    const v = (await db('nivaro_flow_versions')
      .where({ flow: flowId })
      .whereNotNull('created_by')
      .orderBy('version', 'asc')
      .first('created_by')) as { created_by?: string | null } | undefined
    return v?.created_by ?? null
  } catch {
    return null
  }
}

function notifyFlowError(ctx: ExecutionContext, err: unknown): void {
  const last = lastErrorNotifyAt.get(ctx.flowId)
  if (last && Date.now() - last < 3_600_000) return
  lastErrorNotifyAt.set(ctx.flowId, Date.now())
  void (async () => {
    const creator = await resolveFlowCreator(ctx.flowId)
    if (!creator) return
    // The executor holds no Fastify app — notifyUser only reads app.io, so a
    // shim over the io-holder gives it the socket server when one is up and
    // degrades to inbox-row-only (socket skipped) before boot completes.
    const { notifyUser } = await import('./notification-channels.js')
    const { getIo } = await import('./io-holder.js')
    const appShim = { io: getIo() ?? undefined } as unknown as Parameters<typeof notifyUser>[0]
    const snippet = String(err).slice(0, 200)
    await notifyUser(appShim, creator, {
      subject: `Flow "${ctx.flowName}" failed`,
      category: 'system',
      message: `${snippet} — /flows/${ctx.flowId}`.slice(0, 500)
    })
  })().catch((notifyErr) =>
    ctx.log.warn({ err: notifyErr, flowId: ctx.flowId }, 'Flow error notification failed')
  )
}

export async function executeFlow(ctx: ExecutionContext): Promise<FlowData> {
  // Flow shadow mode (#354): a flow flagged shadow_mode runs its FULL logic
  // dry (side-effect ops render but never send/write) and records the run
  // with a 'shadow:' trigger prefix — a trial period before it acts for real.
  let lockTracked = false
  if (!ctx.dryRun) {
    try {
      const flowRow = (await db('nivaro_flows')
        .where({ id: ctx.flowId })
        .first('shadow_mode', 'trigger_options')) as
        | { shadow_mode?: boolean | number; trigger_options?: string | null }
        | undefined
      // Concurrency guard (#623) — checked before the shadow flip so shadow
      // runs (which simulate real behaviour) honour the lock too.
      let concurrency: unknown
      try {
        concurrency = flowRow?.trigger_options
          ? (JSON.parse(flowRow.trigger_options) as Record<string, unknown>).concurrency
          : undefined
      } catch {
        concurrency = undefined
      }
      if (concurrency === 'skip' && runningFlows.has(ctx.flowId)) {
        ctx.log.info(
          { flowId: ctx.flowId, flowName: ctx.flowName, trigger: ctx.trigger },
          'skipped: previous run still going'
        )
        try {
          await db('nivaro_flow_runs').insert({
            id: randomUUID(),
            flow: ctx.flowId,
            trigger: ctx.trigger,
            status: 'skipped',
            started_at: new Date(),
            completed_at: new Date(),
            duration_ms: 0,
            input: JSON.stringify(ctx.payload),
            error_message: 'skipped: previous run still going',
            user: ctx.userId ?? null
          })
        } catch (runErr) {
          ctx.log.warn({ err: runErr, flowId: ctx.flowId }, 'Failed to record skipped flow run')
        }
        return { ...ctx.payload, $trigger: ctx.trigger, $skipped: true }
      }
      if (flowRow?.shadow_mode === true || flowRow?.shadow_mode === 1) {
        ctx = { ...ctx, dryRun: true, trace: ctx.trace ?? [], trigger: `shadow:${ctx.trigger}` }
      }
    } catch {
      /* shadow/concurrency lookup failure = run normally */
    }
    runningFlows.add(ctx.flowId)
    lockTracked = true
  }
  try {
    return await executeFlowInner(ctx)
  } finally {
    if (lockTracked) runningFlows.delete(ctx.flowId)
  }
}

async function executeFlowInner(ctx: ExecutionContext): Promise<FlowData> {
  const operations = await db<FlowOperation>('nivaro_flow_operations')
    .where({ flow: ctx.flowId })
    .orderBy('position_y')
    .orderBy('position_x')

  ctx.log.info(
    { flowId: ctx.flowId, flowName: ctx.flowName, trigger: ctx.trigger, ops: operations.length },
    'Flow execution started'
  )

  // No activity row here: the nivaro_flow_runs insert below records the same
  // flow/trigger/user with status, duration and output on top, and the Run
  // History panel reads from it. Duplicating it into nivaro_activity added ~20
  // rows/day of pure noise (same precedent as inbound flow webhooks).

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
  // #535 — how far the run got. A condition that rejects still ends the run
  // 'success', so without these a flow that stopped MATCHING looks exactly
  // like one that matched: ops_run counts operations executed, `matched`
  // means something other than a condition ran, halted_at names the op whose
  // reject branch ended the chain.
  const progress = { ops: 0, matched: false, halted: null as string | null }
  const note = (op: { key: string; type: string }, status: string, ended: boolean) => {
    progress.ops++
    if (op.type !== 'condition' && status !== 'reject') progress.matched = true
    if (status === 'reject' && ended) progress.halted = op.key
  }

  // A flow that pushes to a partner carries an obligation for the whole run:
  // a condition rejecting at op 2 means nothing was sent, and today that run
  // is recorded "success". Opened per record the flow is about, against the
  // first external-api op the flow carries (a flow with more than one push
  // is a Phase-2 refinement) — a flow core cannot attribute to a registered
  // kind opens nothing. A dry run (the Tester panel, or a shadow-mode flow)
  // never actually calls the partner — runExternalApi returns before it does
  // — so it must never be recorded as a real send or a real skip either.
  const obligationId = await (async () => {
    if (ctx.dryRun) return null
    const collection = typeof data.collection === 'string' ? data.collection : null
    const item =
      data.item != null
        ? String(data.item)
        : Array.isArray(data.keys) && data.keys.length > 0
          ? String(data.keys[0])
          : null
    if (!collection || !item) return null
    const apiOp = operations.find((op) => op.type === 'external-api')
    const apiName = apiOp
      ? String((parseOpts(apiOp) as { api_id?: unknown }).api_id ?? '').trim()
      : ''
    if (!apiName) return null
    const { openObligationForTrigger } = await import('./integration-obligations.js')
    return openObligationForTrigger(
      { collection, item, api: apiName, source: 'flow', flow_name: ctx.flowName },
      { trigger: 'flow', trigger_ref: runId }
    )
  })()

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
          ctx.trace?.push({ key: op.key, name: op.name, type: op.type, status: 'async' })
          note(op, 'async', false)
          currentId = op.resolve ?? null
        } else {
          const result = await runOperation(op, d, ctx)
          d = result.output
          ctx.log.debug(
            { flowId: ctx.flowId, key: op.key, status: result.status },
            'Operation executed'
          )
          ctx.trace?.push({
            key: op.key,
            name: op.name,
            type: op.type,
            status: result.status,
            preview: result.output[`$preview_${op.key}`]
          })
          currentId = result.status === 'resolve' ? op.resolve : op.reject
          note(op, result.status, currentId == null)
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
        ctx.trace?.push({
          key: op.key,
          name: op.name,
          type: op.type,
          status: result.status,
          preview: result.output[`$preview_${op.key}`]
        })
        note(op, result.status, result.status === 'reject')
        if (result.status === 'reject') break
      }
    }

    await db('nivaro_flow_runs')
      .where({ id: runId })
      .update({
        status: 'success',
        completed_at: new Date(),
        duration_ms: Date.now() - startMs,
        output: JSON.stringify(data),
        ops_run: progress.ops,
        matched: progress.matched,
        halted_at: progress.halted
      })
      .catch((err) =>
        ctx.log.warn({ err, flowId: ctx.flowId }, 'Failed to record flow run success')
      )

    // Resolve the obligation opened above (no-op when it is null — a flow
    // with nothing to push, or a dry run, opened nothing). `halted_at`
    // already names the op whose reject stopped the chain: that is a
    // legitimate skip, not a failure. Absent a halt, a pushed op's own HTTP
    // status decides landed vs. failed over the coarser `matched` flag — a
    // push that 4xx'd still "matched" but plainly did not land.
    {
      const { resolveObligation, flowHaltReason } = await import('./integration-obligations.js')
      const halt = flowHaltReason(progress.halted)
      const pushStatus = typeof data.__http_status === 'number' ? data.__http_status : null
      const landed = pushStatus == null ? progress.matched : pushStatus >= 200 && pushStatus < 300
      await resolveObligation(obligationId, {
        outcome: halt ? 'skipped' : landed ? 'pending' : 'failed',
        reason:
          halt ??
          (landed
            ? null
            : pushStatus != null
              ? `HTTP ${pushStatus}`
              : 'flow ran but no operation acted')
      })
    }

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
    // An obligation an unhandled error left open must not sit "pending"
    // forever misreporting the run as still in progress — it errored, and
    // that is known now.
    {
      const { resolveObligation } = await import('./integration-obligations.js')
      await resolveObligation(obligationId, {
        outcome: 'failed',
        reason: `flow errored: ${String(err).slice(0, 400)}`
      })
    }
    // #622: tell the flow's creator the run errored — fire-and-forget,
    // throttled to one notification per flow per hour.
    notifyFlowError(ctx, err)
    throw err
  }
}

// ── Hook firehose / watch-room emits (#283/#287) ────────────────────────────
// Zero cost unless someone has the room open (same posture as the traffic
// feed): membership is checked before anything serializes.
function emitWatch(room: string, event: string, payload: Record<string, unknown>): void {
  void import('./io-holder.js')
    .then(({ getIo }) => {
      const io = getIo()
      if (!io) return
      const r = io.sockets?.adapter?.rooms?.get(`watch:${room}`)
      if (!r || r.size === 0) return
      io.to(`watch:${room}`).emit(event, { ...payload, at: new Date().toISOString() })
    })
    .catch(() => {})
}

export function emitFirehose(kind: string, payload: Record<string, unknown>): void {
  emitWatch('firehose', 'firehose:event', { kind, ...payload })
}
