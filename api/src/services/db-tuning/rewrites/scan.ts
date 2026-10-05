/**
 * The token scan the rewrite transformers share. `--` and (nested) block comments are skipped,
 * `'…'` / `N'…'` literals and `[…]` / `"…"` names are single tokens, and every token keeps its
 * offsets into the ORIGINAL text — a transformer finds its shape on the tokens and splices the
 * original, so a keyword inside a string or a comment can never match. Self-contained on purpose
 * (twin.ts's scanner rewrites text and loses offsets).
 */
export interface Tok {
  kind: 'word' | 'num' | 'str' | 'br' | 'op'
  text: string
  start: number
  end: number
  /** Paren depth; `(` and `)` carry the depth outside them. */
  depth: number
}

export interface Scan {
  sql: string
  toks: Tok[]
  /** False when parens or CASE/END do not pair up — every transformer declines then. */
  balanced: boolean
  /** `(` index → its `)` index, and back. */
  close: Map<number, number>
  open: Map<number, number>
  /** CASE index → its END index, and back. */
  caseEnd: Map<number, number>
  caseStart: Map<number, number>
  /** The procedure header's AS (`CREATE PROC x @a INT AS`), or -1. */
  headerAs: number
}

/** Words that start a statement — at depth 0 they end whatever clause came before. */
export const STMT = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'SET',
  'DECLARE',
  'EXEC',
  'EXECUTE',
  'PRINT',
  'RETURN',
  'RAISERROR',
  'THROW',
  'TRUNCATE',
  'CREATE',
  'DROP',
  'ALTER',
  'OPEN',
  'FETCH',
  'CLOSE',
  'DEALLOCATE',
  'WAITFOR',
  'BREAK',
  'CONTINUE',
  'GOTO',
  'COMMIT',
  'ROLLBACK',
  'SAVE',
  'USE',
  'GO',
  'BEGIN',
  'END',
  'IF',
  'ELSE',
  'WHILE',
  'WITH'
])

const OPS2 = new Set(['<=', '>=', '<>', '!=', '!<', '!>', '+=', '-=', '*=', '/=', '::'])
const NO_END = new Set(['TRAN', 'TRANSACTION', 'DISTRIBUTED', 'DIALOG', 'CONVERSATION'])

export function scan(sql: string): Scan {
  const toks: Tok[] = []
  const n = sql.length
  let depth = 0
  let i = 0
  const push = (kind: Tok['kind'], start: number) =>
    toks.push({ kind, text: sql.slice(start, i), start, end: i, depth })
  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    const start = i
    if (/\s/.test(c)) i++
    else if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      let d = 0
      while (i < n) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          d++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          d--
          i += 2
          if (d === 0) break
        } else i++
      }
    } else if (c === "'" || ((c === 'N' || c === 'n') && next === "'")) {
      i += c === "'" ? 1 : 2
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2
        else if (sql[i++] === "'") break
      }
      push('str', start)
    } else if (c === '[' || c === '"') {
      const shut = c === '[' ? ']' : '"'
      i++
      while (i < n) {
        if (sql[i] === shut && sql[i + 1] === shut) i += 2
        else if (sql[i++] === shut) break
      }
      push('br', start)
    } else if (/[\p{L}_@#]/u.test(c)) {
      i++
      while (i < n && /[\p{L}\p{N}_@#$]/u.test(sql[i])) i++
      push('word', start)
    } else if (/\d/.test(c)) {
      while (i < n && /[\w.]/.test(sql[i])) i++
      push('num', start)
    } else if (c === '(') {
      i++
      push('op', start)
      depth++
    } else if (c === ')') {
      i++
      depth--
      push('op', start)
    } else {
      i += OPS2.has(c + next) ? 2 : 1
      push('op', start)
    }
  }

  const s: Scan = {
    sql,
    toks,
    balanced: depth === 0,
    close: new Map(),
    open: new Map(),
    caseEnd: new Map(),
    caseStart: new Map(),
    headerAs: -1
  }
  const parens: number[] = []
  const blocks: Array<{ kind: 'case' | 'block'; at: number }> = []
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]
    if (t.kind === 'op' && t.text === '(') parens.push(k)
    else if (t.kind === 'op' && t.text === ')') {
      const o = parens.pop()
      if (o === undefined) s.balanced = false
      else {
        s.close.set(o, k)
        s.open.set(k, o)
      }
    }
    const w = kw(s, k)
    if (w === 'CASE') blocks.push({ kind: 'case', at: k })
    else if (w === 'BEGIN' && !NO_END.has(kw(s, k + 1))) blocks.push({ kind: 'block', at: k })
    else if (w === 'END') {
      const b = blocks.pop()
      if (b?.kind === 'case') {
        s.caseEnd.set(b.at, k)
        s.caseStart.set(k, b.at)
      }
    }
  }
  if (parens.length || blocks.some((b) => b.kind === 'case')) s.balanced = false

  // the header AS: the first depth-0 AS after PROC that a statement follows (not `@p AS INT`,
  // not `EXECUTE AS OWNER`)
  const proc = toks.findIndex((_, k) => /^PROC(EDURE)?$/.test(kw(s, k)))
  if (proc >= 0 && proc < 5) {
    for (let k = proc + 1; k < toks.length; k++) {
      if (toks[k].depth !== 0 || kw(s, k) !== 'AS') continue
      const nx = toks[k + 1]
      if (!nx || STMT.has(kw(s, k + 1)) || (nx.kind === 'op' && nx.text === ';')) {
        s.headerAs = k
        break
      }
    }
  }
  return s
}

