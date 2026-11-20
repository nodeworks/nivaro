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

/**
 * The database the SQL runs on. SQL Server is the default and its output never changes.
 * Postgres: booleans are TRUE/FALSE, `$tag$…$tag$` bodies are never touched and an `E'…'`
 * string gets its backslashes doubled. MySQL: a backslash escapes inside a string, so every
 * backslash in a value is doubled; `#` comments and `backtick` identifiers are never touched.
 * SQLite: strings like SQL Server's (no backslash escapes), and `backtick` identifiers are
 * never touched, as on MySQL.
 */
export type SubstituteDialect = 'mssql' | 'pg' | 'mysql' | 'sqlite'

/** The literal style for a database (sql-dialect.ts name); anything unknown reads as SQL Server. */
export function substituteDialectOf(d: string): SubstituteDialect {
  return d === 'pg' || d === 'mysql' || d === 'sqlite' ? d : 'mssql'
}

/** A value's text with `'` doubled (and `\` doubled where the string reads backslash escapes). */
function quoteText(text: string, backslashes: boolean): string {
  const t = backslashes ? text.replace(/\\/g, '\\\\') : text
  return t.replace(/'/g, "''")
}

/** The literal SQL Server sees for a value used as a whole token. */
export function sqlLiteral(v: unknown, dialect: SubstituteDialect = 'mssql'): string {
  if (v == null || v === '') return 'NULL'
  if (typeof v === 'boolean') return dialect === 'pg' ? (v ? 'TRUE' : 'FALSE') : v ? '1' : '0'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return 'NULL'
    return `'${v.toISOString().slice(0, 23).replace('T', ' ')}'`
  }
  return `'${quoteText(String(v), dialect === 'mysql')}'`
}

/** The text a value contributes INSIDE an existing string literal (quotes doubled). */
export function sqlLiteralInner(v: unknown, backslashes = false): string {
  if (v == null) return ''
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 23).replace('T', ' ')
  }
  return quoteText(String(v), backslashes)
}

const WORD = /[A-Za-z0-9_]/

function readName(sql: string, from: number): string {
  let j = from
  while (j < sql.length && WORD.test(sql[j] as string)) j++
  return sql.slice(from, j)
}

export function substituteParams(
  sqlText: string,
  params: Record<string, unknown>,
  dialect: SubstituteDialect = 'mssql'
): string {
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
    if (dialect === 'mysql' && c === '#') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? n : end
      out += sql.slice(i, stop)
      i = stop
      continue
    }
    if ((dialect === 'mysql' || dialect === 'sqlite') && c === '`') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === '`') {
          if (sql[j + 1] === '`') {
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
    if (dialect === 'pg' && c === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (tag && !(i > 0 && WORD.test(sql[i - 1] as string))) {
        const close = sql.indexOf(tag[0], i + tag[0].length)
        const stop = close === -1 ? n : close + tag[0].length
        out += sql.slice(i, stop)
        i = stop
        continue
      }
    }
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
      // a string that reads backslash escapes: every MySQL string, a Postgres E'…' string
      const backslashes =
        dialect === 'mysql' ||
        (dialect === 'pg' &&
          /[Ee]/.test(sql[i - 1] ?? '') &&
          !(i > 1 && WORD.test(sql[i - 2] as string)))
      out += c
      let j = i + 1
      while (j < n) {
        const d = sql[j] as string
        if (backslashes && d === '\\') {
          // an escaped character: copy both, it never ends the literal
          out += sql.slice(j, j + 2)
          j += 2
          continue
        }
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
            out += sqlLiteralInner(params[name], backslashes)
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
        out += sqlLiteral(params[name], dialect)
        i += 1 + name.length
        continue
      }
    }
    out += c
    i++
  }
  return out
}
