/**
 * A small T-SQL masker for the SQL checks (#2562): comments become spaces and string literal
 * contents become spaces (the quotes stay), so pattern checks never match text inside a comment
 * or a literal and every offset and line number still lines up with the original definition.
 * Bracketed / double-quoted identifiers are kept as written (names are what the checks need).
 */

/** The definition with comments and literal contents blanked; same length, same line breaks. */
export function maskSql(sql: string, opts: { literals?: boolean } = {}): string {
  const literals = opts.literals !== false
  const out = sql.split('')
  const n = sql.length
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '
  }
  let i = 0
  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      let j = i
      while (j < n && sql[j] !== '\n') j++
      blank(i, j)
      i = j
    } else if (c === '/' && next === '*') {
      // T-SQL block comments nest
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++
          j += 2
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--
          j += 2
        } else j++
      }
      blank(i, j)
      i = j
    } else if (c === "'") {
      let j = i + 1
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2
            continue
          }
          break
        }
        j++
      }
      if (literals) blank(i + 1, j)
      i = j + 1
    } else if (c === '[') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === ']') {
          if (sql[j + 1] === ']') {
            j += 2
            continue
          }
          break
        }
        j++
      }
      i = j + 1
    } else if (c === '"') {
      let j = i + 1
      while (j < n && sql[j] !== '"') j++
      i = j + 1
    } else i++
  }
  return out.join('')
}

/** 1-based line of an offset. */
export function lineAt(sql: string, offset: number): number {
  let line = 1
  for (let k = 0; k < offset && k < sql.length; k++) if (sql[k] === '\n') line++
  return line
}

/** `[dbo].[my table]` / `dbo.x` / `"x"` → { schema, name } (unquoted, `]]` unescaped). */
export function splitName(raw: string): { schema: string | null; name: string } {
  const parts: string[] = []
  let cur = ''
  let i = 0
  while (i < raw.length) {
    const c = raw[i]
    if (c === '[') {
      let j = i + 1
      while (j < raw.length) {
        if (raw[j] === ']') {
          if (raw[j + 1] === ']') {
            cur += ']'
            j += 2
            continue
          }
          break
        }
        cur += raw[j]
        j++
      }
      i = j + 1
    } else if (c === '"') {
      let j = i + 1
      while (j < raw.length && raw[j] !== '"') cur += raw[j++]
      i = j + 1
    } else if (c === '.') {
      parts.push(cur)
      cur = ''
      i++
    } else {
      cur += c
      i++
    }
  }
  parts.push(cur)
  const name = (parts.pop() ?? '').trim()
  const schema = parts.length ? (parts.pop() ?? '').trim() || null : null
  return { schema, name }
}

/** Index of the paren closing the one at `open` (masked text), or -1. */
export function matchParen(masked: string, open: number): number {
  let depth = 0
  for (let k = open; k < masked.length; k++) {
    if (masked[k] === '(') depth++
    else if (masked[k] === ')') {
      depth--
      if (depth === 0) return k
    }
  }
  return -1
}

/** Paren depth at every offset of the masked text (0 = top level). */
export function depthMap(masked: string): Int16Array {
  const d = new Int16Array(masked.length + 1)
  let depth = 0
  for (let k = 0; k < masked.length; k++) {
    if (masked[k] === '(') {
      d[k] = depth
      depth++
      continue
    }
    if (masked[k] === ')') depth = Math.max(0, depth - 1)
    d[k] = depth
  }
  d[masked.length] = depth
  return d
}

/** Collapse whitespace, lower-case: the shape a fingerprint or a drift compare reads. */
export function normaliseSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Definition text for a drift compare: comments dropped, whitespace collapsed, case folded and the
 * leading CREATE / ALTER / CREATE OR ALTER verb made one form, so redeploying the same body with a
 * different verb is not drift.
 */
export function canonicalDefinition(sql: string): string {
  // literal contents are part of the body; comments are not
  return normaliseSql(maskSql(sql, { literals: false })).replace(
    /^(create\s+or\s+alter|create|alter)\s+(proc|procedure)\b/,
    'create procedure'
  )
}