/** The upper-cased word at `k` when it can be a keyword (not `a.word`, not `word.col`), else ''. */
export function kw(s: Scan, k: number): string {
  const t = s.toks[k]
  if (t?.kind !== 'word') return ''
  if (isOp(s, k - 1, '.') || isOp(s, k + 1, '.')) return ''
  return t.text.toUpperCase()
}

export const isOp = (s: Scan, k: number, op: string): boolean =>
  s.toks[k]?.kind === 'op' && s.toks[k].text === op

/** The lower-cased name of an identifier token (`pz`, `[pz]`, `"pz"`), or ''. */
export function ident(t: Tok | undefined): string {
  if (!t) return ''
  if (t.kind === 'word') return t.text.toLowerCase()
  if (t.kind === 'br') return t.text.slice(1, -1).toLowerCase()
  return ''
}

/** True when `k` is `<name>.` — a qualifier, not the middle of `db.schema.table`. */
export const isQualifier = (s: Scan, k: number): boolean =>
  (s.toks[k]?.kind === 'word' || s.toks[k]?.kind === 'br') &&
  isOp(s, k + 1, '.') &&
  !isOp(s, k - 1, '.')

/** How many `alias.` qualifiers fall in tokens [from, to). */
export function refsTo(s: Scan, alias: string, from = 0, to = s.toks.length): number {
  let n = 0
  for (let k = from; k < to; k++) if (isQualifier(s, k) && ident(s.toks[k]) === alias) n++
  return n
}

/** Whether tokens [from, to) qualify any column with a name other than `alias` (any, for null). */
export function namesOtherAlias(s: Scan, alias: string | null, from: number, to: number): boolean {
  for (let k = from; k < to; k++) if (isQualifier(s, k) && ident(s.toks[k]) !== alias) return true
  return false
}

/**
 * Split tokens [from, to) at `depth` on AND — skipping CASE…END and the AND of a BETWEEN.
 * Returns null when an OR sits at that level: the pieces would not be true conjuncts.
 */
export function conjuncts(
  s: Scan,
  from: number,
  to: number,
  depth: number
): Array<{ from: number; to: number }> | null {
  const out: Array<{ from: number; to: number }> = []
  let start = from
  let between = false
  for (let k = from; k < to; k++) {
    if (s.toks[k].depth !== depth) continue
    const w = kw(s, k)
    if (w === 'CASE') k = s.caseEnd.get(k) ?? k
    else if (w === 'OR') return null
    else if (w === 'BETWEEN') between = true
    else if (w === 'AND') {
      if (between) between = false
      else {
        out.push({ from: start, to: k })
        start = k + 1
      }
    }
  }
  out.push({ from: start, to })
  return out.some((c) => c.to <= c.from) ? null : out
}

/** Whether tokens [from, to) hold an OR at `depth` (outside CASE…END). */
export function hasTopOr(s: Scan, from: number, to: number, depth: number): boolean {
  return conjuncts(s, from, to, depth) === null
}

