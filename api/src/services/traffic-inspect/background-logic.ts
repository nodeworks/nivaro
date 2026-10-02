// api/src/services/traffic-inspect/background-logic.ts
/**
 * Pure helpers for the "background" inspect group (AI calls, job runs, flow runs, partner
 * pushes): id shapes, which run covers a moment, body masking, attempt shaping. No database —
 * background.ts reads, these decide, so the rules are tested without one.
 */
import { MASK, maskBodySecrets } from '../secret-mask.js'

/** Positive integer ids (nivaro_ai_calls bigint, nivaro_job_runs / nivaro_erp_submissions int). */
export const DIGITS_RE = /^[1-9][0-9]{0,17}$/
/** nivaro_flow_runs ids are uniqueidentifiers. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isDigitsId(id: string): boolean {
  return DIGITS_RE.test(id) && Number.isSafeInteger(Number(id))
}

export function isUuid(id: string): boolean {
  return UUID_RE.test(id)
}

/** A traffic event's `run` (the background source): `cron:<job id>` or `flow:<flow id>`. */
export type RunSource = { kind: 'cron'; job: string } | { kind: 'flow'; flowId: string }

/** Parse a background source id; null for anything else (`import:worker`, `socket:x`, junk). */
export function parseRunSource(raw: unknown): RunSource | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (s.length < 6 || s.length > 220) return null
  const cut = s.indexOf(':')
  if (cut <= 0) return null
  const kind = s.slice(0, cut)
  const rest = s.slice(cut + 1)
  if (kind === 'cron') {
    // Job ids carry colons for extension jobs (`ext:efp-ops:invoice-approval-notifications`).
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(rest)) return null
    return { kind: 'cron', job: rest }
  }
  if (kind === 'flow') return isUuid(rest) ? { kind: 'flow', flowId: rest } : null
  return null
}

export interface RunWindow {
  id: string | number
  started: number
  /** Epoch ms; null = still running (or never closed). */
  finished: number | null
}

export interface CoveringPick {
  id: string
  /** True when the run's own window contains the moment; false = the closest earlier run. */
  covering: boolean
  started: number
  finished: number | null
}

/** How far outside a run's recorded window a moment may sit and still count as that run. */
export const COVER_TOLERANCE_MS = 2_000
/** No covering run → the newest run that STARTED this close before the moment instead. */
export const NEAREST_MAX_MS = 15 * 60_000

/**
 * The run of one job that a moment belongs to: the newest run whose window (± a small
 * tolerance — events and run rows are stamped by different clocks a few ms apart) contains
 * it. An open run (finished null) covers everything after it started. With no covering run,
 * the newest run that started within NEAREST_MAX_MS before the moment, marked not covering.
 * Runs that start after the moment never count.
 */
export function pickCoveringRun(
  runs: RunWindow[],
  at: number,
  toleranceMs = COVER_TOLERANCE_MS
): CoveringPick | null {
  const sorted = [...runs]
    .filter((r) => Number.isFinite(r.started))
    .sort((a, b) => b.started - a.started)
  for (const r of sorted) {
    if (r.started > at + toleranceMs) continue
    const end = r.finished == null ? Number.POSITIVE_INFINITY : r.finished + toleranceMs
    if (at <= end)
      return { id: String(r.id), covering: true, started: r.started, finished: r.finished }
  }
  for (const r of sorted) {
    if (r.started > at + toleranceMs) continue
    if (at - r.started <= NEAREST_MAX_MS)
      return { id: String(r.id), covering: false, started: r.started, finished: r.finished }
    break
  }
  return null
}

