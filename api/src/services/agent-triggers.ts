import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { tenantState } from './ai-tenant-state.js'
import { MASK } from './secret-mask.js'
import type { ConditionRule } from './workflow-conditions.js'

/**
 * Agent triggers (#3210) — configuration: the rows, their validation, masking
 * and a short per-tenant cache of the enabled ones. Firing and delivery live in
 * services/agent-trigger-delivery.ts.
 *
 * A trigger names a collection, the events that wake it (create / update /
 * transition), an optional condition list (the webhook condition shape, AND)
 * and state filter, and an HTTPS endpoint. Each wake-up posts the record's
 * context — its ids plus the fields the trigger's OWNER may read — signed with
 * the trigger's secret. The owner is a person (the administrator who made it,
 * or the service account they picked): the record is read AS them, so a
 * trigger can never hand an agent more than that person could see.
 */

export const AGENT_TRIGGER_EVENTS = ['create', 'update', 'transition'] as const
export type AgentTriggerEvent = (typeof AGENT_TRIGGER_EVENTS)[number]

export const AGENT_TRIGGER_CONDITION_OPS = [
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

/** Most attempts one delivery may make (the first send included). */
export const MAX_ATTEMPTS_CAP = 10
export const DEFAULT_MAX_ATTEMPTS = 5

export interface AgentTriggerRow {
  id: number
  name: string
  description: string | null
  enabled: boolean | number
  collection: string
  events: string
  conditions: string | null
  to_states: string | null
  fields: string | null
  instructions: string | null
  url: string
  signing_secret: string | null
  headers: string | null
  max_attempts: number
  owner: string
  created_by: string | null
  last_fired_at: Date | string | null
  created_at: Date | string | null
  updated_at: Date | string | null
}

export class AgentTriggerInputError extends Error {
  statusCode = 400
}

const COLLECTION_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,2}$/
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Headers the delivery sets itself — a trigger may not override them. */
const RESERVED_HEADERS = new Set([
  'content-type',
  'content-length',
  'host',
  'user-agent',
  'x-nivaro-signature',
  'x-nivaro-timestamp',
  'x-nivaro-delivery',
  'x-nivaro-event',
  'x-nivaro-attempt',
  'x-nivaro-trigger'
])

export function parseJson<T>(v: unknown): T | null {
  if (v == null || v === '') return null
  if (typeof v !== 'string') return v as T
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

/** Is migration 510 applied on this tenant's database? */
export async function agentTriggersReady(): Promise<boolean> {
  return hasColumn('nivaro_agent_triggers', 'id').catch(() => false)
}

export function triggerEvents(row: Pick<AgentTriggerRow, 'events'>): AgentTriggerEvent[] {
  const raw = parseJson<unknown[]>(row.events) ?? []
  return raw.filter((e): e is AgentTriggerEvent =>
    (AGENT_TRIGGER_EVENTS as readonly string[]).includes(String(e))
  )
}

export function triggerConditions(row: Pick<AgentTriggerRow, 'conditions'>): ConditionRule[] {
  const raw = parseJson<unknown[]>(row.conditions)
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (r): r is ConditionRule =>
      !!r &&
      typeof r === 'object' &&
      typeof (r as ConditionRule).field === 'string' &&
      FIELD_RE.test((r as ConditionRule).field) &&
      (AGENT_TRIGGER_CONDITION_OPS as readonly string[]).includes(String((r as ConditionRule).op))
  )
}

export function triggerStates(row: Pick<AgentTriggerRow, 'to_states'>): string[] {
  const raw = parseJson<unknown[]>(row.to_states)
  return Array.isArray(raw) ? raw.map(String).filter(Boolean) : []
}

export function triggerFields(row: Pick<AgentTriggerRow, 'fields'>): string[] | null {
  const raw = parseJson<unknown[]>(row.fields)
  if (!Array.isArray(raw)) return null
  const out = raw.map(String).filter((f) => FIELD_RE.test(f))
  return out.length ? out : null
}

export function triggerHeaders(row: Pick<AgentTriggerRow, 'headers'>): Record<string, string> {
  const raw = parseJson<Record<string, unknown>>(row.headers)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (HEADER_RE.test(k) && !RESERVED_HEADERS.has(k.toLowerCase()) && v != null) out[k] = String(v)
  }
  return out
}

