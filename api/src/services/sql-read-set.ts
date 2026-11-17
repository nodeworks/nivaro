import { db } from '../db/index.js'

/**
 * What a piece of raw SQL reads (pentest M-4, 2026-11-16).
 *
 * The User-Scope backstop on custom queries (services/custom-query-scope.ts)
 * refuses a restricted person unless the query's scope_params cover every
 * dimension that reaches a table the SQL reads. It used to look only at names
 * after FROM/JOIN plus one level into EXEC'd procedures, so a query that read
 * scoped rows THROUGH A VIEW (`SELECT * FROM v_workflow_state`) or a
 * table-valued function looked like it read nothing scoped and ran unscoped —
 * every zone's rows for a zone-restricted person.
 *
 * No parser of T-SQL here can be trusted to find every reference (comma joins,
 * "quoted" names, bare procedure calls, functions in a select list, `db..name`),
 * so this does not try to: EVERY identifier outside string literals and
 * comments is looked up in sys.objects, and every table, view, function or
 * procedure found counts as read — then views / functions / procedures are
 * followed the same way, several levels deep. Over-counting (a column that
 * shares a table's name) only ever makes the gate stricter.
 *
 * What cannot be followed is reported as `opaque` — dynamic SQL, OPENQUERY-style
 * remote reads, another database or a linked server, a synonym, an encrypted
 * module, a CLR or external object, too many levels or names — and the gate
 * treats an opaque query as reaching EVERY dimension: refused for a restricted
 * person unless it declares scope_params (or `$not_scoped`). "Can't tell" is
 * answered "no", never "all rows".
 */

export interface ReadSet {
  /** Base tables read, lower-cased, minus system / staging / scratch ones. */
  tables: string[]
  /** Why part of the read set could not be worked out; empty = fully known. */
  opaque: string[]
}

const MAX_DEPTH = 5
const MAX_MODULES = 80
const MAX_NAMES = 4000
const SKIP = /^(nivaro_|sys|information_schema|staging_|zz_|temp_|#)/i

/** Objects SQL Server stores that hold or return no rows of their own. Every
 *  other type is a table, a module we follow, or opaque (allowlist, not denylist). */
const NO_ROWS = new Set(['PK', 'UQ', 'F', 'D', 'C', 'TT', 'PG', 'R', 'RF', 'SO'])
const MODULES = new Set(['V', 'IF', 'TF', 'FN', 'P', 'TR'])

export type Token =
  | { kind: 'ident'; text: string }
  | { kind: 'dot' }
  | { kind: 'literal'; text: string }
  | { kind: 'other'; text: string }

/**
 * Tokens of T-SQL, with string literals and comments taken out by a real scan
 * (a `--` or `/*` inside a literal is not a comment, a quote inside a comment
 * is not a literal). `[x]` and `"x"` are identifiers; `'…'` / `N'…'` literals
 * (doubled quotes escape) become one `literal` token holding the string's
 * contents (names inside it still count toward the read set). Variables (`@x`) and temp
 * tables (`#x`) are `other`.
 */
export function tokenize(sql: string): Token[] {
  const out: Token[] = []
  const n = sql.length
  let i = 0
  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      // T-SQL block comments nest.
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else i++
      }
      continue
    }
    if (c === "'" || ((c === 'N' || c === 'n') && next === "'")) {
      i += c === "'" ? 1 : 2
      let text = ''
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          text += "'"
          i += 2
        } else if (sql[i] === "'") {
          i++
          break
        } else text += sql[i++]
      }
      out.push({ kind: 'literal', text })
      continue
    }
    if (c === '[' || c === '"') {
      const close = c === '[' ? ']' : '"'
      let j = i + 1
      let text = ''
      while (j < n) {
        if (sql[j] === close && sql[j + 1] === close) {
          text += close
          j += 2
        } else if (sql[j] === close) break
        else text += sql[j++]
      }
      out.push({ kind: 'ident', text })
      i = j + 1
      continue
    }
    if (c === '.') {
      out.push({ kind: 'dot' })
      i++
      continue
    }
    if (c === '@' || c === '#') {
      let j = i + 1
      while (j < n && /[\p{L}\p{N}\p{Mn}\p{Mc}_@#$]/u.test(sql[j])) j++
      out.push({ kind: 'other', text: sql.slice(i, j) })
      i = j
      continue
    }
    // T-SQL identifiers follow the Unicode letter rules, not ASCII.
    if (/[\p{L}_]/u.test(c)) {
      let j = i + 1
      // `@` and `#` always start a new token, so `EXEC@proc` is EXEC + a variable.
      while (j < n && /[\p{L}\p{N}\p{Mn}\p{Mc}_$]/u.test(sql[j])) j++
      out.push({ kind: 'ident', text: sql.slice(i, j) })
      i = j
      continue
    }
    if (/\s/.test(c)) {
      i++
      continue
    }
    out.push({ kind: 'other', text: c })
    i++
  }
  return out
}