/**
 * Whether a statement can be inserted right before token `k` without changing what the code
 * around it means. Walks back to the previous statement boundary: a `;`, BEGIN/END, the header
 * AS or the start are fine, and so is any complete earlier statement. IF / ELSE / WHILE (whose
 * lone body this would be), a CTE's WITH, UNION and INSERT (which would own the statement) and
 * `DECLARE … CURSOR FOR` all refuse.
 */
export function statementStartOk(s: Scan, k: number): boolean {
  const depth = s.toks[k].depth
  for (let i = k - 1; i >= 0; i--) {
    const t = s.toks[i]
    if (t.depth > depth) continue
    if (t.depth < depth) return false
    if (t.kind === 'op' && t.text === ')') {
      i = s.open.get(i) ?? i
      continue
    }
    if (t.kind === 'op' && t.text === ';') return true
    if (i === s.headerAs) return true
    const w = kw(s, i)
    if (!w) continue
    if (s.caseStart.has(i)) {
      i = s.caseStart.get(i)!
      continue
    }
    if (['IF', 'ELSE', 'WHILE', 'UNION', 'EXCEPT', 'INTERSECT', 'INSERT', 'FOR'].includes(w))
      return false
    if (w === 'WITH') {
      if (isOp(s, i + 1, '(')) continue // a table hint, inside the earlier statement
      return false
    }
    if (w === 'UPDATE' && isOp(s, i + 1, '(')) continue // UPDATE(col) in a trigger IF
    if (w === 'PROC' || w === 'PROCEDURE') return false
    if (STMT.has(w)) return true
  }
  return true
}

/**
 * Skip over a table reference starting at `k`: `t`, `dbo.t`, `[dbo].[t]`. Returns the index of
 * its last token, or -1 when `k` is not a plain table name (a derived table, a function call).
 */
export function tableRef(s: Scan, k: number): number {
  const t = s.toks[k]
  if (!t || (t.kind !== 'word' && t.kind !== 'br')) return -1
  let end = k
  while (isOp(s, end + 1, '.')) {
    const nx = s.toks[end + 2]
    if (!nx || (nx.kind !== 'word' && nx.kind !== 'br')) return -1
    end += 2
  }
  return isOp(s, end + 1, '(') ? -1 : end
}

/** Words that can never be a table alias. */
export const NOT_ALIAS = new Set([
  'ON',
  'WITH',
  'WHERE',
  'JOIN',
  'LEFT',
  'RIGHT',
  'INNER',
  'OUTER',
  'FULL',
  'CROSS',
  'GROUP',
  'ORDER',
  'HAVING',
  'UNION',
  'OPTION',
  'FOR',
  'AS',
  ...STMT
])

/**
 * After a table reference ending at `end`: `[AS] alias [WITH (hint)]`. Returns the alias token
 * index and the index of the last token of the whole reference, or null when there is no alias.
 */
export function aliasAfter(s: Scan, end: number): { alias: number; last: number } | null {
  let k = end + 1
  if (kw(s, k) === 'AS') k++
  const a = s.toks[k]
  if (!a || (a.kind !== 'word' && a.kind !== 'br') || NOT_ALIAS.has(kw(s, k))) return null
  if (a.kind === 'word' && /^[@#]/.test(a.text)) return null
  let last = k
  if (kw(s, k + 1) === 'WITH' && isOp(s, k + 2, '(')) last = s.close.get(k + 2) ?? -1
  return last < 0 ? null : { alias: k, last }
}

export const lineOf = (sql: string, offset: number): number =>
  sql.slice(0, offset).split('\n').length

/**
 * Text to put before the statement at `offset`: on its own line with the statement's indent when
 * the statement starts its line, else inline (`…; <text> SELECT`).
 */
export function insertBefore(sql: string, offset: number, lines: string[]): [number, string] {
  const lineStart = sql.lastIndexOf('\n', offset - 1) + 1
  const indent = sql.slice(lineStart, offset)
  if (/^[ \t]*$/.test(indent)) return [lineStart, lines.map((l) => `${indent}${l}\n`).join('')]
  return [offset, `${lines.join(' ')} `]
}

/** Apply non-overlapping [start, end, text] edits to `sql`. */
export function splice(sql: string, edits: Array<[number, number, string]>): string {
  let out = sql
  for (const [a, b, text] of [...edits].sort((x, y) => y[0] - x[0]))
    out = out.slice(0, a) + text + out.slice(b)
  return out
}
