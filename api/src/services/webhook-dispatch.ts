import { createHmac } from 'node:crypto'
import { db } from '../db/index.js'
import { assertSafeUrl } from '../lib/ssrf.js'
import { noteWebhookDelivery } from './traffic-taps/webhooks.js'
import {
  type ConditionRule,
  evalConditionRule,
  fetchRecordForConditions
} from './workflow-conditions.js'

/**
 * Centralized webhook dispatch with delivery logging, HMAC signing and retry support.
 *
 * Every attempt is recorded in nivaro_webhook_deliveries
 * (webhook FK, event, status_code, request_body, response_body, latency_ms, success, attempt).
 */

function parseJson<T>(v: string | null | undefined): T | null {
  if (!v) return null
  if (typeof v !== 'string') return v as T
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

const BODY_TRUNCATE = 10_000 // 10k chars per spec

function truncate(s: string | null | undefined): string | null {
  if (s == null) return null
  return s.length > BODY_TRUNCATE ? `${s.slice(0, BODY_TRUNCATE)}… [truncated]` : s
}

export interface DispatchableWebhook {
  id: number | string
  url: string
  method: string | null
  headers: string | null
  /** Legacy HMAC secret (x-nivaro-signature, lowercase header — kept for back-compat). */
  secret: string | null
  /** New signing secret — adds X-Nivaro-Signature + X-Nivaro-Timestamp headers. */
  signing_secret?: string | null
  collections?: string | null
  events?: string | null
  enabled?: boolean
  /** JSON `[{field, op, value}]`, AND. Empty = every record. */
  conditions?: string | null
}

export const WEBHOOK_CONDITION_OPS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'in',
  'null',
  'nnull'
] as const

export function parseWebhookConditions(raw: unknown): ConditionRule[] {
  const parsed = typeof raw === 'string' ? parseJson<unknown>(raw) : raw
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (r): r is ConditionRule =>
      !!r &&
      typeof r === 'object' &&
      typeof (r as ConditionRule).field === 'string' &&
      (r as ConditionRule).field !== '' &&
      (WEBHOOK_CONDITION_OPS as readonly string[]).includes(String((r as ConditionRule).op))
  )
}

export interface WebhookMatch {
  matches: boolean
  rules: Array<{ field: string; op: string; value: unknown; actual: unknown; pass: boolean }>
}

/**
 * Judge a record against a webhook's conditions. Dotted fields walk M2O
 * relations (the transition-condition resolver); a deleted record is judged
 * on its last snapshot, where only its own columns are known.
 */
export async function matchWebhookConditions(
  conditions: ConditionRule[],
  collection: string,
  data: unknown,
  event: string,
  meta: { origin?: string | null; changed_fields?: string[] } = {}
): Promise<WebhookMatch> {
  if (conditions.length === 0) return { matches: true, rules: [] }
  const snapshot = {
    ...((data && typeof data === 'object' ? data : {}) as Record<string, unknown>),
    // Facts about the WRITE, beside the record's own fields:
    //   $origin   person | machine | import | integration
    //   $changed  the changed field names, comma-joined (use `contains`)
    $origin: meta.origin ?? null,
    $changed: (meta.changed_fields ?? []).join(',')
  } as Record<string, unknown>
  let record = snapshot
  const needsResolve = conditions.some((c) => c.field.includes('.'))
  if (needsResolve && event !== 'delete' && snapshot.id != null) {
    const resolved = await fetchRecordForConditions(collection, String(snapshot.id), [
      JSON.stringify(conditions)
    ])
    record = { ...resolved, ...snapshot }
    for (const c of conditions) if (c.field.includes('.')) record[c.field] = resolved[c.field]
  }
  const rules = conditions.map((c) => ({
    field: c.field,
    op: c.op,
    value: c.value,
    actual: record[c.field] ?? null,
    pass: evalConditionRule(c, record)
  }))
  return { matches: rules.every((r) => r.pass), rules }
}

export interface DispatchResult {
  success: boolean
  status_code: number | null
  latency_ms: number
  error?: string
  delivery_id: number | null
}

