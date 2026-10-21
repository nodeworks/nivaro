/**
 * Compact tool payloads (#2765) — what Ask AI's tools return, as the MODEL
 * reads it. A list of records goes as a table: the column names once, each
 * row an array in that order, and a link column holding only the id with its
 * label kept once per column (`$labels`) instead of `{id, label}` on every
 * row. Everything that is not a list of records stays as it was.
 *
 * Model-facing only: the trace, the steps view, exports and result hashes
 * keep the readable rows. Both sizes are measured on every call (the same
 * four-characters-per-token estimate on each side) so the AI quality page
 * shows the saving per tool instead of assuming it.
 */

/** What the model is told once per payload that holds a table. */
export const COMPACT_FORMAT_NOTE =
  'tables: $cols names the columns once; each $rows entry is one row in that order; a link column holds the id and $labels[column][id] is its label'

/** The cap on what one tool result may send the model (as before #2765). */
export const TOOL_RESULT_CAP = 12_000

type Plain = Record<string, unknown>

const isPlain = (v: unknown): v is Plain =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)

/** A labelled link as ai-chat's labelForeignKeys writes it: exactly `{id, label}`. */
function isLink(v: unknown): v is { id: string | number; label: unknown } {
  if (!isPlain(v)) return false
  const keys = Object.keys(v)
  return (
    keys.length === 2 &&
    'id' in v &&
    'label' in v &&
    (typeof v.id === 'string' || typeof v.id === 'number')
  )
}

interface CompactState {
  tables: number
}

function compactValue(value: unknown, state: CompactState, depth: number): unknown {
  if (depth > 6) return value
  if (Array.isArray(value)) {
    if (value.length >= 2 && value.every(isPlain)) return toTable(value, state, depth)
    return value.map((v) => compactValue(v, state, depth + 1))
  }
  if (isPlain(value)) {
    const out: Plain = {}
    for (const [k, v] of Object.entries(value)) out[k] = compactValue(v, state, depth + 1)
    return out
  }
  return value
}

function toTable(rows: Plain[], state: CompactState, depth: number): Plain {
  const cols: string[] = []
  const seen = new Set<string>()
  for (const r of rows)
    for (const k of Object.keys(r))
      if (!seen.has(k)) {
        seen.add(k)
        cols.push(k)
      }
  // A column is a link column when every non-null cell is a labelled link.
  const linkCols = new Set(
    cols.filter((c) => {
      let any = false
      for (const r of rows) {
        const v = r[c]
        if (v == null) continue
        if (!isLink(v)) return false
        any = true
      }
      return any
    })
  )
  const labels: Record<string, Record<string, unknown>> = {}
  const out = rows.map((r) =>
    cols.map((c) => {
      const v = r[c]
      if (v === undefined) return null
      if (linkCols.has(c) && isLink(v)) {
        labels[c] ??= {}
        labels[c][String(v.id)] = v.label
        return v.id
      }
      return compactValue(v, state, depth + 1)
    })
  )
  state.tables++
  const table: Plain = { $cols: cols, $rows: out }
  if (Object.keys(labels).length) table.$labels = labels
  return table
}

export interface CompactPayload {
  /** What goes to the model (capped). */
  content: string
  /** Estimated tokens of the readable JSON, uncapped. */
  before: number
  /** Estimated tokens of what was chosen, uncapped. */
  after: number
}

const tokens = (s: string) => Math.ceil(s.length / 4)

/**
 * The model's copy of one tool result. The compact form is used only when it
 * is actually smaller than the readable JSON (the format note included); a
 * result with no list of records goes exactly as before.
 */
export function compactToolResult(result: unknown, cap = TOOL_RESULT_CAP): CompactPayload {
  let readable: string
  try {
    readable = JSON.stringify(result) ?? 'null'
  } catch {
    readable = String(result)
  }
  const state: CompactState = { tables: 0 }
  let compact: string | null = null
  try {
    const value = compactValue(result, state, 0)
    if (state.tables > 0) {
      const wrapped = isPlain(value)
        ? { $format: COMPACT_FORMAT_NOTE, ...value }
        : { $format: COMPACT_FORMAT_NOTE, result: value }
      compact = JSON.stringify(wrapped)
    }
  } catch {
    compact = null
  }
  const chosen = compact != null && compact.length < readable.length ? compact : readable
  return { content: chosen.slice(0, cap), before: tokens(readable), after: tokens(chosen) }
}
