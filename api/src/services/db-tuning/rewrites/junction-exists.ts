import type { Transformer } from './index.js'
import {
  aliasAfter,
  conjuncts,
  hasTopOr,
  ident,
  isOp,
  kw,
  lineOf,
  namesOtherAlias,
  refsTo,
  type Scan,
  STMT,
  scan,
  splice,
  tableRef
} from './scan.js'

/**
 * A table joined ONLY so a WHERE predicate can reference it multiplies rows before SUM/COUNT —
 * the fan-out that inflated budgets by the zone count (2026-09-20). When an alias appears
 * nowhere but its own ON clause and ONE top-level WHERE conjunct, the join becomes EXISTS:
 * - LEFT join: the conjunct's predicate is replaced by EXISTS(ON AND predicate), keeping a
 *   leading `(@P IS NULL OR …)` escape outside it. The predicate must be NULL-rejecting
 *   (`alias.col <comparison | IN | LIKE | BETWEEN> …` naming no other alias) — then the
 *   missing-row case filters identically.
 * - INNER join: the whole conjunct (escape included) moves inside EXISTS, so the row still needs
 *   a junction match; with no conjunct the EXISTS is ANDed onto the WHERE as a gate.
 * Rows that matched the junction N times now appear once — the fan-out being removed; the twin
 * proof shows whether the recorded data ever fanned out. Everything else declines: the alias in
 * any other clause or statement, two conjuncts on it, a WHERE with a top-level OR, a RIGHT /
 * FULL / APPLY in the FROM, a bare `*` in the SELECT list, join hints, a derived table.
 */
interface Join {
  kind: 'left' | 'inner'
  /** First token (LEFT / INNER / JOIN) and the token after the ON clause. */
  first: number
  after: number
  depth: number
  table: string
  alias: string
  onFrom: number
}

const ON_END = new Set([
  'LEFT',
  'RIGHT',
  'INNER',
  'FULL',
  'CROSS',
  'OUTER',
  'JOIN',
  'ON',
  'WHERE',
  'GROUP',
  'ORDER',
  'HAVING',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'OPTION',
  'FOR'
])
const WHERE_END = new Set([
  'GROUP',
  'ORDER',
  'HAVING',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'OPTION',
  'FOR'
])
const UNSAFE_FROM = new Set(['RIGHT', 'FULL', 'APPLY', 'PIVOT', 'UNPIVOT'])
const COMPARE = new Set(['=', '<>', '!=', '<', '>', '<=', '>=', '!<', '!>'])

/** Where a clause at `depth` that starts at `k` ends: the first stop word / `;` / `)` / statement. */
function clauseEnd(s: Scan, k: number, depth: number, stops: Set<string>): number {
  for (let i = k; i < s.toks.length; i++) {
    const t = s.toks[i]
    if (t.depth < depth) return i
    if (t.depth > depth) continue
    if (isOp(s, i, ';') || isOp(s, i, ',')) return i
    const w = kw(s, i)
    if (w === 'CASE') i = s.caseEnd.get(i) ?? i
    else if (stops.has(w)) return i
    else if (STMT.has(w) && !(w === 'WITH' && isOp(s, i + 1, '('))) return i
  }
  return s.toks.length
}

function parseJoin(s: Scan, i: number): Join | null {
  const prev = kw(s, i - 1)
  let kind: Join['kind'] = 'inner'
  let first = i
  if (prev === 'LEFT') {
    kind = 'left'
    first = i - 1
  } else if (prev === 'OUTER') {
    if (kw(s, i - 2) !== 'LEFT') return null
    kind = 'left'
    first = i - 2
  } else if (prev === 'INNER') first = i - 1
  else if (['RIGHT', 'FULL', 'CROSS', 'HASH', 'LOOP', 'MERGE', 'REMOTE'].includes(prev)) return null
  const tableEnd = tableRef(s, i + 1)
  if (tableEnd < 0) return null
  const ref = aliasAfter(s, tableEnd)
  if (!ref || kw(s, ref.last + 1) !== 'ON') return null
  const depth = s.toks[i].depth
  const onFrom = ref.last + 2
  const after = clauseEnd(s, onFrom, depth, ON_END)
  if (after <= onFrom || kw(s, after) === 'ON' || isOp(s, after, ',')) return null
  const { sql, toks } = s
  const table = sql.slice(toks[i + 1].start, toks[tableEnd].end)
  const aliasText = toks[ref.alias].text
  const hint =
    ref.last > ref.alias ? ` ${sql.slice(toks[ref.alias + 1].start, toks[ref.last].end)}` : ''
  return {
    kind,
    first,
    after,
    depth,
    table: `${table} ${aliasText}${hint}`,
    alias: ident(toks[ref.alias]),
    onFrom
  }
}