async function writeDelivery(entry: {
  webhook: number | string
  /** For the Traffic Map's webhook node label (#1144); never stored. */
  target?: { url?: string | null; name?: unknown }
  event: string
  status_code: number | null
  request_body: string | null
  response_body: string | null
  latency_ms: number
  success: boolean
  attempt: number
}): Promise<number | null> {
  noteWebhookDelivery({
    webhook: { id: entry.webhook, url: entry.target?.url, name: entry.target?.name },
    status: entry.status_code,
    ms: entry.latency_ms,
    success: entry.success
  })
  try {
    const rows = (await db('nivaro_webhook_deliveries')
      .insert({
        webhook: entry.webhook,
        event: entry.event,
        status_code: entry.status_code,
        request_body: truncate(entry.request_body),
        response_body: truncate(entry.response_body),
        latency_ms: entry.latency_ms,
        success: entry.success,
        attempt: entry.attempt,
        created_at: new Date()
      })
      .returning('id')) as unknown[]
    const row = rows[0] as { id: number } | number | undefined
    if (row == null) return null
    return typeof row === 'object' ? row.id : (row as number)
  } catch {
    // Delivery logging must never break dispatch (table may not exist yet)
    return null
  }
}

/**
 * Dispatch a single webhook with the given event + payload.
 * - 15s timeout
 * - SSRF-guarded (initial URL + redirect rejection)
 * - HMAC signing when signing_secret (or legacy secret) is set
 * - Records every attempt to nivaro_webhook_deliveries
 */
export async function dispatchWebhook(
  webhook: DispatchableWebhook,
  event: string,
  payload: unknown,
  attempt = 1
): Promise<DispatchResult> {
  const rawBody = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const method = (webhook.method ?? 'POST').toUpperCase()

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(parseJson<Record<string, string>>(webhook.headers) ?? {})
  }

  // Legacy secret — keep old lowercase header for existing consumers.
  if (webhook.secret) {
    const sig = createHmac('sha256', webhook.secret).update(rawBody).digest('hex')
    headers['x-nivaro-signature'] = `sha256=${sig}`
  }

  // New signing secret — X-Nivaro-Signature + X-Nivaro-Timestamp.
  if (webhook.signing_secret) {
    const sig = createHmac('sha256', webhook.signing_secret).update(rawBody).digest('hex')
    headers['X-Nivaro-Signature'] = `sha256=${sig}`
    headers['X-Nivaro-Timestamp'] = String(Date.now())
  }

  const startMs = Date.now()

  try {
    await assertSafeUrl(webhook.url)
  } catch (err) {
    const latency = Date.now() - startMs
    const message = err instanceof Error ? err.message : 'Unsafe URL blocked'
    const deliveryId = await writeDelivery({
      webhook: webhook.id,
      target: webhook as { url?: string | null; name?: unknown },
      event,
      status_code: null,
      request_body: rawBody,
      response_body: message,
      latency_ms: latency,
      success: false,
      attempt
    })
    return {
      success: false,
      status_code: null,
      latency_ms: latency,
      error: message,
      delivery_id: deliveryId
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)

  const init: RequestInit = { method, headers, signal: controller.signal, redirect: 'manual' }
  if (method !== 'GET' && method !== 'HEAD') init.body = rawBody

  let res: Response | null = null
  let fetchError: string | null = null
  try {
    res = await fetch(webhook.url, init)
  } catch (err) {
    fetchError =
      err instanceof Error
        ? err.name === 'AbortError'
          ? 'Request timed out after 15s'
          : err.message
        : 'Request failed'
  } finally {
    clearTimeout(timer)
  }

  const latency = Date.now() - startMs

  if (fetchError || !res) {
    const deliveryId = await writeDelivery({
      webhook: webhook.id,
      target: webhook as { url?: string | null; name?: unknown },
      event,
      status_code: null,
      request_body: rawBody,
      response_body: fetchError,
      latency_ms: latency,
      success: false,
      attempt
    })
    return {
      success: false,
      status_code: null,
      latency_ms: latency,
      error: fetchError ?? 'Request failed',
      delivery_id: deliveryId
    }
  }

  // Reject redirects — a 3xx to a private host bypasses the initial SSRF check.
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') ?? ''
    try {
      await assertSafeUrl(loc)
    } catch {
      const deliveryId = await writeDelivery({
        webhook: webhook.id,
        target: webhook as { url?: string | null; name?: unknown },
        event,
        status_code: res.status,
        request_body: rawBody,
        response_body: 'Redirect to unsafe URL blocked',
        latency_ms: latency,
        success: false,
        attempt
      })
      return {
        success: false,
        status_code: res.status,
        latency_ms: latency,
        error: 'Redirect to unsafe URL blocked',
        delivery_id: deliveryId
      }
    }
  }

  let responseText: string | null = null
  try {
    responseText = await res.text()
  } catch {
    responseText = null
  }

  const success = res.ok
  const deliveryId = await writeDelivery({
    webhook: webhook.id,
    target: webhook as { url?: string | null; name?: unknown },
    event,
    status_code: res.status,
    request_body: rawBody,
    response_body: responseText,
    latency_ms: latency,
    success,
    attempt
  })

  return { success, status_code: res.status, latency_ms: latency, delivery_id: deliveryId }
}

