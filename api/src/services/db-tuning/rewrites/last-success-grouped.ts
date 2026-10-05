import type { Transformer } from './index.js'
import {
  aliasAfter,
  conjuncts,
  ident,
  insertBefore,
  isOp,
  isQualifier,
  kw,
  lineOf,
  namesOtherAlias,
  type Scan,
  STMT,
  scan,
  splice,
  statementStartOk,
  tableRef
} from './scan.js'

/**
 * `outer.id > ISNULL((SELECT MAX(s.id) FROM t s WHERE s.k = outer.k AND <const>), 0)` with ONE
 * id in the IN list made SQL Server re-scan the subquery per row (280k logical reads, 2026-10-01).
 * A derived table flattens into the same plan; a GROUP BY into a temp table does not. The
 * transformer hoists the grouped MAX into `#ls_n` before the statement and LEFT JOINs it once —
 * one row per key, NULL where the key had none, exactly what the scalar subquery returned.
 * Narrow on purpose: the subquery must sit in the WHERE of a top-level SELECT whose FIRST FROM
 * table is the correlated alias; the correlation is one equality (either side), the rest of the
 * subquery's WHERE names only its own alias, and no top-level OR. Declines a bare `*` or an
 * unqualified key / max_id name in the statement (the join would add or clash with them), and a
 * statement that is the lone body of an IF / ELSE / WHILE.
 */
interface Shape {
  /** ISNULL token, the subquery's `(`…`)`. */
  at: number
  subOpen: number
  subClose: number
  idCol: string
  keyCol: string
  /** Token of the inner key column and of the outer alias in the correlation. */
  keyAt: number
  outerAt: number
  table: string
  inner: string
  outer: string
  outerKey: string
  /** Token range of the constant predicate (after the correlation's AND). */
  constFrom: number
  constTo: number
}

function shapeAt(s: Scan, i: number): Shape | null {
  const { toks } = s
  // ISNULL ( ( SELECT MAX ( a . id ) FROM t s WHERE …
  if (kw(s, i) !== 'ISNULL' || !isOp(s, i + 1, '(') || !isOp(s, i + 2, '(')) return null
  if (kw(s, i + 3) !== 'SELECT' || kw(s, i + 4) !== 'MAX' || !isOp(s, i + 5, '(')) return null
  if (!isQualifier(s, i + 6) || !isOp(s, i + 9, ')') || kw(s, i + 10) !== 'FROM') return null
  const idTok = toks[i + 8]
  if (idTok.kind !== 'word' && idTok.kind !== 'br') return null
  const tableEnd = tableRef(s, i + 11)
  if (tableEnd < 0) return null
  const ref = aliasAfter(s, tableEnd)
  if (!ref || kw(s, ref.last + 1) !== 'WHERE') return null
  const inner = ident(toks[ref.alias])
  if (ident(toks[i + 6]) !== inner) return null
  const subOpen = i + 2
  const subClose = s.close.get(subOpen)
  if (subClose === undefined || !isOp(s, subClose + 1, ',')) return null
  const parts = conjuncts(s, ref.last + 2, subClose, toks[subOpen].depth + 1)
  if (!parts || parts.length < 2) return null

  // the correlation: inner.k = outer.k (or flipped), seven tokens exactly
  const c = parts[0]
  if (c.to - c.from !== 7 || !isQualifier(s, c.from) || !isQualifier(s, c.from + 4)) return null
  if (!isOp(s, c.from + 3, '=')) return null
  const left = ident(toks[c.from])
  const right = ident(toks[c.from + 4])
  let innerCol: number
  let outerAt: number
  if (left === inner && right !== inner) [innerCol, outerAt] = [c.from + 2, c.from + 4]
  else if (right === inner && left !== inner) [innerCol, outerAt] = [c.from + 6, c.from]
  else return null
  const constFrom = parts[1].from
  const constTo = parts[parts.length - 1].to
  if (namesOtherAlias(s, inner, constFrom, constTo)) return null

  const text = (k: number) => toks[k].text
  const hint =
    ref.last > ref.alias ? ` ${s.sql.slice(toks[ref.alias + 1].start, toks[ref.last].end)}` : ''
  return {
    at: i,
    subOpen,
    subClose,
    idCol: idTok.text,
    keyCol: text(innerCol),
    keyAt: innerCol,
    outerAt,
    table: s.sql.slice(toks[i + 11].start, toks[tableEnd].end) + hint,
    inner,
    outer: text(outerAt),
    outerKey: text(outerAt + 2),
    constFrom,
    constTo
  }
}

/**
 * The top-level SELECT whose WHERE holds token `at` and whose first FROM table is aliased
 * `outer` (lower-cased): its SELECT / FROM tokens, where that table reference ends, its end.
 */