/** The shape an administrator reads: secret and header values masked. */
export function maskTrigger(row: AgentTriggerRow & { owner_name?: string | null }) {
  const headers = triggerHeaders(row)
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: !!row.enabled,
    collection: row.collection,
    events: triggerEvents(row),
    conditions: triggerConditions(row),
    to_states: triggerStates(row),
    fields: triggerFields(row),
    instructions: row.instructions,
    url: row.url,
    signing_secret: row.signing_secret ? MASK : null,
    headers: Object.fromEntries(Object.keys(headers).map((k) => [k, MASK])),
    max_attempts: row.max_attempts,
    owner: row.owner,
    owner_name: row.owner_name ?? null,
    created_by: row.created_by,
    last_fired_at: row.last_fired_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

/** An agent endpoint must be HTTPS: a signed record context never travels in the clear. */
export function validateEndpoint(raw: unknown): string {
  const s = String(raw ?? '').trim()
  if (!s) throw new AgentTriggerInputError('url is required')
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new AgentTriggerInputError('url must be a full https:// address')
  }
  if (u.protocol !== 'https:') throw new AgentTriggerInputError('url must use https://')
  if (u.username || u.password)
    throw new AgentTriggerInputError('Put credentials in a header, not in the url')
  if (s.length > 2000) throw new AgentTriggerInputError('url is too long')
  return u.toString()
}

export interface TriggerInput {
  name?: unknown
  description?: unknown
  enabled?: unknown
  collection?: unknown
  events?: unknown
  conditions?: unknown
  to_states?: unknown
  fields?: unknown
  instructions?: unknown
  url?: unknown
  signing_secret?: unknown
  headers?: unknown
  max_attempts?: unknown
  owner?: unknown
}

/**
 * Validate a create (no `existing`) or a patch. Returns the columns to write.
 * A masked secret or masked header value sent back keeps the stored one.
 */