/** The SELECT that owns the FROM this join is in, or -1. Also returns the FROM. */
function owningSelect(s: Scan, j: Join): { select: number; from: number } | null {
  let from = -1
  for (let i = j.first - 1; i >= 0; i--) {
    const t = s.toks[i]
    if (t.depth < j.depth) return null
    if (t.depth > j.depth) continue
    if (isOp(s, i, ';')) return null
    const w = kw(s, i)
    if (s.caseStart.has(i)) i = s.caseStart.get(i)!
    else if (from < 0 && w === 'FROM') from = i
    else if (w === 'SELECT') return from < 0 ? null : { select: i, from }
    else if (STMT.has(w) && !(w === 'WITH' && isOp(s, i + 1, '('))) return null
  }
  return null
}

/** `alias.col <op> rest` with no OR / NOT / IS and no other alias — NULL on the missing row. */
function nullRejecting(s: Scan, alias: string, from: number, to: number): boolean {
  const { toks } = s
  if (to - from < 4 || ident(toks[from]) !== alias || !isOp(s, from + 1, '.')) return false
  if (toks[from + 2].kind !== 'word' && toks[from + 2].kind !== 'br') return false
  const op = toks[from + 3]
  const w = kw(s, from + 3)
  const restFrom = from + 4
  if (restFrom >= to) return false
  if (w === 'IN') {
    if (!isOp(s, restFrom, '(') || s.close.get(restFrom) !== to - 1) return false
  } else if (!(op.kind === 'op' && COMPARE.has(op.text)) && w !== 'LIKE' && w !== 'BETWEEN')
    return false
  // `NULL <> ALL (empty set)` is TRUE: a quantified comparison keeps the missing row
  if (['ALL', 'ANY', 'SOME'].includes(kw(s, restFrom))) return false
  const depth = toks[from].depth
  let ands = 0
  for (let k = restFrom; k < to; k++) {
    if (toks[k].depth !== depth) continue
    const wk = kw(s, k)
    if (wk === 'AND') ands++
    else if (['OR', 'NOT', 'IS', 'ESCAPE', 'COLLATE'].includes(wk)) return false
  }
  if (ands > (w === 'BETWEEN' ? 1 : 0)) return false
  return !namesOtherAlias(s, null, restFrom, to) // the rest names no alias at all
}

/**
 * A nested owner (correlated / scalar subquery, APPLY body) sees the enclosing query's columns:
 * an unqualified column that bound to the junction would silently rebind outward once the join
 * is gone. Only a CTE or derived-table body directly under the statement sees nothing outside.
 */
function nestedNeedsQualified(s: Scan, j: Join, select: number): boolean {
  if (j.depth === 0) return false
  if (j.depth === 1 && isOp(s, select - 1, '(')) {
    const before = kw(s, select - 2)
    if (before === 'AS' || before === 'FROM' || before === 'JOIN') return false
  }
  return true
}

const NOT_COLUMN = new Set([
  ...'SELECT FROM WHERE AND OR NOT IN IS NULL AS ON JOIN LEFT RIGHT INNER OUTER FULL CROSS APPLY'.split(
    ' '
  ),
  ...'GROUP BY ORDER HAVING DISTINCT TOP PERCENT TIES WITH CASE WHEN THEN ELSE END EXISTS'.split(
    ' '
  ),
  ...'BETWEEN LIKE ESCAPE ASC DESC UNION EXCEPT INTERSECT ALL ANY SOME OVER PARTITION ROWS'.split(
    ' '
  ),
  ...'RANGE UNBOUNDED PRECEDING FOLLOWING CURRENT ROW OFFSET FETCH NEXT ONLY OPTION COLLATE'.split(
    ' '
  ),
  ...'INTO INT BIGINT SMALLINT TINYINT BIT DECIMAL NUMERIC MONEY FLOAT REAL DATE DATETIME'.split(
    ' '
  ),
  ...'DATETIME2 TIME VARCHAR NVARCHAR CHAR NCHAR MAX UNIQUEIDENTIFIER'.split(' ')
])

/**
 * Whether the owning query (from its SELECT to the paren that closes it), outside the join and
 * the conjunct that moves with it, names any column without a qualifier. Table names, aliases,
 * hints, `AS name`, functions, variables and keywords are not columns; anything else counts.
 */
