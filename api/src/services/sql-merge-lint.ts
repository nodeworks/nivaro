/**
 * Find MERGE statements whose match key cannot match NULL.
 *
 *   MERGE t USING s ON s.project = t.project …
 *   WHEN NOT MATCHED THEN INSERT …
 *
 * `NULL = NULL` is not true in T-SQL, so a row whose key column is NULL never
 * matches its own earlier copy and WHEN NOT MATCHED inserts it again — on every
 * run, forever. Nothing errors; the table just grows, and anything that sums
 * it reads the copies as real. The guard is either
 *
 *   (s.x = t.x OR (s.x IS NULL AND t.x IS NULL))
 *
 * or an ISNULL/COALESCE on both sides.
 *
 * This file is the pure half: it reads SQL text and reports every plain
 * equality in a MERGE … ON clause. Whether a finding matters depends on the
 * column being nullable, which only a database can say — see `gradeFindings`.
 */

export interface MergeKeyFinding {
  /** Target table as written (schema and brackets stripped). */
  target: string
  targetAlias: string
  sourceAlias: string | null
  /** The column on the TARGET side of the equality. */
  targetColumn: string
  /** The source-side expression, as written. */
  sourceExpr: string
  /**
   * EVERY target column the ON clause reads, guarded or not — the whole match
   * key. Needed to ask the data whether the defect has fired: duplicates only
   * mean something when grouped by the full key.
   */
  keyColumns: string[]
  /** The offending conjunct, whitespace collapsed. */
  clause: string
  /** 1-based line of the MERGE keyword. */
  line: number
}

export type MergeKeySeverity = 'unsafe' | 'safe' | 'unknown'

export interface GradedMergeKeyFinding extends MergeKeyFinding {
  severity: MergeKeySeverity
  reason: string
}

const IDENT = String.raw`(?:\[[^\]]+\]|[A-Za-z_#@][\w$#@]*)`
const QUALIFIED = new RegExp(String.raw`^(${IDENT})\s*\.\s*(${IDENT})$`)

/** Blank out comments and string literals, preserving offsets and newlines. */
export function maskSql(sql: string): string {
  const out = sql.split('')
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' '
  }
  let i = 0
  while (i < sql.length) {
    const two = sql.slice(i, i + 2)
    if (two === '--') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      blank(i, stop)
      i = stop
    } else if (two === '/*') {
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? sql.length : end + 2
      blank(i, stop)
      i = stop
    } else if (sql[i] === "'") {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2
        else if (sql[j] === "'") break
        else j++
      }
      blank(i + 1, j)
      i = j + 1
    } else {
      i++
    }
  }
  return out.join('')
}

const unbracket = (s: string) => s.replace(/^\[|\]$/g, '')

/** Index of the first `word` at paren depth 0 at or after `from`, else -1. */
function findAtDepthZero(text: string, word: RegExp, from: number): number {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0) {
      word.lastIndex = i
      const m = word.exec(text)
      if (m && m.index === i) return i
    }
  }
  return -1
}

/** Split on top-level AND. */
function splitConjuncts(clause: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  const and = /\bAND\b/giy
  for (let i = 0; i < clause.length; i++) {
    const ch = clause[i]
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0) {
      and.lastIndex = i
      const m = and.exec(clause)
      if (m && m.index === i && !/\w/.test(clause[i - 1] ?? ' ')) {
        parts.push(clause.slice(start, i))
        start = i + m[0].length
        i = start - 1
      }
    }
  }
  parts.push(clause.slice(start))
  return parts.map((p) => p.trim()).filter(Boolean)
}

/** Strip one layer of wrapping parens when they enclose the whole string. */
function unwrap(expr: string): string {
  let s = expr.trim()
  for (;;) {
    if (!s.startsWith('(') || !s.endsWith(')')) return s
    let depth = 0
    let closesAtEnd = true
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++
      else if (s[i] === ')') {
        depth--
        if (depth === 0 && i < s.length - 1) {
          closesAtEnd = false
          break
        }
      }
    }
    if (!closesAtEnd) return s
    s = s.slice(1, -1).trim()
  }
}

