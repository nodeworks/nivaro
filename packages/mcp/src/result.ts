/**
 * Tool results and error shaping.
 *
 * Every tool answers JSON text. A failure answers `isError: true` with the
 * API's own message, status and code — never a stack, never the request body.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/** Detail keys the API attaches to a refusal that a caller can act on. */
const DETAIL_KEYS = [
  'violations',
  'conflicts',
  'fields',
  'rule',
  'existing_id',
  'max',
  'current',
  'scope',
  'nested',
  'keys',
  'matched_id',
  'first',
  'remaining',
  'fields_changed',
  'reasons',
  'allow_free_text'
] as const

export interface ToolFailure {
  error: string
  status?: number
  code?: string
  details?: Record<string, unknown>
}

/** The JSON text block every successful tool answers with. */
export function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

/** Turn a thrown SDK/API error into a client-safe failure result. */
export function fail(err: unknown): CallToolResult {
  const failure = describeFailure(err)
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(failure, null, 2) }]
  }
}

/** A refusal the tool itself raised (a guard, a bad argument). */
export function refuse(message: string, code: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: message, code }, null, 2) }]
  }
}

export function describeFailure(err: unknown): ToolFailure {
  if (!(err instanceof Error)) return { error: String(err) }
  const e = err as Error & { status?: unknown; response?: unknown }
  const out: ToolFailure = { error: err.message || 'Request failed' }
  if (typeof e.status === 'number') out.status = e.status
  const response = e.response
  if (response && typeof response === 'object') {
    const body = response as Record<string, unknown>
    if (typeof body.code === 'string') out.code = body.code
    const details: Record<string, unknown> = {}
    for (const key of DETAIL_KEYS) {
      if (body[key] !== undefined) details[key] = body[key]
    }
    if (Object.keys(details).length > 0) out.details = details
  }
  if (!out.status && e.message.startsWith('fetch failed')) {
    out.code = 'NETWORK_ERROR'
  }
  return out
}

/** `nvk_abcd…1234` — enough to recognise a key, never enough to use it. */
export function maskToken(token: string): string {
  if (token.length <= 10) return '••••••'
  return `${token.slice(0, 6)}…${token.slice(-4)}`
}
