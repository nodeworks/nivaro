/**
 * `:param` substitution for custom-query and widget SQL (M23, security audit 2026-10-27).
 *
 * Custom queries run as a raw tedious batch (sp_executesql swallows stored-procedure result
 * sets), so parameters become literals in the text. The old substitution was a bare
 * /:(\w+)/ replace: `LIKE '%:term%'` turned into `'%'<value>'%'`, and a value could close the
 * string and append statements. This walks the SQL as T-SQL tokens:
 *
 *   - outside quotes and comments, `:name` becomes a complete literal — NULL, 1/0, a number,
 *     or a quoted string with every `'` doubled (unchanged from before);
 *   - INSIDE a string literal ('…' / N'…'), `:name` of a DECLARED param becomes the value's
 *     text with `'` doubled — it stays inside that literal whatever it contains, so
 *     `'%:term%'` finally works as authors meant; an undeclared `:name` (e.g. '12:30') is
 *     left as written;
 *   - comments (-- … and nested slash-star blocks), [bracketed] and "quoted" identifiers are
 *     never touched, so a value can never close a comment or an identifier;
 *   - `::` (type::Method) is not a parameter.
 *
 * Leaf module: no app imports.
 */

/** The literal SQL Server sees for a value used as a whole token. */
export function sqlLiteral(v: unknown): string {
  if (v == null || v === '') return 'NULL'
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return 'NULL'
    return `'${v.toISOString().slice(0, 23).replace('T', ' ')}'`
  }
  return `'${String(v).replace(/'/g, "''")}'`
}

/** The text a value contributes INSIDE an existing string literal (quotes doubled). */
export function sqlLiteralInner(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 23).replace('T', ' ')
  }
  return String(v).replace(/'/g, "''")
}

const WORD = /[A-Za-z0-9_]/

function readName(sql: string, from: number): string {
  let j = from
  while (j < sql.length && WORD.test(sql[j] as string)) j++
  return sql.slice(from, j)
}

export function substituteParams(sqlText: string, params: Record<string, unknown>): string {
  const sql = String(sqlText ?? '')
  const has = (k: string) => Object.hasOwn(params, k)
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i] as string
    const next = sql[i + 1]

    // -- line comment: copied as is up to the newline
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? n : end
      out += sql.slice(i, stop)
      i = stop
      continue
    }
    // /* block comment */ — T-SQL nests them
    if (c === '/' && next === '*') {
      let depth = 0
      let j = i
      while (j < n) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++
          j += 2
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--
          j += 2
          if (depth === 0) break
        } else j++
      }
      out += sql.slice(i, j)
      i = j
      continue
    }
    // [bracketed identifier] (]] escapes ])
    if (c === '[') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === ']') {
          if (sql[j + 1] === ']') {
            j += 2
            continue
          }
          j++
          break
        }
        j++
      }
      out += sql.slice(i, j)
      i = j
      continue
    }
    // "quoted identifier" ("" escapes ")
    if (c === '"') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2
            continue
          }
          j++
          break
        }
        j++
      }
      out += sql.slice(i, j)
      i = j
      continue
    }
    // 'string literal' ('' escapes ') — declared :params inside become escaped text
    if (c === "'") {
      out += c
      let j = i + 1
      while (j < n) {
        const d = sql[j] as string
        if (d === "'") {
          if (sql[j + 1] === "'") {
            out += "''"
            j += 2
            continue
          }
          out += d
          j++
          break
        }
        if (d === ':' && sql[j + 1] !== ':' && sql[j - 1] !== ':') {
          const name = readName(sql, j + 1)
          if (name && has(name)) {
            out += sqlLiteralInner(params[name])
            j += 1 + name.length
            continue
          }
        }
        out += d
        j++
      }
      i = j
      continue
    }
    // :param in code
    if (c === ':') {
      if (next === ':') {
        // type::Method — copy both colons and the member name untouched
        out += '::'
        i += 2
        out += readName(sql, i)
        i += readName(sql, i).length
        continue
      }
      const name = readName(sql, i + 1)
      if (name) {
        out += sqlLiteral(params[name])
        i += 1 + name.length
        continue
      }
    }
    out += c
    i++
  }
  return out
}