/** A dotted name as written: `a.b.c`, `a..c`, `[x].[y]`. Empty parts stay ''.
 *  Only names of two or more parts are returned. */
export function dottedNames(tokens: Token[]): string[][] {
  const out: string[][] = []
  let parts: string[] | null = null
  let last: 'ident' | 'dot' | null = null
  const flush = () => {
    if (parts && parts.length > 1) out.push(parts)
    parts = null
  }
  for (const t of tokens) {
    if (t.kind === 'ident') {
      // Two identifiers in a row are two names (`FROM dbo.a w`).
      if (last === 'ident') flush()
      if (!parts) parts = [t.text]
      else parts[parts.length - 1] = t.text
      last = 'ident'
    } else if (t.kind === 'dot') {
      if (!parts) parts = ['']
      parts.push('')
      last = 'dot'
    } else {
      flush()
      last = null
    }
  }
  flush()
  return out
}

const DYNAMIC: Array<[RegExp, string]> = [
  [/\bexec(?:ute)?\s*\(/i, 'dynamic SQL (EXEC of a string)'],
  [/\bsp_executesql\b/i, 'dynamic SQL (sp_executesql)'],
  [
    /\bsp_(?:prepexec|prepexecrpc|prepare|execute|cursoropen|cursorprepexec|cursorprepare|cursorexecute|execute_external_script)\b/i,
    'dynamic SQL (a system procedure that runs a string)'
  ],
  [/\bexec(?:ute)?\s*@\w+\b(?!\s*=)/i, 'a procedure named by a variable'],
  [
    /\bopen(?:query|rowset|datasource|xml)\s*\(/i,
    'a remote or document read (OPENQUERY / OPENROWSET)'
  ]
]

/** The SQL with literals reduced to '' and comments gone — what dynamic checks read. */
function codeOnly(tokens: Token[]): string {
  // A literal is data here: its contents never look like code to the checks.
  return tokens
    .map((t) => (t.kind === 'dot' ? '.' : t.kind === 'literal' ? " '' " : ` ${t.text} `))
    .join('')
}

export function dynamicReasons(sqlOrTokens: string | Token[]): string[] {
  const code = codeOnly(typeof sqlOrTokens === 'string' ? tokenize(sqlOrTokens) : sqlOrTokens)
  return DYNAMIC.filter(([re]) => re.test(code)).map(([, why]) => why)
}

/** Statement-leading words: a batch that starts with anything else is a bare
 *  procedure call (`p_report @x = 1` runs p_report). */
const LEADING = new Set(
  'select with declare set insert update delete merge if begin end create alter drop exec execute use print return truncate while raiserror throw commit rollback save waitfor grant revoke deny open fetch close deallocate bulk dbcc kill checkpoint backup restore go'.split(
    ' '
  )
)

/** What the SQL executes: every EXEC / EXECUTE target (past an `@rc =`), plus
 *  a bare procedure call at the start of the batch. Last name part only. */
export function execTargets(tokens: Token[]): string[] {
  const out: string[] = []
  const nameAt = (k: number): string | null => {
    let last: string | null = null
    for (let j = k; j < tokens.length; j++) {
      const t = tokens[j]
      if (t.kind === 'ident') last = t.text
      else if (t.kind !== 'dot') break
      if (t.kind === 'ident' && tokens[j + 1]?.kind !== 'dot') break
    }
    return last
  }
  const first = tokens.find((t) => t.kind !== 'other' || t.text !== ';')
  if (first?.kind === 'ident' && !LEADING.has(first.text.toLowerCase())) {
    const name = nameAt(tokens.indexOf(first))
    if (name) out.push(name)
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.kind !== 'ident' || !/^exec(ute)?$/i.test(t.text)) continue
    let k = i + 1
    // EXEC @rc = proc
    const rc = tokens[k]
    const eq = tokens[k + 1]
    if (rc?.kind === 'other' && rc.text.startsWith('@') && eq?.kind === 'other' && eq.text === '=')
      k += 2
    const target = tokens[k]
    // EXEC @proc / EXEC @rc = @proc: the procedure is named at run time.
    if (target?.kind === 'other' && target.text.startsWith('@')) {
      out.push('@')
      continue
    }
    if (target?.kind !== 'ident') continue
    const name = nameAt(k)
    if (name) out.push(name)
  }
  return out
}

interface ObjectRow {
  name: string
  type: string
  definition: string | null
}

async function lookup(names: string[]): Promise<ObjectRow[]> {
  if (!names.length) return []
  // One OPENJSON parameter, not an N-parameter IN list (gotchas: plan per length).
  return (await db.raw(
    `SELECT o.name, RTRIM(o.type) AS type, m.definition
       FROM sys.objects o LEFT JOIN sys.sql_modules m ON m.object_id = o.object_id
      WHERE o.name IN (SELECT [value] FROM OPENJSON(?))`,
    [JSON.stringify(names)]
  )) as ObjectRow[]
}

interface DbContext {
  db: string
  schemas: Set<string>
  databases: Set<string>
}
let context: Promise<DbContext> | null = null
async function databaseContext(): Promise<DbContext> {
  if (!context) {
    context = (async () => {
      const [d, s, dbs] = await Promise.all([
        db.raw('SELECT DB_NAME() AS d') as Promise<Array<{ d: string }>>,
        db.raw('SELECT name FROM sys.schemas') as Promise<Array<{ name: string }>>,
        db.raw('SELECT name FROM sys.databases') as Promise<Array<{ name: string }>>
      ])
      return {
        db: String(d?.[0]?.d ?? '').toLowerCase(),
        schemas: new Set((s ?? []).map((r) => String(r.name).toLowerCase())),
        databases: new Set((dbs ?? []).map((r) => String(r.name).toLowerCase()))
      }
    })().catch((e) => {
      context = null
      throw e
    })
  }
  return context
}

/** Opaque reasons from dotted names: a linked server, or another database. */
function crossDatabase(names: string[][], ctx: DbContext): string[] {
  const out: string[] = []
  for (const parts of names) {
    const shown = parts.join('.')
    if (parts.length >= 4) out.push(`a linked-server name (${shown})`)
    else if (parts.length === 3) {
      const first = parts[0].toLowerCase()
      // Any other database on the server counts, even one named like a schema;
      // otherwise schema.table.column is not a database reference, and a first
      // part that is neither is not trusted either.
      if (first && first !== ctx.db && (ctx.databases.has(first) || !ctx.schemas.has(first)))
        out.push(`another database (${shown})`)
      else if (!first) out.push(`a name with no database (${shown})`)
    }
  }
  return out
}

export async function readSetOf(sql: string): Promise<ReadSet> {
  const tables = new Set<string>()
  const opaque = new Set<string>()
  const seen = new Set<string>()
  const ctx = await databaseContext()
  const execs = new Set<string>()
  const resolved = new Set<string>()
  let modules = 0

  let level: string[] = [sql]
  for (let depth = 0; level.length; depth++) {
    const wanted = new Set<string>()
    for (const text of level) {
      const tokens = tokenize(text)
      for (const why of dynamicReasons(tokens)) opaque.add(why)
      for (const why of crossDatabase(dottedNames(tokens), ctx)) opaque.add(why)
      for (const name of execTargets(tokens)) execs.add(name.toLowerCase())
      // Names inside string literals count too: a string can reach a table
      // through any procedure that runs it, and over-counting only tightens.
      const names = tokens.flatMap((t) =>
        t.kind === 'ident'
          ? [t.text]
          : t.kind === 'literal'
            ? tokenize(t.text).flatMap((x) => (x.kind === 'ident' ? [x.text] : []))
            : []
      )
      for (const name of names) {
        if (!name) continue
        const key = name.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        wanted.add(name)
      }
    }
    if (!wanted.size) break
    if (depth >= MAX_DEPTH) {
      opaque.add('objects nested too deep to follow')
      break
    }
    if (seen.size > MAX_NAMES) {
      opaque.add('too many names to follow')
      break
    }
    const rows = await lookup([...wanted])
    const next: string[] = []
    for (const r of rows) {
      const name = r.name.toLowerCase()
      resolved.add(name)
      if (r.type === 'U') tables.add(name)
      else if (MODULES.has(r.type)) {
        if (r.definition == null) opaque.add(`an encrypted or unreadable module (${r.name})`)
        else if (++modules > MAX_MODULES) opaque.add('too many modules to follow')
        else next.push(r.definition)
      } else if (r.type === 'SN') opaque.add(`a synonym (${r.name})`)
      else if (!NO_ROWS.has(r.type))
        opaque.add(`an object that cannot be followed (${r.name}, ${r.type})`)
    }
    level = next
  }
  // Something is executed that is not an object in this database: a system or
  // extended procedure (sp_prepexec, xp_…), another database's procedure — it
  // can run any SQL, so what it reads cannot be known.
  for (const name of execs) {
    if (name === '@') opaque.add('a procedure named by a variable')
    else if (!resolved.has(name)) opaque.add(`a procedure that cannot be followed (${name})`)
  }
  return { tables: [...tables].filter((t) => !SKIP.test(t)), opaque: [...opaque] }
}