/**
 * Fire all enabled webhooks matching a collection mutation.
 * Drop-in replacement for the inline fireWebhooks() in hooks/activity.ts —
 * same matching semantics (events list must include event; empty collections = all),
 * but routed through dispatchWebhook for delivery logging + signing.
 *
 * Dispatch is fire-and-forget per webhook; only the DB lookup is awaited.
 */
export async function fireWebhooks(
  collection: string,
  event: 'create' | 'update' | 'delete' | string,
  data: unknown,
  meta: {
    origin?: string | null
    changed_fields?: string[]
    /** Deliver only to webhooks that name this collection — platform tables
     *  (task events, #1008) never reach a webhook left on "all collections". */
    explicitOnly?: boolean
  } = {}
): Promise<void> {
  try {
    const webhooks = (await db('nivaro_webhooks')
      .where({ enabled: true })
      .select('*')) as DispatchableWebhook[]

    const id = (data as { id?: unknown } | null | undefined)?.id
    const payload = {
      event,
      collection,
      item: id == null ? null : String(id),
      // Who made the write (person, machine, import, integration) and, for an
      // update, which fields it changed — so a receiver can skip machine
      // writes or react to one field without diffing records itself.
      origin: meta.origin ?? null,
      changed_fields: event === 'update' ? (meta.changed_fields ?? []) : [],
      data,
      timestamp: new Date().toISOString()
    }

    for (const wh of webhooks) {
      const events = parseJson<string[]>(wh.events ?? null) ?? []
      if (!events.includes(event)) continue

      const collections = parseJson<string[]>(wh.collections ?? null) ?? []
      if (collections.length > 0 && !collections.includes(collection)) continue
      if (meta.explicitOnly && !collections.includes(collection)) continue

      // Conditions narrow a webhook to the records its receiver asked for.
      // A condition set that cannot be judged does NOT fire: sending a
      // partner a record outside its filter is the worse mistake.
      const conditions = parseWebhookConditions(wh.conditions)
      if (conditions.length > 0) {
        try {
          const verdict = await matchWebhookConditions(conditions, collection, data, event, meta)
          if (!verdict.matches) continue
        } catch (err) {
          console.warn(
            `[webhook] ${wh.id}: conditions could not be judged, not fired —`,
            err instanceof Error ? err.message : String(err)
          )
          continue
        }
      }

      // Fire-and-forget — never block the mutation.
      dispatchWebhook(wh, event, payload).catch((err: unknown) => {
        console.warn('[webhook]', err instanceof Error ? err.message : String(err))
      })
    }
  } catch {
    // Non-fatal: webhooks table may not exist, or DB error — never block the mutation.
  }
}