export function normalizeTriggerInput(
  input: TriggerInput,
  existing?: AgentTriggerRow
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const creating = !existing
  const has = (k: keyof TriggerInput) => input[k] !== undefined

  if (creating || has('name')) {
    const name = String(input.name ?? '').trim()
    if (!name) throw new AgentTriggerInputError('name is required')
    out.name = name.slice(0, 200)
  }
  if (has('description')) out.description = input.description ? String(input.description) : null
  if (has('enabled')) out.enabled = !!input.enabled
  if (creating || has('collection')) {
    const c = String(input.collection ?? '').trim()
    if (!COLLECTION_RE.test(c)) throw new AgentTriggerInputError('collection is required')
    if (/^(nivaro|directus)_/i.test(c))
      throw new AgentTriggerInputError('Agent triggers cannot watch system tables')
    out.collection = c
  }
  if (creating || has('events')) {
    const list = Array.isArray(input.events) ? input.events.map(String) : []
    const events = [...new Set(list)].filter((e) =>
      (AGENT_TRIGGER_EVENTS as readonly string[]).includes(e)
    )
    if (events.length === 0)
      throw new AgentTriggerInputError('Pick at least one event: create, update or transition')
    out.events = JSON.stringify(events)
  }
  if (has('conditions')) {
    const list = Array.isArray(input.conditions) ? input.conditions : []
    const rules = triggerConditions({ conditions: JSON.stringify(list) }).map((r) => ({
      field: r.field,
      op: r.op,
      value: r.value ?? null
    }))
    if (rules.length !== list.length)
      throw new AgentTriggerInputError(
        `Each condition needs a field and one of: ${AGENT_TRIGGER_CONDITION_OPS.join(', ')}`
      )
    out.conditions = rules.length ? JSON.stringify(rules.slice(0, 20)) : null
  }
  if (has('to_states')) {
    const list = Array.isArray(input.to_states)
      ? input.to_states.map((s) => String(s).trim()).filter(Boolean)
      : []
    out.to_states = list.length ? JSON.stringify([...new Set(list)].slice(0, 50)) : null
  }
  if (has('fields')) {
    const list = Array.isArray(input.fields) ? input.fields.map(String) : []
    const bad = list.find((f) => !FIELD_RE.test(f))
    if (bad) throw new AgentTriggerInputError(`"${bad}" is not a field name`)
    out.fields = list.length ? JSON.stringify([...new Set(list)].slice(0, 200)) : null
  }
  if (has('instructions'))
    out.instructions = input.instructions ? String(input.instructions).slice(0, 8000) : null
  if (creating || has('url')) out.url = validateEndpoint(input.url)
  if (has('signing_secret') && input.signing_secret !== MASK) {
    const s = input.signing_secret ? String(input.signing_secret) : ''
    if (s && s.length < 16)
      throw new AgentTriggerInputError('The signing secret must be at least 16 characters')
    out.signing_secret = s ? s.slice(0, 200) : null
  }
  if (has('headers')) {
    const raw = input.headers
    if (raw != null && (typeof raw !== 'object' || Array.isArray(raw)))
      throw new AgentTriggerInputError('headers must be an object of name: value')
    const stored = existing ? triggerHeaders(existing) : {}
    const next: Record<string, string> = {}
    for (const [k, v] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
      if (!HEADER_RE.test(k)) throw new AgentTriggerInputError(`"${k}" is not a header name`)
      if (RESERVED_HEADERS.has(k.toLowerCase()))
        throw new AgentTriggerInputError(`${k} is set by Nivaro and cannot be overridden`)
      if (v === MASK) {
        if (stored[k] !== undefined) next[k] = stored[k]
        continue
      }
      if (v == null || v === '') continue
      next[k] = String(v).slice(0, 4000)
    }
    out.headers = Object.keys(next).length ? JSON.stringify(next) : null
  }
  if (creating || has('max_attempts')) {
    const n = input.max_attempts == null ? DEFAULT_MAX_ATTEMPTS : Number(input.max_attempts)
    if (!Number.isInteger(n) || n < 1 || n > MAX_ATTEMPTS_CAP)
      throw new AgentTriggerInputError(`max_attempts must be 1 to ${MAX_ATTEMPTS_CAP}`)
    out.max_attempts = n
  }
  if (has('owner')) {
    const o = String(input.owner ?? '')
    if (!UUID.test(o)) throw new AgentTriggerInputError('owner must be a user id')
    out.owner = o
  }
  return out
}

/** The owner must be an active person or service account (never a placeholder). */
export async function assertUsableOwner(userId: string): Promise<void> {
  const u = (await db('nivaro_users').where({ id: userId }).first('id', 'status')) as
    | { id: string; status: string }
    | undefined
  if (!u) throw new AgentTriggerInputError('Unknown owner')
  if (u.status !== 'active') throw new AgentTriggerInputError('The owner must be an active user')
}

// ─── Enabled triggers, cached per tenant ─────────────────────────────────────

const CACHE_MS = 30_000
const cache = tenantState(() => ({
  at: 0,
  rows: [] as AgentTriggerRow[],
  loading: null as Promise<AgentTriggerRow[]> | null
}))

export function bustAgentTriggerCache(): void {
  const c = cache()
  c.at = 0
  c.loading = null
}

async function enabledTriggers(): Promise<AgentTriggerRow[]> {
  const c = cache()
  if (Date.now() - c.at < CACHE_MS) return c.rows
  if (c.loading) return c.loading
  c.loading = (async () => {
    try {
      if (!(await agentTriggersReady())) return []
      const rows = (await db('nivaro_agent_triggers')
        .where({ enabled: true })
        .select('*')) as AgentTriggerRow[]
      c.rows = rows
      c.at = Date.now()
      return rows
    } catch {
      return c.rows
    } finally {
      c.loading = null
    }
  })()
  return c.loading
}

/** Enabled triggers for this collection that listen for this event. */
export async function triggersFor(
  collection: string,
  event: AgentTriggerEvent
): Promise<AgentTriggerRow[]> {
  if (!collection || /^(nivaro|directus)_/i.test(collection)) return []
  const rows = await enabledTriggers()
  return rows.filter((r) => r.collection === collection && triggerEvents(r).includes(event))
}
