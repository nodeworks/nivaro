import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import { safeFetch } from '../lib/ssrf.js'
import {
  type AgentTriggerEvent,
  type AgentTriggerRow,
  agentTriggersReady,
  triggerConditions,
  triggerFields,
  triggerHeaders,
  triggerStates,
  triggersFor
} from './agent-triggers.js'
import { signWebhookBody } from './webhook-signature.js'

/**
 * Agent triggers (#3210) — firing and delivery.
 *
 *   fireAgentTriggers(event)   a record event: match triggers, build each one's context AS its
 *                              owner, store a delivery row and send it at once
 *   drainDueDeliveries()       retries that are due (the agent-trigger-retries cron, and a local
 *                              timer set when a retry is scheduled)
 *   retryDelivery / discardDelivery / sendTestWakeUp   the administrator's actions
 *
 * The body is JSON, signed: `X-Nivaro-Signature: sha256=<hex>` over `<timestamp>.<raw body>`
 * with `X-Nivaro-Timestamp` (unix seconds), the same convention inbound webhook flows verify
 * (services/webhook-signature.ts). `X-Nivaro-Delivery` stays the same across retries, so a
 * receiver can drop a repeat. Sent through safeFetch (SSRF guard, pinned address), never
 * following a redirect, 15 s per attempt.
 *
 * Retries back off (30 s, 2 min, 10 min, 30 min, 2 h, 6 h…) up to the trigger's max attempts;
 * a 4xx other than 408/409/425/429 is final at once. A delivery that gives up is DEAD — the
 * dead letters an administrator retries or discards — and its owner is told once.
 */

export interface AgentEvent {
  collection: string
  item: string
  /** 'flow' = woken by a flow's Wake an agent operation (the flow did the matching). */
  event: AgentTriggerEvent | 'flow'
  /** create/update: the written row, used for conditions (no extra read). */
  data?: Record<string, unknown> | null
  changed_fields?: string[]
  origin?: string | null
  actor?: string | null
  transition?: {
    label?: string | null
    source?: string | null
    comment?: string | null
    from_state?: { key?: string | null; label?: string | null } | null
    to_state?: { key?: string | null; label?: string | null } | null
  } | null
}

export interface DeliveryRow {
  id: number | string
  trigger_id: number
  delivery_key: string
  event: string
  collection: string
  item: string | null
  status: string
  attempts: number
  max_attempts: number
  next_attempt_at: Date | string | null
  claimed_at: Date | string | null
  last_status_code: number | null
  last_error: string | null
  latency_ms: number | null
  request_body: string | null
  response_body: string | null
  delivered_at: Date | string | null
  created_at: Date | string | null
  updated_at: Date | string | null
}

export const ATTEMPT_TIMEOUT_MS = 15_000
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000]
/** A delivery claimed this long ago by a process that never finished is claimed again. */
const STALE_CLAIM_MS = 5 * 60_000
const MAX_BODY = 256 * 1024
const RESPONSE_KEEP = 4000

export function backoffMs(attemptsMade: number): number {
  return BACKOFF_MS[Math.min(Math.max(attemptsMade - 1, 0), BACKOFF_MS.length - 1)]
}

/** Whether a failed answer is worth another attempt. */
export function retryable(status: number | null): boolean {
  if (status == null) return true
  if (status >= 500) return true
  return [408, 409, 425, 429].includes(status)
}

const errText = (err: unknown) =>
  err instanceof Error
    ? err.name === 'AbortError' || err.name === 'TimeoutError'
      ? `No answer within ${ATTEMPT_TIMEOUT_MS / 1000} s`
      : err.message
    : String(err)

// ─── Matching ────────────────────────────────────────────────────────────────

