/**
 * Calculated fields as SQL.
 *
 * A read-computed field has no column, so it could not be filtered or sorted:
 * the value only exists after the rows are read. Many of them are plain
 * arithmetic or a coalesce over the record's own columns, though, and those
 * translate exactly into a SQL expression the database can filter and order
 * by. This module compiles the ones that translate and declines the rest —
 * a formula it cannot express stays unfilterable rather than approximated.
 *
 * Supported: `item.<column>` for physical columns, numbers, quoted strings,
 * + - * /, unary minus, parentheses, coalesce(a, b, …).
 *
 * Arithmetic follows the formula engine, where an empty operand counts as 0:
 * each operand is wrapped ISNULL(CAST(x AS float), 0). coalesce arguments are
 * passed as they are. Division by zero yields NULL, as it does when read.
 */

export interface VirtualSql {
  /** SQL with `??` for identifiers and `?` for literals. */
  sql: string
  bindings: Array<string | number>
  /** What the expression yields — decides which filter controls fit. */
  kind: 'number' | 'value'
}

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'col'; v: string }
  | { t: 'fn'; v: string }
  | { t: 'op'; v: string }

function tokenize(src: string): Tok[] | null {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+(\.\d+)?|\.\d+)/.exec(src.slice(i))
      if (!m) return null
      out.push({ t: 'num', v: Number(m[0]) })
      i += m[0].length
      continue
    }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1)
      if (end < 0) return null
      const v = src.slice(i + 1, end)
      if (v.includes('\\')) return null
      out.push({ t: 'str', v })
      i = end + 1
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?/.exec(
        src.slice(i)
      ) as RegExpExecArray
      const word = m[0]
      i += word.length
      if (word.startsWith('item.')) {
        out.push({ t: 'col', v: word.slice(5) })
        continue
      }
      if (word.includes('.')) return null
      let j = i
      while (j < src.length && /\s/.test(src[j])) j++
      if (src[j] !== '(') return null
      out.push({ t: 'fn', v: word.toLowerCase() })
      continue
    }
    if ('+-*/(),'.includes(c)) {
      out.push({ t: 'op', v: c })
      i++
      continue
    }
    return null
  }
  return out
}

interface Node {
  sql: string
  bindings: Array<string | number>
  kind: 'number' | 'value'
}

const asNumber = (n: Node): Node =>
  n.kind === 'number'
    ? n
    : { sql: `ISNULL(CAST(${n.sql} AS float), 0)`, bindings: n.bindings, kind: 'number' }

/**
 * Compile a formula, or return null when it uses anything outside the
 * supported set or names a column the table does not have.
 */
export function compileFormulaToSql(
  formula: string,
  table: string,
  physical: Set<string>
): VirtualSql | null {
  const toks = tokenize(String(formula ?? ''))
  if (!toks || toks.length === 0 || toks.length > 200) return null
  let pos = 0
  let failed = false
  const peek = () => toks[pos]
  const isOp = (v: string) => peek()?.t === 'op' && (peek() as { v: string }).v === v
  const fail = (): Node => {
    failed = true
    return { sql: 'NULL', bindings: [], kind: 'value' }
  }

  function primary(): Node {
    const tk = peek()
    if (!tk) return fail()
    if (tk.t === 'num') {
      pos++
      return { sql: '?', bindings: [tk.v], kind: 'number' }
    }
    if (tk.t === 'str') {
      pos++
      return { sql: '?', bindings: [tk.v], kind: 'value' }
    }
    if (tk.t === 'col') {
      pos++
      if (!physical.has(tk.v)) return fail()
      return { sql: '??.??', bindings: [table, tk.v], kind: 'value' }
    }
    if (tk.t === 'fn') {
      if (tk.v !== 'coalesce') return fail()
      pos++
      if (!isOp('(')) return fail()
      pos++
      const args: Node[] = []
      for (;;) {
        args.push(additive())
        if (failed) return fail()
        if (isOp(',')) {
          pos++
          continue
        }
        break
      }
      if (!isOp(')')) return fail()
      pos++
      if (args.length === 0 || args.length > 12) return fail()
      const numeric = args.every((a) => a.kind === 'number')
      return {
        sql: `COALESCE(${args.map((a) => a.sql).join(', ')})`,
        bindings: args.flatMap((a) => a.bindings),
        kind: numeric ? 'number' : 'value'
      }
    }
    if (tk.t === 'op' && tk.v === '(') {
      pos++
      const inner = additive()
      if (!isOp(')')) return fail()
      pos++
      return { sql: `(${inner.sql})`, bindings: inner.bindings, kind: inner.kind }
    }
    if (tk.t === 'op' && tk.v === '-') {
      pos++
      const operand = asNumber(primary())
      return { sql: `(-${operand.sql})`, bindings: operand.bindings, kind: 'number' }
    }
    return fail()
  }

  function multiplicative(): Node {
    let left = primary()
    while (!failed && (isOp('*') || isOp('/'))) {
      const op = (peek() as { v: string }).v
      pos++
      const l = asNumber(left)
      const r = asNumber(primary())
      left =
        op === '*'
          ? {
              sql: `(${l.sql} * ${r.sql})`,
              bindings: [...l.bindings, ...r.bindings],
              kind: 'number'
            }
          : {
              sql: `(${l.sql} / NULLIF(${r.sql}, 0))`,
              bindings: [...l.bindings, ...r.bindings],
              kind: 'number'
            }
    }
    return left
  }

  function additive(): Node {
    let left = multiplicative()
    while (!failed && (isOp('+') || isOp('-'))) {
      const op = (peek() as { v: string }).v
      pos++
      const l = asNumber(left)
      const r = asNumber(multiplicative())
      left = {
        sql: `(${l.sql} ${op} ${r.sql})`,
        bindings: [...l.bindings, ...r.bindings],
        kind: 'number'
      }
    }
    return left
  }

  const root = additive()
  if (failed || pos !== toks.length) return null
  // A formula that names no column is a constant — nothing to filter on.
  if (!root.sql.includes('??')) return null
  return { sql: root.sql, bindings: root.bindings, kind: root.kind }
}

