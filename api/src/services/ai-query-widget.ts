import type { User } from '../types.js'

/**
 * The `ai_query` dashboard widget (#2738, #2736): a chart (or a number) built
 * from an Ask AI tool call. It stores the QUERY — the tool and its arguments,
 * never the answer's text or figures — and recomputes by running that same
 * read tool AS WHOEVER VIEWS IT, so permissions, field limits, User Scopes
 * and saved-query access bind exactly as they do in Ask AI (and a public link
 * computes as the dashboard owner, like every other widget).
 *
 * Stored on nivaro_dashboard_widgets.filters (JSON):
 *   { source: { tool: 'aggregate' | 'run_custom_query', input: {…} },
 *     chart?: 'bar' | 'line' | 'pie', x?: column, y?: column, question?: text }
 * `collection` mirrors source.input.collection for an aggregate (so live
 * pushes and listings know the widget's collection); a saved query has none.
 */

export const AI_QUERY_WIDGET = 'ai_query'
export const AI_QUERY_TOOLS = new Set(['aggregate', 'run_custom_query'])
const CHART_TYPES = new Set(['bar', 'line', 'pie'])
const COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const MAX_POINTS = 40
const MAX_INPUT_BYTES = 8000

export interface AiQuerySpec {
  source: { tool: 'aggregate' | 'run_custom_query'; input: Record<string, unknown> }
  chart: 'bar' | 'line' | 'pie'
  x?: string
  y?: string
  question?: string
}

export interface AiQueryData {
  /** A grouped result: chart points. */
  chart?: { type: 'bar' | 'line' | 'pie'; data: Array<{ label: string; value: number }> }
  /** An ungrouped aggregate: one number. */
  value?: number | null
  question?: string | null
  /** The rows could not be drawn (no label/number columns). */
  note?: string
}

function parseObject(raw: unknown): Record<string, unknown> | null {
  let v = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** Only the arguments the tool reads — anything else the client sent is dropped. */
function cleanInput(tool: string, input: Record<string, unknown>): Record<string, unknown> | null {
  if (tool === 'aggregate') {
    const collection = typeof input.collection === 'string' ? input.collection : ''
    if (!COLUMN_RE.test(collection)) return null
    const op = typeof input.op === 'string' ? input.op : 'count'
    if (!['count', 'sum', 'avg', 'min', 'max'].includes(op)) return null
    const out: Record<string, unknown> = { collection, op }
    if (typeof input.field === 'string' && COLUMN_RE.test(input.field)) out.field = input.field
    if (typeof input.group_by === 'string' && COLUMN_RE.test(input.group_by))
      out.group_by = input.group_by
    if (input.filter && typeof input.filter === 'object' && !Array.isArray(input.filter))
      out.filter = input.filter
    return out
  }
  const slug = typeof input.slug === 'string' ? input.slug.trim() : ''
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(slug)) return null
  const out: Record<string, unknown> = { slug }
  if (input.params && typeof input.params === 'object' && !Array.isArray(input.params))
    out.params = input.params
  return out
}

/** Normalize a stored / incoming spec; null = not a valid ai_query widget. */
export function normalizeAiQuerySpec(raw: unknown): AiQuerySpec | null {
  const o = parseObject(raw)
  if (!o) return null
  const src = parseObject(o.source)
  if (!src) return null
  const tool = String(src.tool ?? '')
  if (!AI_QUERY_TOOLS.has(tool)) return null
  const rawInput = parseObject(src.input)
  if (!rawInput) return null
  const input = cleanInput(tool, rawInput)
  if (!input || JSON.stringify(input).length > MAX_INPUT_BYTES) return null
  const chart = CHART_TYPES.has(String(o.chart)) ? (String(o.chart) as AiQuerySpec['chart']) : 'bar'
  const spec: AiQuerySpec = {
    source: { tool: tool as AiQuerySpec['source']['tool'], input },
    chart
  }
  if (typeof o.x === 'string' && COLUMN_RE.test(o.x)) spec.x = o.x
  if (typeof o.y === 'string' && COLUMN_RE.test(o.y)) spec.y = o.y
  if (typeof o.question === 'string' && o.question.trim())
    spec.question = o.question.trim().replace(/\s+/g, ' ').slice(0, 500)
  return spec
}

/** The collection an ai_query widget reads (null for a saved query). */
export function aiQueryCollection(spec: AiQuerySpec): string | null {
  return spec.source.tool === 'aggregate' ? String(spec.source.input.collection) : null
}

const isNum = (v: unknown) =>
  (typeof v === 'number' && Number.isFinite(v)) ||
  (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))

function labelOf(v: unknown): string {
  if (v == null || v === '') return '(none)'
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    return String(o.label ?? o.name ?? o.id ?? JSON.stringify(v))
  }
  return String(v)
}

/**
 * Chart points from tool rows. `x` / `y` name the columns when known; else
 * the first column whose values are not all numbers is the label and the
 * first numeric column the value (`value` — the aggregate alias — first).
 */
export function chartFromRows(
  rows: Array<Record<string, unknown>>,
  hint: { x?: string; y?: string; type?: AiQuerySpec['chart'] } = {}
): AiQueryData['chart'] | null {
  if (!rows.length) return { type: hint.type ?? 'bar', data: [] }
  const cols = Object.keys(rows[0] ?? {})
  const numeric = cols.filter((c) => rows.every((r) => r[c] == null || isNum(r[c])))
  const y =
    hint.y && cols.includes(hint.y)
      ? hint.y
      : numeric.includes('value')
        ? 'value'
        : numeric.find((c) => c !== hint.x)
  const x =
    hint.x && cols.includes(hint.x)
      ? hint.x
      : (cols.find((c) => c !== y && !numeric.includes(c)) ?? cols.find((c) => c !== y))
  if (!x || !y) return null
  return {
    type: hint.type ?? 'bar',
    data: rows.slice(0, MAX_POINTS).map((r) => ({ label: labelOf(r[x]), value: Number(r[y] ?? 0) }))
  }
}

/** The rows a tool result holds (aggregate: an array or one row; saved query: {rows}). */
function rowsOf(result: unknown): Array<Record<string, unknown>> | null {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>
  const o = result as Record<string, unknown> | null
  if (o && Array.isArray(o.rows)) return o.rows as Array<Record<string, unknown>>
  return null
}

export type AiQueryRunner = (
  user: User,
  tool: string,
  input: Record<string, unknown>
) => Promise<{ result: unknown; summary: string }>

const defaultRunner: AiQueryRunner = async (user, tool, input) => {
  const { executeChatTool } = await import('./ai-chat.js')
  return executeChatTool(user, tool, input)
}

/** Compute an ai_query widget AS `viewer`. Throws the tool's own refusal. */
export async function computeAiQueryWidget(
  spec: AiQuerySpec,
  viewer: User,
  run: AiQueryRunner = defaultRunner
): Promise<AiQueryData> {
  const { result } = await run(viewer, spec.source.tool, spec.source.input)
  const question = spec.question ?? null
  if (spec.source.tool === 'aggregate' && !spec.source.input.group_by) {
    const row = (Array.isArray(result) ? result[0] : result) as Record<string, unknown> | undefined
    const v = row?.value
    return { value: v == null || !isNum(v) ? null : Number(v), question }
  }
  const rows = rowsOf(result)
  if (!rows) return { question, note: 'No rows came back' }
  const chart = chartFromRows(rows, { x: spec.x, y: spec.y, type: spec.chart })
  if (!chart) return { question, note: 'These rows have no label and number columns to draw' }
  return { chart, question }
}