/** Does this event pass the trigger's state filter and conditions? */
export async function eventMatches(
  trigger: Pick<AgentTriggerRow, 'conditions' | 'to_states'>,
  ev: AgentEvent
): Promise<boolean> {
  if (ev.event === 'transition') {
    const states = triggerStates(trigger)
    const to = ev.transition?.to_state?.key ?? null
    if (states.length && (!to || !states.includes(to))) return false
  }
  const conditions = triggerConditions(trigger)
  if (conditions.length === 0) return true
  const { matchWebhookConditions } = await import('./webhook-dispatch.js')
  // A transition carries no row: judge the record as it is now.
  let data = ev.data ?? null
  if (!data) {
    const { fetchRecordForConditions } = await import('./workflow-conditions.js')
    data = await fetchRecordForConditions(ev.collection, ev.item, [JSON.stringify(conditions)])
  }
  const verdict = await matchWebhookConditions(
    conditions,
    ev.collection,
    { ...data, id: data?.id ?? ev.item },
    ev.event === 'transition' ? 'update' : ev.event,
    { origin: ev.origin ?? null, changed_fields: ev.changed_fields ?? [] }
  )
  return verdict.matches
}

// ─── Context ─────────────────────────────────────────────────────────────────

type ContextResult =
  | { ok: true; body: Record<string, unknown>; truncated: boolean }
  | { ok: false; reason: string }

/**
 * The wake-up body: who/what/why plus the record AS THE OWNER READS IT (every
 * read gate applies — role, field list, User Scopes, row filters). A record the
 * owner cannot see is never sent: the delivery is skipped and says why.
 */
export async function buildWakeBody(
  trigger: AgentTriggerRow,
  ev: AgentEvent,
  deliveryKey: string
): Promise<ContextResult> {
  const { getUser } = await import('./users.js')
  const owner = await getUser(trigger.owner).catch(() => undefined)
  if (!owner) return { ok: false, reason: 'The trigger owner no longer exists' }
  if (owner.status !== 'active') return { ok: false, reason: 'The trigger owner is not active' }
  const { readOne } = await import('./items.js')
  const wanted = triggerFields(trigger)
  let record: Record<string, unknown> | null = null
  try {
    record = (await readOne(
      owner,
      ev.collection,
      ev.item,
      undefined,
      wanted ? [...new Set(['id', ...wanted])] : undefined
    )) as Record<string, unknown> | null
  } catch (err) {
    const code = (err as { statusCode?: number })?.statusCode
    if (code === 403 || code === 404) record = null
    else throw err
  }
  if (!record) return { ok: false, reason: 'The trigger owner cannot read this record' }
  const { isOutOfView } = await import('./items.js')
  if (isOutOfView(record)) return { ok: false, reason: 'The trigger owner cannot read this record' }

  let link: string | null = null
  try {
    const { recordLink } = await import('./app-links.js')
    link = await recordLink(ev.collection, ev.item, { recipientUserId: owner.id })
  } catch {
    link = null
  }
  let mcpUrl: string | null = null
  try {
    const { mcpResourceUrl } = await import('./mcp-config.js')
    mcpUrl = mcpResourceUrl()
  } catch {
    mcpUrl = null
  }

  const body: Record<string, unknown> = {
    type: 'nivaro.agent_trigger',
    delivery_id: deliveryKey,
    occurred_at: new Date().toISOString(),
    trigger: { id: trigger.id, name: trigger.name },
    instructions: trigger.instructions ?? null,
    event: ev.event,
    collection: ev.collection,
    item: ev.item,
    origin: ev.origin ?? null,
    changed_fields: ev.event === 'update' ? (ev.changed_fields ?? []) : [],
    transition:
      ev.event === 'transition' && ev.transition
        ? {
            label: ev.transition.label ?? null,
            source: ev.transition.source ?? null,
            from_state: ev.transition.from_state ?? null,
            to_state: ev.transition.to_state ?? null
          }
        : null,
    record,
    link,
    mcp_url: mcpUrl
  }
  let truncated = false
  if (JSON.stringify(body).length > MAX_BODY) {
    body.record = { id: record.id ?? ev.item }
    body.record_truncated = true
    truncated = true
  }
  return { ok: true, body, truncated }
}

// ─── Store + send ────────────────────────────────────────────────────────────

async function insertDelivery(row: Record<string, unknown>): Promise<DeliveryRow | null> {
  const now = new Date()
  await db('nivaro_agent_trigger_deliveries').insert({
    created_at: now,
    updated_at: now,
    ...row
  })
  return ((await db('nivaro_agent_trigger_deliveries')
    .where({ delivery_key: row.delivery_key })
    .first()) ?? null) as DeliveryRow | null
}