function hasUnqualified(
  s: Scan,
  j: Join,
  select: number,
  moved: { from: number; to: number } | undefined
): boolean {
  const { toks } = s
  let end = toks.length
  for (let k = select + 1; k < toks.length; k++)
    if (toks[k].depth < j.depth) {
      end = k
      break
    }
  const skip = new Set<number>()
  for (let k = select; k < end; k++) {
    const w = kw(s, k)
    if (w === 'AS') skip.add(k + 1)
    if (w !== 'FROM' && w !== 'JOIN') continue
    const t = tableRef(s, k + 1)
    if (t < 0) continue
    const a = aliasAfter(s, t)
    for (let x = k + 1; x <= (a ? a.last : t); x++) skip.add(x)
  }
  for (let k = select; k < end; k++) {
    if ((k >= j.first && k < j.after) || (moved && k >= moved.from && k < moved.to)) continue
    const t = toks[k]
    if ((t.kind !== 'word' && t.kind !== 'br') || skip.has(k)) continue
    if (t.kind === 'word' && /^[@#]/.test(t.text)) continue
    if (isOp(s, k - 1, '.') || isOp(s, k + 1, '.') || isOp(s, k + 1, '(')) continue
    if (t.kind === 'word' && NOT_COLUMN.has(t.text.toUpperCase())) continue
    return true
  }
  return false
}

function rewriteOnce(body: string): { body: string; note: string } | null {
  const s = scan(body)
  if (!s.balanced) return null
  const { toks } = s
  for (let i = 0; i < toks.length; i++) {
    if (kw(s, i) !== 'JOIN') continue
    const j = parseJoin(s, i)
    if (!j) continue
    const owner = owningSelect(s, j)
    if (!owner) continue
    // a bare * would lose the junction's columns
    let star = false
    for (let k = owner.select + 1; k < owner.from; k++)
      if (toks[k].depth === j.depth && isOp(s, k, '*') && !isOp(s, k - 1, '.')) star = true
    if (star) continue

    // the WHERE of this query, if any: past further joins, before GROUP BY / the statement end
    const fromEnd = clauseEnd(s, j.after, j.depth, new Set([...WHERE_END, 'WHERE']))
    let unsafe = false
    for (let k = owner.from; k < fromEnd; k++)
      if (toks[k].depth === j.depth && UNSAFE_FROM.has(kw(s, k))) unsafe = true
    if (unsafe) continue
    const where = kw(s, fromEnd) === 'WHERE' ? fromEnd : -1
    const wFrom = where + 1
    const wTo = where >= 0 ? clauseEnd(s, wFrom, j.depth, WHERE_END) : -1
    const parts = where >= 0 ? conjuncts(s, wFrom, wTo, j.depth) : []
    if (!parts) continue // a top-level OR: no true conjuncts to move

    const onRefs = refsTo(s, j.alias, j.onFrom, j.after)
    const mine = parts.filter((p) => refsTo(s, j.alias, p.from, p.to) > 0)
    const used = mine.reduce((n, p) => n + refsTo(s, j.alias, p.from, p.to), onRefs)
    if (refsTo(s, j.alias) !== used || mine.length > 1) continue
    if (mine.length === 0 && (j.kind === 'left' || where < 0)) continue
    if (nestedNeedsQualified(s, j, owner.select) && hasUnqualified(s, j, owner.select, mine[0]))
      continue

    const onText = body.slice(toks[j.onFrom].start, toks[j.after - 1].end)
    const on = hasTopOr(s, j.onFrom, j.after, j.depth) ? `(${onText})` : onText
    const exists = (pred: string) => `EXISTS (SELECT 1 FROM ${j.table} WHERE ${on}${pred})`
    const edits: Array<[number, number, string]> = []
    if (mine.length === 0) {
      edits.push([toks[wTo - 1].end, toks[wTo - 1].end, ` AND ${exists('')}`])
    } else {
      let { from, to } = mine[0]
      while (isOp(s, from, '(') && s.close.get(from) === to - 1) {
        from++
        to--
      }
      // `(@P IS NULL OR <pred>)` — the escape stays outside a LEFT join's EXISTS
      const escaped =
        from > mine[0].from &&
        /^@[^@]/.test(toks[from].text) &&
        kw(s, from + 1) === 'IS' &&
        kw(s, from + 2) === 'NULL' &&
        kw(s, from + 3) === 'OR'
      const predFrom = escaped ? from + 4 : from
      if (!nullRejecting(s, j.alias, predFrom, to)) continue
      const span = (a: number, b: number) => body.slice(toks[a].start, toks[b - 1].end)
      if (j.kind === 'inner' && escaped) {
        const c = mine[0]
        edits.push([toks[c.from].start, toks[c.to - 1].end, exists(` AND ${span(c.from, c.to)}`)])
      } else {
        edits.push([toks[predFrom].start, toks[to - 1].end, exists(` AND ${span(predFrom, to)}`)])
      }
    }

    // drop the join; take its line with it when it had one to itself
    let a = toks[j.first].start
    const b = toks[j.after - 1].end
    while (a > 0 && (body[a - 1] === ' ' || body[a - 1] === '\t')) a--
    if (body[a - 1] === '\n' && /^[ \t]*(\r?\n|$)/.test(body.slice(b))) a--
    edits.push([a, b, ''])
    const line = lineOf(body, toks[j.first].start)
    return {
      body: splice(body, edits),
      note: `line ${line}: ${j.table} was filter-only — now ${
        mine.length ? 'EXISTS inside its predicate' : 'an EXISTS gate'
      } (a row no longer repeats once per ${j.alias} match)`
    }
  }
  return null
}

export const junctionExists: Transformer = {
  id: 'junction-exists',
  apply(body) {
    const notes: string[] = []
    let sql = body
    for (let pass = 0; pass < 10; pass++) {
      const r = rewriteOnce(sql)
      if (!r) break
      sql = r.body
      notes.push(r.note)
    }
    return notes.length ? { body: sql, notes } : null
  }
}
