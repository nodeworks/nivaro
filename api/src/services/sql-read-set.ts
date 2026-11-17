import { db } from '../db/index.js'

/**
 * What a piece of raw SQL reads (pentest M-4, 2026-11-16).
 *
 * The User-Scope backstop on custom queries (services/custom-query-scope.ts)
 * refuses a restricted person unless the query's scope_params cover every
 * dimension that reaches a table the SQL reads. It used to look only at the
 * names written in the SQL plus one level into EXEC'd procedures, so a query
 * that read scoped rows THROUGH A VIEW (`SELECT * FROM v_workflow_state`) or a
 * table-valued function looked like it read nothing scoped and ran unscoped —
 * every zone's rows for a zone-restricted person.
 *
 * Now every name is resolved against sys.objects and followed into views,
 * table-valued and scalar functions and procedures, several levels deep. What
 * cannot be followed is reported as `opaque` — dynamic SQL, OPENQUERY-style
 * remote reads, another database or a linked server, a synonym, an encrypted
 * module, too many levels or objects — and the gate treats an opaque query as
 * reaching EVERY dimension: refused for a restricted person unless it declares
 * scope_params (or `$not_scoped`). "Can't tell" is answered "no", never "all
 * rows".
 *
 * Names that are not objects in this database at all (STRING_SPLIT, OPENJSON,
 * CTE names, table variables, prose in a comment) are ignored: they hold no
 * stored rows of their own.
 */

export interface ReadSet {
  /** Base tables read, lower-cased, minus system / staging / scratch ones. */
  tables: string[]
  /** Why part of the read set could not be worked out; empty = fully known. */
  opaque: string[]
}

const MAX_DEPTH = 5
const MAX_OBJECTS = 80
const SKIP = /^(nivaro_|sys|information_schema|staging_|zz_|temp_|#)/i
const PART = String.raw`(?:\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)`
const NAME = String.raw`(${PART}(?:\s*\.\s*${PART}){0,3})`
const READ_REF = new RegExp(String.raw`\b(?:from|join|into|update|apply)\s+${NAME}`, 'gi')
const EXEC_REF = new RegExp(String.raw`\bexec(?:ute)?\s+(?:@\w+\s*=\s*)?${NAME}`, 'gi')
const DYNAMIC: Array<[RegExp, string]> = [
  [/\bexec(?:ute)?\s*\(/i, 'dynamic SQL (EXEC of a string)'],
  [/\bsp_executesql\b/i, 'dynamic SQL (sp_executesql)'],
  [/\bexec(?:ute)?\s+@\w+(?!\s*=)/i, 'a procedure named by a variable'],
  [/\bopen(?:query|rowset|datasource)\s*\(/i, 'a remote read (OPENQUERY / OPENROWSET)']
]

/** Comments out, so prose in them is neither a name nor a dynamic-SQL hit. */
export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

const unbracket = (p: string) => p.trim().replace(/^\[|\]$/g, '')

export interface NameRef {
  name: string
  /** Database part of a three-part name, when written. */
  database?: string
  /** True for a four-part (linked server) name. */
  linked?: boolean
}

/** Every object name the SQL reads or executes, as written. */
export function namesIn(sql: string): NameRef[] {
  const out: NameRef[] = []
  for (const re of [READ_REF, EXEC_REF]) {
    for (const m of sql.matchAll(re)) {
      const parts = m[1].split('.').map(unbracket)
      if (parts.some((p) => p.startsWith('@') || p.startsWith('#'))) continue
      const name = parts[parts.length - 1]
      if (parts.length >= 4) out.push({ name, linked: true })
      else if (parts.length === 3) out.push({ name, database: parts[0] })
      else out.push({ name })
    }
  }
  return out
}

export function dynamicReasons(sql: string): string[] {
  return DYNAMIC.filter(([re]) => re.test(sql)).map(([, why]) => why)
}

interface ObjectRow {
  name: string
  type: string
  definition: string | null
}

async function lookup(names: string[]): Promise<ObjectRow[]> {
  if (!names.length) return []
  return (await db.raw(
    `SELECT o.name, RTRIM(o.type) AS type, m.definition
       FROM sys.objects o LEFT JOIN sys.sql_modules m ON m.object_id = o.object_id
      WHERE o.name IN (${names.map(() => '?').join(', ')})`,
    names
  )) as ObjectRow[]
}

let currentDb: Promise<string> | null = null
async function databaseName(): Promise<string> {
  if (!currentDb) {
    currentDb = (db.raw('SELECT DB_NAME() AS d') as Promise<Array<{ d: string }>>)
      .then((r) => String(r?.[0]?.d ?? '').toLowerCase())
      .catch((e) => {
        currentDb = null
        throw e
      })
  }
  return currentDb
}

const MODULE_TYPES = new Set(['V', 'IF', 'TF', 'FN', 'P', 'TR'])

export async function readSetOf(sql: string): Promise<ReadSet> {
  const tables = new Set<string>()
  const opaque = new Set<string>()
  const seen = new Set<string>()
  const dbName = await databaseName()

  let level: Array<{ sql: string }> = [{ sql }]
  for (let depth = 0; level.length; depth++) {
    const wanted = new Set<string>()
    for (const { sql: text } of level) {
      const clean = stripSqlComments(text)
      for (const why of dynamicReasons(clean)) opaque.add(why)
      for (const ref of namesIn(clean)) {
        if (ref.linked) {
          opaque.add(`a linked-server name (${ref.name})`)
          continue
        }
        if (ref.database && ref.database.toLowerCase() !== dbName) {
          opaque.add(`another database (${ref.database}.${ref.name})`)
          continue
        }
        const key = ref.name.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        wanted.add(ref.name)
      }
    }
    if (!wanted.size) break
    if (depth >= MAX_DEPTH) {
      opaque.add('objects nested too deep to follow')
      break
    }
    if (seen.size > MAX_OBJECTS) {
      opaque.add('too many objects to follow')
      break
    }
    const rows = await lookup([...wanted])
    const next: Array<{ sql: string }> = []
    for (const r of rows) {
      const name = r.name.toLowerCase()
      if (r.type === 'U') {
        tables.add(name)
      } else if (r.type === 'SN') {
        opaque.add(`a synonym (${r.name})`)
      } else if (MODULE_TYPES.has(r.type)) {
        if (r.definition == null) opaque.add(`an encrypted or unreadable module (${r.name})`)
        else next.push({ sql: r.definition })
      }
      // Anything else (constraints, keys, CLR objects) holds no rows to read.
    }
    level = next
  }
  return { tables: [...tables].filter((t) => !SKIP.test(t)), opaque: [...opaque] }
}