/** Build, store and send one wake-up (the first attempt runs now, in this process). */
export async function queueWakeUp(
  trigger: AgentTriggerRow,
  ev: AgentEvent
): Promise<{ delivery: DeliveryRow | null; skipped?: string }> {
  const key = randomUUID()
  const built = await buildWakeBody(trigger, ev, key)
  const base = {
    trigger_id: trigger.id,
    delivery_key: key,
    event: ev.event,
    collection: ev.collection,
    item: ev.item,
    max_attempts: trigger.max_attempts || 1
  }
  if (!built.ok) {
    const delivery = await insertDelivery({
      ...base,
      status: 'skipped',
      attempts: 0,
      last_error: built.reason
    })
    return { delivery, skipped: built.reason }
  }
  const delivery = await insertDelivery({
    ...base,
    status: 'sending',
    attempts: 0,
    claimed_at: new Date(),
    request_body: JSON.stringify(built.body)
  })
  await db('nivaro_agent_triggers')
    .where({ id: trigger.id })
    .update({ last_fired_at: new Date() })
    .catch(() => undefined)
  if (!delivery) return { delivery: null }
  return { delivery: await attemptClaimed(delivery, trigger) }
}

export interface SendOutcome {
  ok: boolean
  status: number | null
  latency_ms: number
  response: string | null
  error: string | null
}

/** One signed POST. Leaf of the delivery: no database. */
export async function sendSigned(input: {
  url: string
  body: string
  secret: string | null
  headers: Record<string, string>
  deliveryKey: string
  event: string
  triggerId: number
  attempt: number
  fetchImpl?: typeof safeFetch
  nowMs?: number
}): Promise<SendOutcome> {
  const ts = String(Math.floor((input.nowMs ?? Date.now()) / 1000))
  const headers: Record<string, string> = {
    ...input.headers,
    'content-type': 'application/json',
    'user-agent': 'Nivaro-Agent-Trigger/1',
    'x-nivaro-delivery': input.deliveryKey,
    'x-nivaro-event': input.event,
    'x-nivaro-attempt': String(input.attempt),
    'x-nivaro-trigger': String(input.triggerId),
    'x-nivaro-timestamp': ts
  }
  if (input.secret) headers['x-nivaro-signature'] = signWebhookBody(input.secret, input.body, ts)
  const started = Date.now()
  try {
    const res = await (input.fetchImpl ?? safeFetch)(input.url, {
      method: 'POST',
      headers,
      body: input.body,
      redirect: 'manual',
      timeoutMs: ATTEMPT_TIMEOUT_MS
    })
    const text = await res.text().catch(() => '')
    const latency = Date.now() - started
    if (res.status >= 300 && res.status < 400)
      return {
        ok: false,
        status: res.status,
        latency_ms: latency,
        response: text.slice(0, RESPONSE_KEEP),
        error: 'The endpoint answered with a redirect; agent triggers never follow one'
      }
    return {
      ok: res.ok,
      status: res.status,
      latency_ms: latency,
      response: text.slice(0, RESPONSE_KEEP),
      error: res.ok ? null : `HTTP ${res.status}`
    }
  } catch (err) {
    return {
      ok: false,
      status: null,
      latency_ms: Date.now() - started,
      response: null,
      error: errText(err).slice(0, 1000)
    }
  }
}

async function loadTrigger(id: number): Promise<AgentTriggerRow | null> {
  return ((await db('nivaro_agent_triggers').where({ id }).first()) ??
    null) as AgentTriggerRow | null
}

