import { AsyncLocalStorage } from 'node:async_hooks'
import { db } from '../db/index.js'

/**
 * How one model call was made (#2471 routing, #2765 tool payloads, #2737
 * reuse), carried to the call log (`nivaro_ai_calls.meta`, migration 469).
 * The caller wraps a call in `withAiCallMeta(meta, fn)`; the log reads the
 * meta when the call BEGINS, so a stream that finishes later keeps it.
 */

export interface AiCallRouting {
  /** Which model answered this call: the small one, or the feature's main one. */
  tier: 'cheap' | 'main'
  /** The feature's main model — what a cheap call is priced against. */
  main_model: string
  cheap_model: string
  /** Why the call moved up to the main model (absent on a cheap call). */
  reason?: 'tool_error' | 'proposal' | 'cannot_answer' | 'invalid_json' | 'try_harder'
  /** The cheap attempt was thrown away and the question run again from the start. */
  rerun?: boolean
  /** "Try harder": the request whose cheap answer this one replaces. */
  retry_of?: string
}

/** Per tool: the results this call carried, as estimated tokens. */
export interface ToolPayloadStat {
  calls: number
  /** Readable JSON (repeated objects) — what the model used to be sent. */
  before: number
  /** What was sent (compact tables). */
  after: number
  /** How many of the calls were served from the conversation's store. */
  reused: number
}

export interface AiCallMeta {
  routing?: AiCallRouting
  tool_payload?: Record<string, ToolPayloadStat>
}

const store = new AsyncLocalStorage<AiCallMeta>()

export function withAiCallMeta<T>(meta: AiCallMeta | null | undefined, fn: () => T): T {
  if (!meta || Object.keys(meta).length === 0) return fn()
  return store.run(meta, fn)
}

export function currentAiCallMeta(): AiCallMeta | null {
  return store.getStore() ?? null
}

/** The meta as stored: compact JSON, null when there is nothing to say. */
export function serializeAiCallMeta(meta: AiCallMeta | null): string | null {
  if (!meta) return null
  const out: AiCallMeta = {}
  if (meta.routing) out.routing = meta.routing
  if (meta.tool_payload && Object.keys(meta.tool_payload).length)
    out.tool_payload = meta.tool_payload
  return Object.keys(out).length ? JSON.stringify(out).slice(0, 8000) : null
}

export function parseAiCallMeta(raw: unknown): AiCallMeta | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as AiCallMeta) : null
  } catch {
    return null
  }
}

let metaColumn: { at: number; ok: boolean } | null = null

/** Whether migration 469 reached this database — rechecked every minute until it has. */
export async function aiCallMetaSupported(): Promise<boolean> {
  if (metaColumn && (metaColumn.ok || Date.now() - metaColumn.at < 60_000)) return metaColumn.ok
  let ok = false
  try {
    ok = await db.schema.hasColumn('nivaro_ai_calls', 'meta')
  } catch {
    ok = false
  }
  metaColumn = { at: Date.now(), ok }
  return ok
}

/** Tests only. */
export function resetAiCallMetaSupport(): void {
  metaColumn = null
}
