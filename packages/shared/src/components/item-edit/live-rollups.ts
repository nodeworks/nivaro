import { evaluateNumeric } from '../../lib/expression'
/**
 * Client-side evaluation of a rollup field over rows the user is CURRENTLY
 * editing, so a header total moves with the grid instead of waiting for a save
 * and a server recalculation.
 *
 * The server remains the authority: nothing here is written anywhere, and the
 * stored value reappears on the next read. This exists purely so the number a
 * user is looking at agrees with the rows under it while they work — a header
 * that still reads the pre-edit total looks like the edit did not register.
 *
 * Deliberately mirrors services/rollups.ts on the server: the same two config
 * shapes, the same aggregates, and the same NULL-safe `_neq` (in MSSQL a plain
 * `col != v` drops NULL rows, so the server compensates and so must this, or
 * the live figure and the saved one would disagree on exactly the rows that
 * have no value).
 */

export interface RollupSource {
  related_collection: string
  fk_field: string
  aggregate?: 'sum' | 'count' | 'avg' | 'min' | 'max'
  value_field?: string
  value_formula?: string
  filter?: Record<string, unknown>
  recursive?: boolean
}

type FilterOp = Record<string, unknown>

/**
 * Both stored shapes: the legacy single-source object and `{sources: [...]}`.
 * Returns [] for anything unparseable — a live total is an enhancement, and a
 * malformed config must fall back to the stored value, never throw in render.
 */
export function parseRollupSources(formula: unknown): RollupSource[] {
  let cfg = formula
  if (typeof cfg === 'string') {
    try {
      cfg = JSON.parse(cfg)
    } catch {
      return []
    }
  }
  if (!cfg || typeof cfg !== 'object') return []
  const obj = cfg as Record<string, unknown>
  const list = Array.isArray(obj.sources) ? obj.sources : [obj]
  return list.filter(
    (s): s is RollupSource =>
      !!s &&
      typeof s === 'object' &&
      typeof (s as RollupSource).related_collection === 'string' &&
      typeof (s as RollupSource).fk_field === 'string'
  )
}

function compare(value: unknown, op: string, operand: unknown): boolean {
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? Number.NaN : Number(v))
  switch (op) {
    case '_eq':
      return String(value ?? '') === String(operand ?? '')
    // NULL-safe on purpose — see the header note.
    case '_neq':
      return value === null || value === undefined || String(value) !== String(operand ?? '')
    case '_gt':
      return num(value) > num(operand)
    case '_gte':
      return num(value) >= num(operand)
    case '_lt':
      return num(value) < num(operand)
    case '_lte':
      return num(value) <= num(operand)
    case '_null':
      return value === null || value === undefined || value === ''
    case '_nnull':
      return !(value === null || value === undefined || value === '')
    case '_in':
      return Array.isArray(operand) && operand.map(String).includes(String(value ?? ''))
    default:
      // An operator this evaluator does not model must not silently narrow the
      // set — treat it as "matches" and let the server's number win on save.
      return true
  }
}

export function matchesRollupFilter(
  row: Record<string, unknown>,
  filter: Record<string, unknown> | undefined
): boolean {
  if (!filter) return true
  for (const [field, condition] of Object.entries(filter)) {
    const value = row[field]
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      for (const [op, operand] of Object.entries(condition as FilterOp)) {
        if (!compare(value, op, operand)) return false
      }
    } else if (String(value ?? '') !== String(condition ?? '')) {
      return false
    }
  }
  return true
}

/**
 * `{{a}} - {{b}}` over the row. Delegates to the shared expression engine
 * rather than keeping a third copy of the same substitute-then-eval logic;
 * `missing: 'zero'` preserves the previous behaviour for existing rollups.
 */
function evalRowFormula(formula: string, row: Record<string, unknown>): number | null {
  return evaluateNumeric(formula, row)
}

/**
 * Aggregate one source over the rows currently on screen.
 * Returns null when the source contributes nothing measurable, so a caller can
 * tell "no rows" apart from "sums to zero".
 */
export function aggregateRows(source: RollupSource, rows: Record<string, unknown>[]): number | null {
  const matching = rows.filter((r) => matchesRollupFilter(r, source.filter))
  const aggregate = source.aggregate ?? 'sum'
  if (aggregate === 'count') return matching.length

  const values: number[] = []
  for (const row of matching) {
    const raw = source.value_formula
      ? evalRowFormula(source.value_formula, row)
      : source.value_field
        ? Number(row[source.value_field])
        : Number.NaN
    if (raw !== null && Number.isFinite(raw)) values.push(raw)
  }
  if (values.length === 0) return null
  switch (aggregate) {
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length
    case 'min':
      return Math.min(...values)
    case 'max':
      return Math.max(...values)
    default:
      return values.reduce((a, b) => a + b, 0)
  }
}

/**
 * The live value for a rollup field, or null when it cannot be computed from
 * what is on screen — a recursive rollup (needs the whole tree), or a source
 * whose grid is not mounted (a collapsed tab holds no rows to sum). Null means
 * "keep showing the stored value", never "the total is zero".
 */
export function computeLiveRollup(
  sources: RollupSource[],
  rowsByRelation: Map<string, Record<string, unknown>[]>
): number | null {
  if (sources.length === 0) return null
  if (sources.some((s) => s.recursive)) return null

  let total: number | null = null
  for (const source of sources) {
    const rows = rowsByRelation.get(`${source.related_collection}.${source.fk_field}`)
    // A source with no visible grid makes the whole figure a guess — a
    // multi-source rollup showing only the half we can see would be worse than
    // showing the saved number.
    if (!rows) return null
    const value = aggregateRows(source, rows)
    if (value !== null) total = (total ?? 0) + value
  }
  return total
}