/** Send a delivery this process has claimed; record the outcome and what happens next. */
export async function attemptClaimed(
  row: DeliveryRow,
  trigger?: AgentTriggerRow | null
): Promise<DeliveryRow> {
  const t = trigger ?? (await loadTrigger(row.trigger_id))
  const now = new Date()
  const finish = async (patch: Record<string, unknown>): Promise<DeliveryRow> => {
    await db('nivaro_agent_trigger_deliveries')
      .where({ id: row.id })
      .update({ ...patch, updated_at: new Date() })
    return { ...row, ...patch } as DeliveryRow
  }
  if (!t) return finish({ status: 'discarded', last_error: 'The trigger was deleted' })
  if (!t.enabled && row.event !== 'test')
    return finish({ status: 'discarded', last_error: 'The trigger was turned off' })

  const attempt = Number(row.attempts ?? 0) + 1
  const out = await sendSigned({
    url: t.url,
    body: row.request_body ?? '{}',
    secret: t.signing_secret,
    headers: triggerHeaders(t),
    deliveryKey: row.delivery_key,
    event: row.event,
    triggerId: t.id,
    attempt
  })
  const common = {
    attempts: attempt,
    last_status_code: out.status,
    latency_ms: out.latency_ms,
    response_body: out.response,
    last_error: out.error,
    claimed_at: null
  }
  if (out.ok)
    return finish({ ...common, status: 'delivered', delivered_at: now, next_attempt_at: null })
  const max = Math.max(1, Number(row.max_attempts) || 1)
  if (attempt >= max || !retryable(out.status) || row.event === 'test') {
    const dead = await finish({ ...common, status: 'dead', next_attempt_at: null })
    if (row.event !== 'test') void tellOwner(t, dead)
    return dead
  }
  const next = new Date(Date.now() + backoffMs(attempt))
  const queued = await finish({ ...common, status: 'retrying', next_attempt_at: next })
  scheduleLocalDrain(next.getTime())
  return queued
}

/** The owner hears once that a wake-up gave up (they can retry it from the dead letters). */
async function tellOwner(t: AgentTriggerRow, d: DeliveryRow): Promise<void> {
  try {
    const { getApp } = await import('./io-holder.js')
    const app = getApp()
    if (!app) return
    const { notifyUser } = await import('./notification-channels.js')
    const { adminBaseUrl } = await import('../admin-base.js')
    const base = adminBaseUrl()
    await notifyUser(app, t.owner, {
      subject: `Agent trigger failed: ${t.name}`,
      message: `Waking the agent for ${d.collection}/${d.item ?? ''} failed after ${d.attempts} attempt${d.attempts === 1 ? '' : 's'}: ${d.last_error ?? 'no answer'}. Retry it from MCP → Agent triggers.`,
      category: 'integrations',
      target: base
        ? { kind: 'external', url: `${base.replace(/\/$/, '')}/mcp/triggers?trigger=${t.id}` }
        : null,
      source: { kind: 'agent-trigger', label: t.name, id: t.id },
      why: 'you own this agent trigger'
    })
  } catch {
    /* best effort */
  }
}

// ─── Retries ─────────────────────────────────────────────────────────────────

/** Claim one due row (status + attempts unchanged since we read it): true = ours. */
async function claim(row: DeliveryRow): Promise<boolean> {
  const n = await db('nivaro_agent_trigger_deliveries')
    .where({ id: row.id, status: row.status, attempts: row.attempts })
    .update({ status: 'sending', claimed_at: new Date(), updated_at: new Date() })
  return Number(n) === 1
}

let lastPrune = 0
const PRUNE_EVERY_MS = 3_600_000

/** Old finished rows go: delivered/discarded after 30 days, skipped after 7, dead after 90. */
export async function pruneDeliveries(): Promise<void> {
  const day = 86_400_000
  const now = Date.now()
  const rules: Array<[string, number]> = [
    ['delivered', 30],
    ['discarded', 30],
    ['skipped', 7],
    ['dead', 90]
  ]
  for (const [status, days] of rules) {
    await db('nivaro_agent_trigger_deliveries')
      .where({ status })
      .where('created_at', '<', new Date(now - days * day))
      .delete()
      .catch(() => undefined)
  }
}