// ─── Per-collection cache of compiled fields ────────────────────────────────
// Lives here (a leaf module) so the metadata cache bust can clear it without
// importing the items service.

const cache = new Map<string, { at: number; fields: Map<string, VirtualSql> }>()
const TTL_MS = 30_000

export function cachedVirtualSql(collection: string): Map<string, VirtualSql> | null {
  const hit = cache.get(collection)
  return hit && Date.now() - hit.at < TTL_MS ? hit.fields : null
}

/** The last compiled set, fresh or not — for the synchronous query builders,
 *  which run right after an async prime. */
export function peekVirtualSql(collection: string): Map<string, VirtualSql> | undefined {
  return cache.get(collection)?.fields
}

export function storeVirtualSql(collection: string, fields: Map<string, VirtualSql>): void {
  cache.set(collection, { at: Date.now(), fields })
}

export function clearVirtualSqlCache(): void {
  cache.clear()
}

/**
 * A virtual rollup as a correlated subquery, so it can be filtered and sorted
 * without a stored copy (which would go stale whenever the rows it sums change
 * underneath it). One source only; sum/count/avg/min/max; the aggregated value
 * is a column of the related row or ONE hop through its link (`{{fk.col}}`).
 * Recursive rollups, row filters, parent filters and anything else decline —
 * the field stays readable, just not filterable.
 */
export function compileRollupToSql(
  cfg: {
    sources: Array<{
      related_collection: string
      fk_field: string
      aggregate: string
      value_field: string
      value_formula?: string
      recursive?: boolean
      filter?: Record<string, unknown>
    }>
    parent_filter?: unknown
  },
  table: string,
  ctx: {
    columnsOf: (collection: string) => Set<string> | undefined
    linkTarget: (collection: string, field: string) => string | null
  }
): VirtualSql | null {
  if (cfg.sources.length !== 1 || cfg.parent_filter) return null
  const src = cfg.sources[0]
  if (src.recursive || (src.filter && Object.keys(src.filter).length > 0)) return null
  const agg = src.aggregate
  if (!['sum', 'count', 'avg', 'min', 'max'].includes(agg)) return null
  const relCols = ctx.columnsOf(src.related_collection)
  if (!relCols?.has(src.fk_field)) return null
  const where = 'rs0.?? = ??.??'
  const whereBind = [src.fk_field, table, 'id']
  if (agg === 'count')
    return {
      sql: `SELECT COUNT(*) FROM ?? AS rs0 WHERE ${where}`,
      bindings: [src.related_collection, ...whereBind],
      kind: 'number'
    }
  let value: { sql: string; bindings: string[]; join: string; joinBind: string[] } | null = null
  const formula = src.value_formula?.trim()
  if (formula) {
    const m = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\s*\}\}$/.exec(formula)
    if (!m) return null
    if (!m[2]) {
      if (!relCols.has(m[1])) return null
      value = { sql: 'rs0.??', bindings: [m[1]], join: '', joinBind: [] }
    } else {
      const target = ctx.linkTarget(src.related_collection, m[1])
      if (!target || !relCols.has(m[1]) || !ctx.columnsOf(target)?.has(m[2])) return null
      value = {
        sql: 'rs1.??',
        bindings: [m[2]],
        join: ' LEFT JOIN ?? AS rs1 ON rs1.id = rs0.??',
        joinBind: [target, m[1]]
      }
    }
  } else {
    if (!relCols.has(src.value_field)) return null
    value = { sql: 'rs0.??', bindings: [src.value_field], join: '', joinBind: [] }
  }
  const fn = agg.toUpperCase()
  return {
    sql: `SELECT ${fn}(CAST(${value.sql} AS float)) FROM ?? AS rs0${value.join} WHERE ${where}`,
    bindings: [...value.bindings, src.related_collection, ...value.joinBind, ...whereBind],
    kind: 'number'
  }
}
