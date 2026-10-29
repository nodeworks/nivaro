/**
 * Agents working with people: ask_human questions (#3220), agent task assignees (#3223) and
 * agent triggers (#3210, administrators).
 */
import { type Command, cmd } from '../command.js'
import type { ISODate, UUID } from '../index.js'

// ─── Questions (ask_human) ────────────────────────────────────────────────────

export type AgentQuestionStatus = 'open' | 'answered' | 'expired' | 'cancelled'

export interface AgentQuestion {
  id: UUID
  status: AgentQuestionStatus
  question: string
  choices: string[]
  /** false = the answer must be one of the choices. */
  allow_text: boolean
  collection: string | null
  item: string | null
  /** The assistant's name (its OAuth app or API key). */
  asked_by: string
  /** The person the assistant acts for. */
  asked_for: UUID
  asked_for_name: string | null
  recipient: UUID
  recipient_name: string | null
  answer: string | null
  answer_choice: string | null
  answered_at: ISODate | null
  expires_at: ISODate
  created_at: ISODate
  /** Asker only: the connection key it came from and when the answer was collected. */
  connection?: string
  answer_seen_at?: ISODate | null
}

/** Ask a person (default: the caller's own person) a question; it lands in their inbox. */
export function askHuman(body: {
  to?: UUID | 'me'
  question: string
  choices?: string[]
  allow_text?: boolean
  expires_in_minutes?: number
  collection?: string
  item?: string
}): Command<{ data: AgentQuestion }> {
  return cmd('POST', '/agent-questions', undefined, body)
}

/** Read a question; `wait` (0–25 s) holds the request until it is answered. */
export function readAgentQuestion(id: UUID, wait?: number): Command<{ data: AgentQuestion }> {
  return cmd('GET', `/agent-questions/${encodeURIComponent(id)}`, wait ? { wait } : undefined)
}

/** Questions waiting on the caller. `can_answer` is false outside a signed-in browser. */
export function listMyAgentQuestions(): Command<{
  data: AgentQuestion[]
  ready: boolean
  can_answer?: boolean
}> {
  return cmd('GET', '/agent-questions/mine')
}

/** What the calling connection asked (`unseen` = answered, not collected yet). */
export function listAskedQuestions(query?: {
  status?: 'open' | 'unseen' | 'answered' | 'expired' | 'cancelled' | 'all'
  limit?: number
}): Command<{ data: AgentQuestion[] }> {
  return cmd('GET', '/agent-questions/asked', query)
}

/** Answer a question (the person asked, from a signed-in session only). */
export function answerAgentQuestion(
  id: UUID,
  body: { choice?: string; answer?: string }
): Command<{ data: AgentQuestion }> {
  return cmd('POST', `/agent-questions/${encodeURIComponent(id)}/answer`, undefined, body)
}

export function cancelAgentQuestion(id: UUID): Command<{ data: AgentQuestion }> {
  return cmd('POST', `/agent-questions/${encodeURIComponent(id)}/cancel`)
}

// ─── Agent task assignees ─────────────────────────────────────────────────────

export interface TaskAgent {
  /** Connection key: o<grant id> (a connected app) or k<api key id>. */
  conn: string
  kind: 'oauth' | 'api_key'
  name: string
  /** The person the agent acts for — the task's assignee. */
  user_id: UUID
  user_name: string | null
}

/** Agents the caller may hand a task to (their own; `all` for an administrator). */
export function listTaskAgents(opts?: {
  all?: boolean
}): Command<{ data: TaskAgent[]; ready: boolean; me?: string | null }> {
  return cmd('GET', '/tasks/agents', opts?.all ? { all: 1 } : undefined)
}

/** Tasks handed to the calling agent connection. */
export function listAgentTasks(status?: string): Command<{ data: Array<Record<string, unknown>> }> {
  return cmd('GET', '/tasks', { agent: 'mine', ...(status ? { status } : {}) })
}

// ─── Agent triggers (administrators) ──────────────────────────────────────────

export type AgentTriggerEvent = 'create' | 'update' | 'transition'

export interface AgentTrigger {
  id: number
  name: string
  description: string | null
  enabled: boolean
  collection: string
  events: AgentTriggerEvent[]
  conditions: Array<{ field: string; op: string; value: unknown }>
  to_states: string[]
  fields: string[] | null
  instructions: string | null
  url: string
  /** Masked when set. */
  signing_secret: string | null
  /** Values masked. */
  headers: Record<string, string>
  max_attempts: number
  owner: UUID
  owner_name: string | null
  last_fired_at: ISODate | null
  created_at: ISODate
  updated_at: ISODate
  last_7_days?: { delivered: number; dead: number; retrying: number; skipped: number }
}

export interface AgentTriggerDelivery {
  id: number
  trigger_id: number
  delivery_id: UUID
  event: string
  collection: string
  item: string | null
  status: 'sending' | 'retrying' | 'delivered' | 'dead' | 'discarded' | 'skipped'
  attempts: number
  max_attempts: number
  next_attempt_at: ISODate | null
  last_status_code: number | null
  last_error: string | null
  latency_ms: number | null
  delivered_at: ISODate | null
  created_at: ISODate
  request_body?: string | null
  response_body?: string | null
}

export function listAgentTriggers(): Command<{
  data: {
    ready: boolean
    triggers: AgentTrigger[]
    events: AgentTriggerEvent[]
    ops: string[]
    max_attempts_cap: number
  }
}> {
  return cmd('GET', '/agent-triggers')
}

export function listAgentTriggerDeliveries(query?: {
  trigger?: number
  status?: string
  limit?: number
  before?: number
}): Command<{ data: AgentTriggerDelivery[]; has_more: boolean }> {
  return cmd('GET', '/agent-triggers/deliveries', query)
}