/** Send every retry that is due (and every claim a dead process left behind). */
export async function drainDueDeliveries(limit = 25): Promise<number> {
  if (!(await agentTriggersReady())) return 0
  const now = new Date()
  const due = (await db('nivaro_agent_trigger_deliveries')
    .where((w) =>
      w
        .where((r) => r.where('status', 'retrying').where('next_attempt_at', '<=', now))
        .orWhere((s) =>
          s
            .where('status', 'sending')
            .where('claimed_at', '<', new Date(now.getTime() - STALE_CLAIM_MS))
        )
    )
    .orderBy('next_attempt_at', 'asc')
    .limit(limit)
    .select('*')) as DeliveryRow[]
  let sent = 0
  for (const row of due) {
    if (!(await claim(row))) continue
    await attemptClaimed({ ...row, status: 'sending' }).catch(() => undefined)
    sent++
  }
  if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
    lastPrune = Date.now()
    await pruneDeliveries()
  }
  return sent
}

/** A timer in this process for the next retry, so retries also run where crons do not tick. */
function scheduleLocalDrain(atMs: number): void {
  const wait = Math.max(1000, Math.min(atMs - Date.now() + 250, 2_147_000_000))
  const t = setTimeout(() => {
    runInBackgroundPool(() => drainDueDeliveries()).catch(() => undefined)
  }, wait)
  t.unref?.()
}

/** Administrator: send a dead (or skipped-by-error) delivery once more, now. */
export async function retryDelivery(id: number): Promise<DeliveryRow | null> {
  const row = (await db('nivaro_agent_trigger_deliveries').where({ id }).first()) as
    | DeliveryRow
    | undefined
  if (!row) return null
  if (!['dead', 'retrying'].includes(row.status) || !row.request_body)
    throw Object.assign(new Error(`A ${row.status} delivery cannot be retried`), {
      statusCode: 409
    })
  // One more attempt beyond what it has made, whatever the trigger's limit.
  const n = await db('nivaro_agent_trigger_deliveries')
    .where({ id, status: row.status, attempts: row.attempts })
    .update({
      status: 'sending',
      claimed_at: new Date(),
      max_attempts: Number(row.attempts) + 1,
      updated_at: new Date()
    })
  if (Number(n) !== 1)
    throw Object.assign(new Error('Someone else is sending it right now'), { statusCode: 409 })
  return attemptClaimed({ ...row, status: 'sending', max_attempts: Number(row.attempts) + 1 })
}

export async function discardDelivery(id: number): Promise<boolean> {
  const n = await db('nivaro_agent_trigger_deliveries')
    .where({ id })
    .whereIn('status', ['dead', 'retrying'])
    .update({ status: 'discarded', next_attempt_at: null, updated_at: new Date() })
  return Number(n) === 1
}

/** A signed test ping (no record), stored in the log as event 'test'. */
export async function sendTestWakeUp(trigger: AgentTriggerRow): Promise<DeliveryRow | null> {
  const key = randomUUID()
  const body = {
    type: 'nivaro.agent_trigger.test',
    delivery_id: key,
    occurred_at: new Date().toISOString(),
    trigger: { id: trigger.id, name: trigger.name },
    instructions: trigger.instructions ?? null,
    event: 'test',
    collection: trigger.collection,
    item: null,
    record: null
  }
  const delivery = await insertDelivery({
    trigger_id: trigger.id,
    delivery_key: key,
    event: 'test',
    collection: trigger.collection,
    item: null,
    status: 'sending',
    attempts: 0,
    max_attempts: 1,
    claimed_at: new Date(),
    request_body: JSON.stringify(body)
  })
  return delivery ? attemptClaimed(delivery, trigger) : null
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * A record event: every enabled trigger it matches is woken. Never throws, never blocks the
 * write that caused it (callers fire-and-forget; the work runs on the background pool).
 */
export async function fireAgentTriggers(ev: AgentEvent): Promise<number> {
  try {
    if (!ev.collection || ev.item == null || ev.item === '' || ev.event === 'flow') return 0
    const triggers = await triggersFor(ev.collection, ev.event)
    if (triggers.length === 0) return 0
    let fired = 0
    for (const t of triggers) {
      try {
        if (!(await eventMatches(t, ev))) continue
        await queueWakeUp(t, ev)
        fired++
      } catch (err) {
        console.warn(
          `[agent-trigger] ${t.id}: not fired —`,
          err instanceof Error ? err.message : String(err)
        )
      }
    }
    return fired
  } catch {
    return 0
  }
}
