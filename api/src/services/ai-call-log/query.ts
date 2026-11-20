import type { Knex } from 'knex'
import { bucketLabel, likeContainsSql } from '../../db/dialect/users-ai-config.js'
import { db } from '../../db/index.js'
import { likeCi, likeEscape } from '../../db/sql-dialect.js'

/**
 * The AI call log's filter, sort and figures (admin AI hub → Usage). One
 * filter object drives the list, the summary strip and its breakdowns, and the
 * CSV, so every number on the page counts exactly the rows the list shows.
 *
 * Every value is bound; sort keys come from a fixed list; the window is
 * always bounded (≤ 90 days, the log keeps 30) so every statement seeks the
 * created_at index first.
 */

export const RESULTS = ['ok', 'error', 'end_turn', 'tool_use', 'max_tokens', 'stopped'] as const
export type CallResult = (typeof RESULTS)[number]

export interface CallLogFilter {
  from: Date
  to: Date
  /** Window length in hours (what the page calls 24h / 7d / 30d). */
  hours: number
  /** True when the window is "the last N hours" (it slides with the clock). */
  relative: boolean
  features: string[]
  models: string[]
  /** User ids; 'system' = calls with no person. */
  users: string[]
  results: CallResult[]
  tool: string | null
  q: string | null
  error: string | null
  request_id: string | null
  conversation: string | null
  /** Request ids of the conversation (filled by the route for older rows). */
  conversation_requests?: string[]
  feedback: 'up' | 'down' | 'any' | 'none' | null
  cost_min: number | null
  cost_max: number | null
  tokens_min: number | null
  tokens_max: number | null
  ms_min: number | null
  ms_max: number | null
}

export const SORTS = {
  when: 'c.id',
  feature: 'c.feature',
  person: 'person_name',
  model: 'c.model',
  in: 'c.input_tokens',
  cached: 'c.cache_read_tokens',
  out: 'c.output_tokens',
  cost: 'c.cost_usd',
  time: 'c.latency_ms',
  result: 'c.status',
  tools: 'c.tool_calls'
} as const
export type SortKey = keyof typeof SORTS

const list = (v: unknown, max = 20, len = 100): string[] =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.slice(0, len))
    .slice(0, max)

const numOrNull = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

const MAX_HOURS = 24 * 90

/** Pure: a querystring as a filter. Unknown or bad values are dropped, never errors. */
export function parseCallLogFilter(q: Record<string, unknown>, now = new Date()): CallLogFilter {
  let to = now
  let from: Date
  let relative = false
  const fromRaw = q.from ? new Date(String(q.from)) : null
  const toRaw = q.to ? new Date(String(q.to)) : null
  if (fromRaw && !Number.isNaN(fromRaw.getTime())) {
    if (toRaw && !Number.isNaN(toRaw.getTime()) && toRaw > fromRaw) {
      // A bare date (YYYY-MM-DD) for `to` means the end of that day.
      to = /^\d{4}-\d{2}-\d{2}$/.test(String(q.to)) ? new Date(toRaw.getTime() + 86_400_000) : toRaw
    }
    if (to > now) to = now
    from = fromRaw
    if (to.getTime() - from.getTime() > MAX_HOURS * 3_600_000)
      from = new Date(to.getTime() - MAX_HOURS * 3_600_000)
    if (from >= to) from = new Date(to.getTime() - 3_600_000)
  } else {
    const hours = Math.min(MAX_HOURS, Math.max(1, Number(q.hours) || 24 * 7))
    from = new Date(now.getTime() - hours * 3_600_000)
    relative = true
  }
  const results = list(q.result).filter((r): r is CallResult =>
    (RESULTS as readonly string[]).includes(r)
  )
  const fb = String(q.feedback ?? '')
  const text = (v: unknown, max: number) => {
    const s = String(v ?? '').trim()
    return s ? s.slice(0, max) : null
  }
  return {
    from,
    to,
    hours: Math.max(1, Math.round((to.getTime() - from.getTime()) / 3_600_000)),
    relative,
    features: list(q.feature, 20, 60),
    models: list(q.model, 20, 100),
    users: list(q.user, 20, 40),
    results,
    tool: text(q.tool, 60)?.replace(/[^A-Za-z0-9_.:-]/g, '') || null,
    q: text(q.q, 200),
    error: text(q.error, 200),
    request_id: text(q.request_id, 40),
    conversation: text(q.conversation, 36),
    feedback: fb === 'up' || fb === 'down' || fb === 'any' || fb === 'none' ? fb : null,
    cost_min: numOrNull(q.cost_min),
    cost_max: numOrNull(q.cost_max),
    tokens_min: numOrNull(q.tokens_min),
    tokens_max: numOrNull(q.tokens_max),
    ms_min: numOrNull(q.ms_min),
    ms_max: numOrNull(q.ms_max)
  }
}

export function parseSort(raw: unknown): { key: SortKey; dir: 'asc' | 'desc' } {
  const s = String(raw ?? '')
  const desc = !s.startsWith('+')
  const key = s.replace(/^[+-]/, '') as SortKey
  return { key: key in SORTS ? key : 'when', dir: s && !desc ? 'asc' : 'desc' }
}

/** `%text%` for LIKE with the specials escaped (ESCAPE '\'). */
export function likeContains(text: string): string {
  return `%${text.replace(/[\\%_[]/g, (c) => `\\${c}`)}%`
}

