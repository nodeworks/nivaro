import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'

/**
 * Ask AI tool reliability board (#2733). Built from what is already logged:
 * each answer's tool trace (nivaro_ai_conversation_messages.trace — tool,
 * input, one-line summary) and the model calls behind it (nivaro_ai_calls,
 * grouped by request_id). Nothing new is recorded.
 *
 *  - errors: a trace summary that starts with "error:"
 *  - retries: the same tool called again right after it errored
 *  - recovered: that retry came back without an error — a wasted round
 *  - empty: the tool answered "0 rows / 0 hits / 0 groups"
 *  - read as none: an answer that had an empty result and says "no / none /
 *    nothing / couldn't find" up front — the model took zero rows for "none"
 *  - rounds per answer: model calls under the answer's request_id
 *  - slowest: the gap between a round finishing and the next one starting is
 *    the tools' run time, shared across the tools that round called
 */

export interface TraceStep {
  tool: string
  input?: unknown
  summary?: string
}

export interface ToolFailure {
  request_id: string | null
  at: string
  summary: string
  input: string
}

export interface ToolRow {
  tool: string
  calls: number
  errors: number
  error_rate: number
  empty: number
  empty_rate: number
  retries: number
  recovered: number
  read_as_none: number
  answers: number
  avg_rounds: number | null
  avg_ms: number | null
  slowest: Array<{ ms: number; request_id: string | null; at: string }>
  failures: ToolFailure[]
  /** Plain-words flags: what to look at on this tool. */
  flags: string[]
}

export const isErrorSummary = (s: string | undefined) => /^error:/i.test((s ?? '').trim())

/** "0 of 0 row(s) …", "0 semantic hit(s) …", "0 help video(s) …", "sum(x) = 0" is NOT empty. */
export function isEmptySummary(s: string | undefined): boolean {
  const t = (s ?? '').trim()
  if (!t || isErrorSummary(t)) return false
  return (
    /^0(\s+of\s+\d+)?\s+(row|hit|group|semantic|help|docs|open task|record|finding|result|item)/i.test(
      t
    ) || /^no (rows|results|matches|records|sweep)/i.test(t)
  )
}

const NONE_RE =
  /\b(no|none|nothing|not found|couldn['’]t find|could not find|there (are|is) no|0)\b/i

/** The answer opens by saying there is nothing. */
export const saysNone = (answer: string) => NONE_RE.test(answer.slice(0, 220))

export interface AnswerInput {
  request_id: string | null
  at: string
  steps: TraceStep[]
  answer: string
  rounds: number | null
  /** Per-tool run time in ms from the call log, when it could be worked out. */
  tool_ms?: Array<{ tool: string; ms: number }>
}

const MAX_FAILURES = 5
const MAX_SLOW = 3

export function aggregateTools(answers: AnswerInput[]): ToolRow[] {
  interface Acc {
    calls: number
    errors: number
    empty: number
    retries: number
    recovered: number
    readAsNone: number
    answers: number
    roundsSum: number
    roundsN: number
    ms: number[]
    slow: Array<{ ms: number; request_id: string | null; at: string }>
    failures: ToolFailure[]
  }
  const acc = new Map<string, Acc>()
  const get = (tool: string): Acc => {
    let a = acc.get(tool)
    if (!a) {
      a = {
        calls: 0,
        errors: 0,
        empty: 0,
        retries: 0,
        recovered: 0,
        readAsNone: 0,
        answers: 0,
        roundsSum: 0,
        roundsN: 0,
        ms: [],
        slow: [],
        failures: []
      }
      acc.set(tool, a)
    }
    return a
  }
  for (const ans of answers) {
    const seen = new Set<string>()
    const none = saysNone(ans.answer)
    ans.steps.forEach((s, i) => {
      if (!s.tool) return
      const a = get(s.tool)
      a.calls++
      if (!seen.has(s.tool)) {
        seen.add(s.tool)
        a.answers++
        if (ans.rounds != null) {
          a.roundsSum += ans.rounds
          a.roundsN++
        }
      }
      const prev = ans.steps[i - 1]
      if (prev && prev.tool === s.tool && isErrorSummary(prev.summary)) {
        a.retries++
        if (!isErrorSummary(s.summary)) a.recovered++
      }
      if (isErrorSummary(s.summary)) {
        a.errors++
        if (a.failures.length < MAX_FAILURES)
          a.failures.push({
            request_id: ans.request_id,
            at: ans.at,
            summary: String(s.summary).slice(0, 300),
            input: safeJson(s.input).slice(0, 300)
          })
      } else if (isEmptySummary(s.summary)) {
        a.empty++
        if (none) a.readAsNone++
      }
    })
    for (const t of ans.tool_ms ?? []) {
      const a = get(t.tool)
      a.ms.push(t.ms)
      a.slow.push({ ms: t.ms, request_id: ans.request_id, at: ans.at })
      a.slow.sort((x, y) => y.ms - x.ms)
      a.slow.length = Math.min(a.slow.length, MAX_SLOW)
    }
  }
  const rate = (x: number, y: number) => (y > 0 ? Math.round((x / y) * 1000) / 10 : 0)
  const rows: ToolRow[] = []
  for (const [tool, a] of acc) {
    const flags: string[] = []
    if (a.retries >= 2 && a.recovered / Math.max(1, a.retries) >= 0.5)
      flags.push(
        `The model recovers by retrying (${a.recovered} of ${a.retries} retries worked): each one costs a round, so fix the error or the tool's description.`
      )
    if (a.calls >= 5 && a.errors / a.calls >= 0.2) flags.push('Fails on one call in five or more.')
    if (a.readAsNone >= 2)
      flags.push(
        `Returned no rows ${a.readAsNone} times and the answer then said there was none: check the filter is not silently too narrow.`
      )
    rows.push({
      tool,
      calls: a.calls,
      errors: a.errors,
      error_rate: rate(a.errors, a.calls),
      empty: a.empty,
      empty_rate: rate(a.empty, a.calls),
      retries: a.retries,
      recovered: a.recovered,
      read_as_none: a.readAsNone,
      answers: a.answers,
      avg_rounds: a.roundsN ? Math.round((a.roundsSum / a.roundsN) * 10) / 10 : null,
      avg_ms: a.ms.length ? Math.round(a.ms.reduce((x, y) => x + y, 0) / a.ms.length) : null,
      slowest: a.slow,
      failures: a.failures,
      flags
    })
  }
  return rows.sort((x, y) => y.errors - x.errors || y.calls - x.calls)
}

function safeJson(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v ?? null)
  } catch {
    return ''
  }
}