function statementOf(s: Scan, at: number, outer: string) {
  const { toks } = s
  if (toks[at].depth !== 0) return null
  let where = -1
  let from = -1
  let select = -1
  for (let i = at - 1; i >= 0 && select < 0; i--) {
    if (toks[i].depth !== 0) continue
    if (isOp(s, i, ';')) return null
    if (s.caseStart.has(i)) {
      i = s.caseStart.get(i)!
      continue
    }
    const w = kw(s, i)
    if (!w) continue
    if (where < 0) {
      if (w === 'WHERE') where = i
      else if (['FROM', 'ON', 'HAVING', 'BY', 'JOIN', 'INTO', 'VALUES'].includes(w)) return null
      else if (STMT.has(w)) return null
    } else if (from < 0) {
      if (w === 'FROM') from = i
      else if (STMT.has(w) && !(w === 'WITH' && isOp(s, i + 1, '('))) return null
    } else if (w === 'SELECT') select = i
    else if (STMT.has(w)) return null
  }
  if (select < 0) return null
  const tableEnd = tableRef(s, from + 1)
  if (tableEnd < 0) return null
  const ref = aliasAfter(s, tableEnd)
  if (!ref || ident(toks[ref.alias]) !== outer) return null
  // where the statement ends: `;`, the next statement, or a set operator (decline those)
  let end = toks.length
  for (let i = where + 1; i < toks.length; i++) {
    if (toks[i].depth !== 0) continue
    if (isOp(s, i, ';')) {
      end = i
      break
    }
    const w = kw(s, i)
    if (s.caseEnd.has(i)) i = s.caseEnd.get(i)!
    else if (['UNION', 'EXCEPT', 'INTERSECT'].includes(w)) return null
    else if (STMT.has(w) && !(w === 'WITH' && isOp(s, i + 1, '('))) {
      end = i
      break
    }
  }
  return { select, from, joinAfter: ref.last, end }
}

function freeName(s: Scan): number {
  const names = new Set(s.toks.map((t) => ident(t)))
  let n = 1
  while (names.has(`#ls_${n}`) || names.has(`ls_${n}`)) n++
  return n
}

function rewriteOnce(body: string): { body: string; note: string } | null {
  const s = scan(body)
  if (!s.balanced) return null
  const { toks } = s
  for (let i = 0; i < toks.length; i++) {
    const m = shapeAt(s, i)
    if (!m) continue
    const st = statementOf(s, i, ident(toks[m.outerAt]))
    if (!st || !statementStartOk(s, st.select)) continue
    // a bare * would pick up the join's columns; an unqualified key / max_id would turn ambiguous
    const key = ident(toks[m.keyAt])
    if (key === 'max_id') continue
    let clash = false
    for (let k = st.select + 1; k < st.end; k++) {
      if (k >= m.subOpen && k <= m.subClose) continue
      const t = toks[k]
      if (t.depth === 0 && k < st.from && isOp(s, k, '*') && !isOp(s, k - 1, '.')) clash = true
      const name = ident(t)
      if (
        (name === key || name === 'max_id') &&
        !isOp(s, k - 1, '.') &&
        !isOp(s, k + 1, '.') &&
        !isOp(s, k + 1, '(')
      )
        clash = true
    }
    if (clash) continue

    const n = freeName(s)
    const tmp = `#ls_${n}`
    const ls = `ls_${n}`
    // the constant predicate without the inner alias: `s.ok = 1` → `ok = 1`
    const strip: Array<[number, number, string]> = []
    for (let k = m.constFrom; k < m.constTo; k++)
      if (isQualifier(s, k) && ident(toks[k]) === m.inner)
        strip.push([
          toks[k].start - toks[m.constFrom].start,
          toks[k + 1].end - toks[m.constFrom].start,
          ''
        ])
    const constText = splice(body.slice(toks[m.constFrom].start, toks[m.constTo - 1].end), strip)
    const hoist = [
      `IF OBJECT_ID('tempdb..${tmp}') IS NOT NULL DROP TABLE ${tmp};`,
      `SELECT ${m.keyCol}, MAX(${m.idCol}) AS max_id INTO ${tmp} FROM ${m.table} WHERE ${constText} GROUP BY ${m.keyCol};`
    ]
    const [hoistAt, hoistText] = insertBefore(body, toks[st.select].start, hoist)
    const fromLine = body.lastIndexOf('\n', toks[st.from].start - 1) + 1
    const indent = /^[ \t]*/.exec(body.slice(fromLine))![0]
    const joinAt = toks[st.joinAfter].end
    const edits: Array<[number, number, string]> = [
      [hoistAt, hoistAt, hoistText],
      [
        joinAt,
        joinAt,
        `\n${indent}LEFT JOIN ${tmp} ${ls} ON ${ls}.${m.keyCol} = ${m.outer}.${m.outerKey}`
      ],
      [toks[m.subOpen].start, toks[m.subClose].end, `${ls}.max_id`]
    ]
    return {
      body: splice(body, edits),
      note: `line ${lineOf(body, toks[i].start)}: correlated MAX(${m.idCol}) per ${m.keyCol} hoisted into ${tmp} and joined once`
    }
  }
  return null
}

export const lastSuccessGrouped: Transformer = {
  id: 'last-success-grouped',
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