/** Pure: the filter in a few words, for the activity log of who looked at what. */
export function describeCallLogFilter(f: CallLogFilter): string {
  const parts: string[] = [
    f.relative
      ? `last ${f.hours % 24 === 0 ? `${f.hours / 24} day(s)` : `${f.hours} hour(s)`}`
      : `${f.from.toISOString().slice(0, 16)} → ${f.to.toISOString().slice(0, 16)}`
  ]
  if (f.features.length) parts.push(`feature ${f.features.join('/')}`)
  if (f.models.length) parts.push(`model ${f.models.join('/')}`)
  if (f.users.length) parts.push(`person ${f.users.join('/')}`)
  if (f.results.length) parts.push(`result ${f.results.join('/')}`)
  if (f.tool) parts.push(`tool ${f.tool}`)
  if (f.q) parts.push(`text "${f.q}"`)
  if (f.error) parts.push(`error "${f.error}"`)
  if (f.request_id) parts.push(`question ${f.request_id}`)
  if (f.conversation) parts.push(`conversation ${f.conversation}`)
  if (f.feedback) parts.push(`feedback ${f.feedback}`)
  const range = (n: string, a: number | null, b: number | null) => {
    if (a != null || b != null) parts.push(`${n} ${a ?? ''}–${b ?? ''}`)
  }
  range('cost', f.cost_min, f.cost_max)
  range('tokens', f.tokens_min, f.tokens_max)
  range('ms', f.ms_min, f.ms_max)
  return parts.join(', ')
}

/** Every condition of the filter on `nivaro_ai_calls as c`. `cols` = migration 539 is there. */
export function applyCallLogFilter(
  b: Knex.QueryBuilder,
  f: CallLogFilter,
  opts: { cols: boolean; windowOnly?: boolean }
): Knex.QueryBuilder {
  b.where('c.created_at', '>=', f.from).where('c.created_at', '<', f.to)
  if (opts.windowOnly) return b
  if (f.features.length) b.whereIn('c.feature', f.features)
  if (f.models.length) b.whereIn('c.model', f.models)
  if (f.users.length) {
    const ids = f.users.filter((u) => u !== 'system')
    const sys = f.users.includes('system')
    b.where((w) => {
      if (ids.length) w.orWhereIn('c.user', ids)
      if (sys) w.orWhereNull('c.user')
    })
  }
  if (f.results.length) {
    b.where((w) => {
      for (const r of f.results) {
        if (r === 'ok' || r === 'error') w.orWhere('c.status', r)
        else w.orWhere((x) => x.where('c.status', 'ok').where('c.stop_reason', r))
      }
    })
  }
  if (f.tool && opts.cols)
    b.whereRaw(`c.tools ${likeCi(db)} ? ${likeEscape(db)}`, [`%,${f.tool.replace(/_/g, '\\_')},%`])
  if (f.q && opts.cols) {
    const like = likeContainsSql(db, 'c.question', likeContains(f.q), 'unicode')
    b.whereRaw(like.sql, like.bindings as never)
  }
  if (f.error) {
    const like = likeContainsSql(db, 'c.error', likeContains(f.error), 'unicode')
    b.whereRaw(like.sql, like.bindings as never)
  }
  if (f.request_id) b.where('c.request_id', f.request_id)
  if (f.conversation) {
    const reqs = (f.conversation_requests ?? []).slice(0, 400)
    b.where((w) => {
      if (opts.cols) w.orWhere('c.conversation_id', f.conversation)
      if (reqs.length) w.orWhereIn('c.request_id', reqs)
      if (!opts.cols && !reqs.length) w.whereRaw('1 = 0')
    })
  }
  if (f.feedback) {
    const exists = db('nivaro_ai_feedback as fb')
      .whereRaw('fb.request_id = c.request_id')
      .select(db.raw('1'))
    if (f.feedback === 'up') exists.where('fb.rating', '>', 0)
    if (f.feedback === 'down') exists.where('fb.rating', '<', 0)
    if (f.feedback === 'none') b.whereNotExists(exists)
    else b.whereExists(exists)
  }
  if (f.cost_min != null) b.where('c.cost_usd', '>=', f.cost_min)
  if (f.cost_max != null) b.where('c.cost_usd', '<=', f.cost_max)
  const tokens = 'COALESCE(c.input_tokens, 0) + COALESCE(c.output_tokens, 0)'
  if (f.tokens_min != null) b.whereRaw(`${tokens} >= ?`, [f.tokens_min])
  if (f.tokens_max != null) b.whereRaw(`${tokens} <= ?`, [f.tokens_max])
  if (f.ms_min != null) b.where('c.latency_ms', '>=', f.ms_min)
  if (f.ms_max != null) b.where('c.latency_ms', '<=', f.ms_max)
  return b
}

export const PERSON_NAME_SQL =
  "COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(u.first_name, ' ', u.last_name))), ''), u.email)"

export function personName(r: {
  first_name?: unknown
  last_name?: unknown
  email?: unknown
  user?: unknown
}): string {
  return (
    [r.first_name, r.last_name].filter(Boolean).join(' ') ||
    (r.email ? String(r.email) : '') ||
    (r.user ? 'Unknown person' : 'System')
  )
}

/** Hour buckets for a window up to two days, day buckets past that. */
export function bucketOf(f: CallLogFilter): 'hour' | 'day' {
  return f.hours <= 48 ? 'hour' : 'day'
}

export function bucketSql(f: CallLogFilter, knex: Knex = db): string {
  return bucketLabel(knex, 'c.created_at', bucketOf(f))
}

/** Pure: a CSV cell (quotes doubled, formula starts neutralised). */
export function csvCell(v: unknown): string {
  if (v == null) return ''
  let s = v instanceof Date ? v.toISOString() : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const CSV_HEADER = [
  'when_utc',
  'id',
  'question_id',
  'feature',
  'person',
  'model',
  'provider',
  'result',
  'input_tokens',
  'cached_tokens',
  'output_tokens',
  'cost_usd',
  'latency_ms',
  'tool_calls',
  'tools',
  'question',
  'error'
]