export function findMergeKeys(sql: string): MergeKeyFinding[] {
  const masked = maskSql(sql)
  const findings: MergeKeyFinding[] = []
  const mergeRe = new RegExp(
    String.raw`\bMERGE\s+(?:TOP\s*\([^)]*\)\s*(?:PERCENT\s+)?)?(?:INTO\s+)?((?:${IDENT}\s*\.\s*)*${IDENT})(?:\s+WITH\s*\([^)]*\))?(?:\s+(?:AS\s+)?(?!USING\b)(${IDENT}))?\s+USING\b`,
    'gi'
  )

  for (let m = mergeRe.exec(masked); m; m = mergeRe.exec(masked)) {
    const target = unbracket(m[1].split('.').pop()?.trim() ?? m[1])
    const targetAlias = unbracket(m[2] ?? target)
    const afterUsing = m.index + m[0].length

    const onAt = findAtDepthZero(masked, /\bON\b/giy, afterUsing)
    if (onAt === -1) continue
    const whenAt = findAtDepthZero(masked, /\bWHEN\b/giy, onAt + 2)
    if (whenAt === -1) continue

    // `USING <source> [AS] alias ON` — the alias is the last identifier before ON.
    const usingText = masked.slice(afterUsing, onAt).trim()
    const aliasMatch = new RegExp(String.raw`(?:\bAS\s+)?(${IDENT})\s*$`, 'i').exec(usingText)
    const sourceAlias = aliasMatch ? unbracket(aliasMatch[1]) : null

    const onClause = masked.slice(onAt + 2, whenAt)
    const line = masked.slice(0, m.index).split('\n').length
    const keyColumns = [
      ...new Set(
        [
          ...onClause.matchAll(
            new RegExp(String.raw`(${IDENT})\s*\.\s*(${IDENT})`, 'g')
          )
        ]
          .filter((k) => unbracket(k[1]).toLowerCase() === targetAlias.toLowerCase())
          .map((k) => unbracket(k[2]))
      )
    ]

    for (const raw of splitConjuncts(onClause)) {
      const conjunct = unwrap(raw)
      // A conjunct that mentions IS NULL, ISNULL( or COALESCE( is somebody
      // already handling NULL; whether they did it well is a review question,
      // not a pattern one.
      if (/\bIS\s+(?:NOT\s+)?NULL\b|\bISNULL\s*\(|\bCOALESCE\s*\(/i.test(conjunct)) continue
      const eq = /^(.+?)\s*=\s*(.+)$/.exec(conjunct)
      if (!eq || /[<>!]/.test(eq[1].slice(-1))) continue

      const sides = [eq[1].trim(), eq[2].trim()]
      const qualified = sides.map((s) => QUALIFIED.exec(s))
      const targetIdx = qualified.findIndex(
        (q) => q && unbracket(q[1]).toLowerCase() === targetAlias.toLowerCase()
      )
      if (targetIdx === -1) continue
      const q = qualified[targetIdx]
      if (!q) continue
      // `t.active = 1` is a filter, not a key: nothing on the other side comes
      // from the source, so there is no source NULL to fail to match.
      if (!new RegExp(String.raw`${IDENT}\s*\.\s*${IDENT}`).test(sides[1 - targetIdx])) continue

      findings.push({
        target,
        targetAlias,
        sourceAlias,
        targetColumn: unbracket(q[2]),
        sourceExpr: sides[1 - targetIdx],
        keyColumns,
        clause: conjunct.replace(/\s+/g, ' '),
        line
      })
    }
  }
  return findings
}

/**
 * Grade findings against real column nullability.
 *
 * `nullable(table, column)` answers true / false, or undefined when the table
 * or column is not known (a #temp target, a table this database lacks). An
 * unknown is reported rather than waved through: "could not check" is not
 * "checked and fine".
 */
export function gradeFindings(
  findings: MergeKeyFinding[],
  nullable: (table: string, column: string) => boolean | undefined
): GradedMergeKeyFinding[] {
  return findings.map((f) => {
    const answer = nullable(f.target, f.targetColumn)
    if (answer === true) {
      return {
        ...f,
        severity: 'unsafe' as const,
        reason: `${f.target}.${f.targetColumn} is nullable — a NULL key never matches, so the row is re-inserted on every run`
      }
    }
    if (answer === false) {
      return {
        ...f,
        severity: 'safe' as const,
        reason: `${f.target}.${f.targetColumn} is NOT NULL`
      }
    }
    return {
      ...f,
      severity: 'unknown' as const,
      reason: `${f.target}.${f.targetColumn} could not be looked up`
    }
  })
}