/** JSON text → value; non-JSON text stays the string; empty → null. */
export function parseMaybeJson(v: unknown): unknown {
  if (v == null) return null
  if (typeof v !== 'string') return v
  if (v === '') return null
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

/**
 * A stored body (JSON text or an already-parsed value) with every value under a credential-
 * looking key replaced by the mask (secret-mask's rule, any depth). Non-JSON text comes back
 * as it was; a value that cannot be serialised comes back null.
 */
export function maskedBody(v: unknown): unknown {
  if (v == null) return null
  let text: string
  if (typeof v === 'string') text = v
  else {
    try {
      text = JSON.stringify(v)
    } catch {
      return null
    }
  }
  return parseMaybeJson(maskBodySecrets(text))
}

/** True when a masked body hides at least one value. */
export function bodyWasMasked(v: unknown): boolean {
  if (v == null) return false
  try {
    return (typeof v === 'string' ? v : JSON.stringify(v)).includes(MASK)
  } catch {
    return false
  }
}

/** What the attempts route answers (GET /erp-submissions/:id/attempts). */
export interface RawAttempt {
  attempt?: unknown
  status?: unknown
  http_status?: unknown
  error?: unknown
  source?: unknown
  at?: unknown
  endpoint_path?: unknown
  payload?: unknown
  response?: unknown
}

export interface ShapedAttempt {
  attempt: number
  status: string
  http_status: number | null
  error: string | null
  /** `stored` (attempt history), `captured`, `current` (the submission row), `call-log`. */
  source: string
  at: string | null
  endpoint_path: string | null
  payload: unknown
  response: unknown
  masked: boolean
}

export interface ShapedAttempts {
  attempts: ShapedAttempt[]
  total: number
  unrecorded: number
}

const SOURCE_WORDS: Record<string, string> = {
  send: 'stored',
  stored: 'stored',
  captured: 'captured',
  current: 'current',
  'call-log': 'call-log'
}

/**
 * The attempts route's answer, newest attempt first, payloads and responses masked. Rows
 * without a usable attempt number are dropped; duplicates keep the first seen (the route
 * already orders them); `unrecorded` never goes negative.
 */
export function shapeAttempts(raw: {
  attempts?: unknown
  total?: unknown
  unrecorded?: unknown
}): ShapedAttempts {
  const list = Array.isArray(raw?.attempts) ? (raw.attempts as RawAttempt[]) : []
  const seen = new Set<number>()
  const out: ShapedAttempt[] = []
  for (const a of list) {
    const n = Number(a?.attempt)
    if (!Number.isInteger(n) || n < 1 || seen.has(n)) continue
    seen.add(n)
    const payload = maskedBody(a.payload)
    const response = maskedBody(a.response)
    const at = a.at == null ? null : new Date(a.at as string)
    const http = a.http_status == null ? null : Number(a.http_status)
    out.push({
      attempt: n,
      status: typeof a.status === 'string' && a.status ? a.status : 'unknown',
      http_status: http != null && Number.isFinite(http) ? http : null,
      error: typeof a.error === 'string' && a.error ? a.error.slice(0, 2000) : null,
      source: SOURCE_WORDS[String(a.source ?? '')] ?? String(a.source ?? 'stored'),
      at: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null,
      endpoint_path: typeof a.endpoint_path === 'string' ? a.endpoint_path : null,
      payload,
      response,
      masked: bodyWasMasked(payload) || bodyWasMasked(response)
    })
  }
  out.sort((x, y) => y.attempt - x.attempt)
  const total = Math.max(Number(raw?.total) || 0, out.length ? out[0].attempt : 0)
  const unrecorded = Math.max(
    0,
    Number.isFinite(Number(raw?.unrecorded)) ? Number(raw?.unrecorded) : total - out.length
  )
  return { attempts: out, total, unrecorded }
}

/** Numbers from tedious come back as strings for bigint / decimal columns. */
export function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function iso(v: unknown): string | null {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(v as string)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Epoch ms of a stored timestamp (null when there is none / it is not a time). */
export function ms(v: unknown): number | null {
  const s = iso(v)
  return s ? Date.parse(s) : null
}

/**
 * The prompt an AI call sent, as the panel shows it: system text and each message's role +
 * text. The log keeps `{system, tools, messages}` (capped); content may be a string or a list
 * of blocks — text blocks are joined, other blocks named by type.
 */
export function aiRequestParts(req: unknown): {
  system: string | null
  tools: string[]
  messages: Array<{ role: string; text: string }>
} {
  const r = (req && typeof req === 'object' ? req : {}) as Record<string, unknown>
  const textOf = (c: unknown): string => {
    if (typeof c === 'string') return c
    if (Array.isArray(c))
      return c
        .map((b) => {
          if (typeof b === 'string') return b
          const blk = (b ?? {}) as Record<string, unknown>
          if (typeof blk.text === 'string') return blk.text
          if (blk.type === 'tool_use') return `[tool call: ${String(blk.name ?? '?')}]`
          if (blk.type === 'tool_result') return `[tool result] ${textOf(blk.content)}`
          return `[${String(blk.type ?? 'block')}]`
        })
        .join('\n')
    if (c && typeof c === 'object') return JSON.stringify(c)
    return c == null ? '' : String(c)
  }
  const system = r.system == null ? null : textOf(r.system) || null
  const tools = Array.isArray(r.tools)
    ? (r.tools as unknown[]).map((t) =>
        typeof t === 'string' ? t : String((t as { name?: unknown })?.name ?? '?')
      )
    : []
  const messages = Array.isArray(r.messages)
    ? (r.messages as unknown[]).map((m) => {
        const mm = (m ?? {}) as Record<string, unknown>
        return { role: String(mm.role ?? '?'), text: textOf(mm.content) }
      })
    : []
  return { system, tools, messages }
}

/** The text an AI call answered (content blocks joined), or null. */
export function aiResponseText(res: unknown): string | null {
  if (res == null) return null
  if (typeof res === 'string') return res
  const blocks = Array.isArray(res) ? res : (res as { content?: unknown })?.content
  if (!Array.isArray(blocks)) return JSON.stringify(res)
  const parts = blocks.map((b) => {
    const blk = (b ?? {}) as Record<string, unknown>
    if (typeof blk.text === 'string') return blk.text
    if (blk.type === 'tool_use')
      return `[tool call: ${String(blk.name ?? '?')}] ${JSON.stringify(blk.input ?? {})}`
    return `[${String(blk.type ?? 'block')}]`
  })
  return parts.join('\n') || null
}