// ─── tool run time from the call log ─────────────────────────────────────────

interface CallRow {
  request_id: string
  created_at: Date | string
  latency_ms: number | null
  response: string | null
}

/** Tools called in each round and how long the gap before the next round was. */
export function toolTimes(calls: CallRow[]): Array<{ tool: string; ms: number }> {
  const out: Array<{ tool: string; ms: number }> = []
  for (let i = 0; i < calls.length - 1; i++) {
    const names = toolNames(calls[i].response)
    if (names.length === 0) continue
    const end = new Date(calls[i].created_at).getTime() + (Number(calls[i].latency_ms) || 0)
    const gap = new Date(calls[i + 1].created_at).getTime() - end
    if (!(gap > 0) || gap > 600_000) continue
    const each = Math.round(gap / names.length)
    for (const tool of names) out.push({ tool, ms: each })
  }
  return out
}

function toolNames(response: string | null): string[] {
  if (!response) return []
  try {
    const arr = JSON.parse(response)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((b) => b?.type === 'tool_use' && typeof b.name === 'string')
      .map((b) => b.name as string)
  } catch {
    return []
  }
}

// ─── loader ──────────────────────────────────────────────────────────────────

const MAX_ANSWERS = 400

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export async function loadToolReliability(days: number, now = new Date()) {
  const since = new Date(now.getTime() - days * 86_400_000)
  const msgs = (await db('nivaro_ai_conversation_messages')
    .where('role', 'assistant')
    .where('created_at', '>=', since)
    .whereNotNull('trace')
    .orderBy('id', 'desc')
    .limit(MAX_ANSWERS)
    .select('content', 'trace', 'meta', 'created_at')
    .catch(() => [])) as Array<{
    content: string
    trace: string
    meta: string | null
    created_at: Date | string
  }>
  const answers: AnswerInput[] = msgs.map((m) => ({
    request_id: parseJson<{ request_id?: string }>(m.meta, {}).request_id ?? null,
    at: new Date(m.created_at).toISOString(),
    steps: parseJson<TraceStep[]>(m.trace, []).filter((s) => s && typeof s.tool === 'string'),
    answer: String(m.content ?? ''),
    rounds: null
  }))
  const ids = [...new Set(answers.map((a) => a.request_id).filter((x): x is string => !!x))]
  if (ids.length) {
    const calls = (await selectInChunks(ids, 500, (chunk) =>
      db('nivaro_ai_calls')
        .whereIn('request_id', chunk)
        .orderBy('id', 'asc')
        .select('request_id', 'created_at', 'latency_ms', 'response')
    ).catch(() => [])) as CallRow[]
    const by = new Map<string, CallRow[]>()
    for (const c of calls) by.set(c.request_id, [...(by.get(c.request_id) ?? []), c])
    for (const a of answers) {
      const rows = a.request_id ? by.get(a.request_id) : undefined
      if (!rows?.length) continue
      a.rounds = rows.length
      a.tool_ms = toolTimes(rows)
    }
  }
  const tools = aggregateTools(answers)
  return {
    days,
    answers: answers.length,
    capped: answers.length >= MAX_ANSWERS,
    tools
  }
}
