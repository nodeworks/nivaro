// SQLite support (DB_CLIENT=sqlite): demos, "try it in 30 seconds", local development, small
// single-process installs and fast tests. Not for several processes or replicas.
//
// knex drives it through better-sqlite3 (knex client 'better-sqlite3'; knex's own alias 'sqlite'
// means the other driver, node-sqlite3). DB_DATABASE is the database file's path.
//
// What this module settles once, for every SQLite pool the process opens:
//
//  1. Time. SQLite has no date type: a timestamp is TEXT. Nivaro stores every timestamp as UTC
//     ISO-8601 with milliseconds and a Z — 'YYYY-MM-DDTHH:MM:SS.SSSZ', exactly what JS
//     `Date#toISOString()` writes and what `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` gives — so
//     values sort and compare as text, an ISO string the app binds is already in the stored shape,
//     and SQLite's date functions read it. A date-only value is 'YYYY-MM-DD'.
//      - A JS Date bound as a parameter is written in that shape (knex's better-sqlite3 client
//        would send epoch milliseconds). A Date at exactly UTC midnight is written 'YYYY-MM-DD':
//        it is what a date column holds, and against stored timestamps it sorts exactly where
//        midnight belongs (before every time of that day).
//      - Column defaults of CURRENT_TIMESTAMP (knex.fn.now(), utcNow()) are created as that same
//        expression, not SQLite's 'YYYY-MM-DD HH:MM:SS'.
//      - Reading: a column declared date / datetime / timestamp comes back as a JS Date (UTC), like
//        SQL Server (tedious useUTC), Postgres (db/pg-utc.ts) and MySQL (timezone 'Z'); a date
//        column as UTC midnight. An expression column (MAX(created_at), a CASE) whose value is
//        exactly the stored timestamp shape comes back as a Date too.
//  2. Booleans are stored 0 / 1; a column declared boolean reads back as true / false, like SQL
//     Server's bit, Postgres and MySQL (db/mysql-session.ts mysqlTypeCast). A whole JS number
//     is bound as an INTEGER (better-sqlite3 binds numbers as REAL, so 12 written to a text
//     column would read '12.0').
//  3. One writer. SQLite allows one write transaction at a time, and better-sqlite3 is synchronous:
//     a connection that waits for the write lock blocks the whole event loop, so the transaction
//     holding it (waiting on that same loop) can never finish. The pool keeps several connections
//     (WAL: reads never wait), and every write first takes an in-process write lock that waits
//     asynchronously: a transaction (BEGIN IMMEDIATE) holds it until COMMIT / ROLLBACK, a
//     statement on its own holds it while it runs. busy_timeout covers other processes (the
//     sqlite3 shell, a backup) only.
//  4. Pragmas on every connection: foreign_keys=ON, journal_mode=WAL, busy_timeout=5000,
//     synchronous=NORMAL.
//  6. INFORMATION_SCHEMA. SQLite has none; the app reads INFORMATION_SCHEMA.TABLES / COLUMNS /
//     VIEWS / TABLE_CONSTRAINTS / KEY_COLUMN_USAGE in ~70 files (its portable path for Postgres
//     and MySQL). A statement naming one gets it replaced by a subquery over sqlite_master and the
//     table pragmas with the standard column names (rewriteInformationSchema), and DATABASE() /
//     SCHEMA_NAME() answer 'main'. Only SQL that SQLite would refuse is touched.
//  5. Schema changes knex does by rebuilding the table (alter, drop column) need foreign_keys off,
//     which SQLite ignores inside a transaction, so migrations run without knex's per-migration
//     transaction on SQLite (MySQL never had it either: its DDL commits by itself). An added
//     column whose default is not a constant (CURRENT_TIMESTAMP) — which SQLite's ADD COLUMN
//     refuses — is added by rebuilding the table the same way.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** The knex client name for SQLite (knex's alias 'sqlite' would load node-sqlite3 instead). */
export const SQLITE_KNEX_CLIENT = 'better-sqlite3'

/** True for a knex client name that is SQLite. */
export function isSqliteClient(name: unknown): boolean {
  const c = String(name ?? '')
  return c === 'sqlite' || c === 'sqlite3' || c === 'better-sqlite3'
}

/** The SQL for "now" in the stored timestamp shape. */
export const SQLITE_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

/**
 * Why this process may not use SQLite, or null. SQLite is one file owned by one process: cloud
 * mode (a pool per tenant, many replicas) and the web / worker / realtime / importer split
 * (NIVARO_ROLE) need a server database.
 */
export function sqliteDeploymentProblem(env: Record<string, string | undefined>): string | null {
  if (env.DB_CLIENT !== 'sqlite') return null
  if (env.CLOUD_META_DB_URL)
    return 'DB_CLIENT=sqlite cannot run in cloud mode (CLOUD_META_DB_URL is set): tenants need a server database (SQL Server, Postgres or MySQL).'
  const role = (env.NIVARO_ROLE ?? '').trim()
  if (role)
    return `DB_CLIENT=sqlite runs as ONE process; NIVARO_ROLE=${role} splits the app over several processes, which needs a server database (SQL Server, Postgres or MySQL). Unset NIVARO_ROLE or use a server database.`
  if (env.DB_READ_HOST) return 'DB_CLIENT=sqlite has no read replica: unset DB_READ_HOST.'
  return null
}

// ─── time ───────────────────────────────────────────────────────────────────

/** A JS Date as SQLite stores it: 'YYYY-MM-DDTHH:MM:SS.SSSZ', or 'YYYY-MM-DD' at UTC midnight. */
export function toSqliteTime(d: Date): string | null {
  const ms = d.getTime()
  if (Number.isNaN(ms)) return null
  const iso = d.toISOString()
  return ms % 86_400_000 === 0 ? iso.slice(0, 10) : iso
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$/
const STORED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** A stored date / timestamp value (text, or legacy epoch milliseconds) as a JS Date; else as is. */
export function fromSqliteTime(v: unknown): unknown {
  if (typeof v === 'number') return Number.isFinite(v) ? new Date(v) : v
  if (typeof v !== 'string') return v
  if (DATE_ONLY.test(v)) return new Date(`${v}T00:00:00Z`)
  const m = DATE_TIME.exec(v)
  if (!m) return v
  const d = new Date(`${m[1]}T${m[2]}${m[3] ?? 'Z'}`)
  return Number.isNaN(d.getTime()) ? v : d
}

/** Declared column types read back as dates. */
export function isDateType(declared: string | null | undefined): boolean {
  const t = String(declared ?? '').toLowerCase()
  return t === 'date' || /datetime|timestamp/.test(t)
}

/** Declared column types read back as true / false (knex's `table.boolean()` declares `boolean`). */
export function isBooleanType(declared: string | null | undefined): boolean {
  const t = String(declared ?? '').toLowerCase()
  return t === 'boolean' || t === 'bool'
}

interface ColumnInfo {
  name: string
  type: string | null
}

/** Rows as they come from better-sqlite3 → dates and booleans converted per the statement's column list. */
export function convertRows(columns: ColumnInfo[], rows: unknown[]): unknown[] {
  const dated: string[] = []
  const bools: string[] = []
  const exprs: string[] = []
  for (const c of columns) {
    if (isDateType(c.type)) dated.push(c.name)
    else if (isBooleanType(c.type)) bools.push(c.name)
    else if (c.type == null) exprs.push(c.name)
  }
  if (!dated.length && !bools.length && !exprs.length) return rows
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const r = row as Record<string, unknown>
    for (const k of dated) if (r[k] != null) r[k] = fromSqliteTime(r[k])
    for (const k of bools) {
      const v = r[k]
      // A boolean column holding text ('yes') is left as it is; 0 / 1 (number or bigint) flip.
      if (typeof v === 'number' || typeof v === 'bigint') r[k] = Number(v) !== 0
    }
    for (const k of exprs) {
      const v = r[k]
      if (typeof v === 'string' && STORED.test(v)) r[k] = new Date(v)
    }
  }
  return rows
}

// ─── INFORMATION_SCHEMA ─────────────────────────────────────────────────────

const USER_TABLES = "m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"
const BASE_TABLES = "m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"
const typeBase =
  "lower(trim(CASE WHEN instr(p.type, '(') > 0 THEN substr(p.type, 1, instr(p.type, '(') - 1) ELSE p.type END))"

/** The INFORMATION_SCHEMA views as SQLite subqueries (standard column names). */
export const SQLITE_INFORMATION_SCHEMA: Record<string, string> = {
  TABLES: `SELECT 'main' AS TABLE_CATALOG, 'main' AS TABLE_SCHEMA, m.name AS TABLE_NAME, CASE m.type WHEN 'view' THEN 'VIEW' ELSE 'BASE TABLE' END AS TABLE_TYPE FROM sqlite_master m WHERE ${USER_TABLES}`,
  VIEWS: `SELECT 'main' AS TABLE_CATALOG, 'main' AS TABLE_SCHEMA, m.name AS TABLE_NAME, m.sql AS VIEW_DEFINITION FROM sqlite_master m WHERE m.type = 'view'`,
  COLUMNS: `SELECT 'main' AS TABLE_CATALOG, 'main' AS TABLE_SCHEMA, m.name AS TABLE_NAME, p.name AS COLUMN_NAME, p.cid + 1 AS ORDINAL_POSITION, p.dflt_value AS COLUMN_DEFAULT, CASE WHEN p."notnull" = 1 OR p.pk > 0 THEN 'NO' ELSE 'YES' END AS IS_NULLABLE, ${typeBase} AS DATA_TYPE, CASE WHEN instr(p.type, '(') > 0 AND ${typeBase} LIKE '%char%' THEN CAST(substr(p.type, instr(p.type, '(') + 1) AS INTEGER) END AS CHARACTER_MAXIMUM_LENGTH, CASE WHEN instr(p.type, '(') > 0 AND ${typeBase} IN ('decimal', 'numeric') THEN CAST(substr(p.type, instr(p.type, '(') + 1) AS INTEGER) END AS NUMERIC_PRECISION, CASE WHEN instr(p.type, ',') > 0 AND ${typeBase} IN ('decimal', 'numeric') THEN CAST(substr(p.type, instr(p.type, ',') + 1) AS INTEGER) END AS NUMERIC_SCALE, NULL AS DATETIME_PRECISION, NULL AS COLLATION_NAME, lower(p.type) AS COLUMN_TYPE, CASE WHEN p.pk > 0 THEN 'PRI' ELSE '' END AS COLUMN_KEY, CASE WHEN p.pk = 1 AND lower(p.type) = 'integer' AND lower(m.sql) LIKE '%autoincrement%' THEN 'auto_increment' ELSE '' END AS EXTRA, CASE WHEN p.pk = 1 AND lower(p.type) = 'integer' AND lower(m.sql) LIKE '%autoincrement%' THEN 'YES' ELSE 'NO' END AS IS_IDENTITY FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE ${USER_TABLES}`,
  TABLE_CONSTRAINTS: `SELECT 'main' AS CONSTRAINT_CATALOG, 'main' AS CONSTRAINT_SCHEMA, 'pk_' || m.name AS CONSTRAINT_NAME, 'main' AS TABLE_SCHEMA, m.name AS TABLE_NAME, 'PRIMARY KEY' AS CONSTRAINT_TYPE FROM sqlite_master m WHERE ${BASE_TABLES} AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) p WHERE p.pk > 0) UNION ALL SELECT DISTINCT 'main', 'main', 'fk_' || m.name || '_' || f.id, 'main', m.name, 'FOREIGN KEY' FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE ${BASE_TABLES} UNION ALL SELECT 'main', 'main', il.name, 'main', m.name, 'UNIQUE' FROM sqlite_master m JOIN pragma_index_list(m.name) il WHERE ${BASE_TABLES} AND il."unique" = 1 AND il.origin <> 'pk' AND il.partial = 0`,
  KEY_COLUMN_USAGE: `SELECT 'main' AS CONSTRAINT_CATALOG, 'main' AS CONSTRAINT_SCHEMA, 'pk_' || m.name AS CONSTRAINT_NAME, 'main' AS TABLE_SCHEMA, m.name AS TABLE_NAME, p.name AS COLUMN_NAME, p.pk AS ORDINAL_POSITION, NULL AS REFERENCED_TABLE_NAME, NULL AS REFERENCED_COLUMN_NAME FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE ${BASE_TABLES} AND p.pk > 0 UNION ALL SELECT 'main', 'main', 'fk_' || m.name || '_' || f.id, 'main', m.name, f."from", f.seq + 1, f."table", f."to" FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE ${BASE_TABLES} UNION ALL SELECT 'main', 'main', il.name, 'main', m.name, ii.name, ii.seqno + 1, NULL, NULL FROM sqlite_master m JOIN pragma_index_list(m.name) il JOIN pragma_index_info(il.name) ii WHERE ${BASE_TABLES} AND il."unique" = 1 AND il.origin <> 'pk' AND il.partial = 0`
}

const INFO_SCHEMA =
  /\binformation_schema\s*\.\s*(tables|views|columns|table_constraints|key_column_usage)\b/gi

/** SQL with every INFORMATION_SCHEMA view it names replaced by its SQLite subquery. */
export function rewriteInformationSchema(sql: string): string {
  if (!/information_schema/i.test(sql)) return sql
  return sql.replace(
    INFO_SCHEMA,
    (_m, view: string) => `(${SQLITE_INFORMATION_SCHEMA[view.toUpperCase()]})`
  )
}

// ─── the write lock ──────────────────────────────────────────────────────────

/** How long a write waits for the write lock before it fails. */
export const SQLITE_WRITE_WAIT_MS = 60_000

/**
 * The in-process write lock (point 3 above). `holder` is the connection whose write or open
 * transaction holds it.
 */
export class SqliteWriteLock {
  holder: unknown = null
  private waiters: Array<{ conn: unknown; resolve: () => void }> = []

  async acquire(conn: unknown, timeoutMs = SQLITE_WRITE_WAIT_MS): Promise<void> {
    if (this.holder === conn) return
    if (this.holder == null) {
      this.holder = conn
      return
    }
    await new Promise<void>((resolve, reject) => {
      const w = {
        conn,
        resolve: () => {
          clearTimeout(t)
          resolve()
        }
      }
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w)
        const err = new Error(
          `SQLite: a write waited ${Math.round(timeoutMs / 1000)} s for the database's write lock, which an open transaction still holds (SQLite allows one writer at a time). A write made outside a transaction while that transaction is open waits for it forever.`
        ) as Error & { code?: string }
        err.code = 'SQLITE_WRITE_LOCK_TIMEOUT'
        reject(err)
      }, timeoutMs)
      t.unref?.()
      this.waiters.push(w)
    })
  }

  /** Hand the lock to the next waiter (or free it). */
  release(conn: unknown): void {
    if (this.holder !== conn) return
    const next = this.waiters.shift()
    this.holder = next ? next.conn : null
    next?.resolve()
  }
}

export const sqliteWriteLock = new SqliteWriteLock()

const BEGIN = /^\s*BEGIN\b(?!\s+(IMMEDIATE|EXCLUSIVE)\b)/i

// ─── connection + knex patches ───────────────────────────────────────────────

const regexps = new Map<string, RegExp>()

/** `value REGEXP pattern` (SQLite calls regexp(pattern, value)); JS regular expressions. */
export function sqliteRegexp(pattern: unknown, value: unknown): number | null {
  if (pattern == null || value == null) return null
  const p = String(pattern)
  let re = regexps.get(p)
  if (!re) {
    re = new RegExp(p)
    if (regexps.size > 500) regexps.clear()
    regexps.set(p, re)
  }
  return re.test(String(value)) ? 1 : 0
}

interface SqliteConnection {
  pragma: (s: string) => unknown
  function: (
    name: string,
    opts: { deterministic: boolean },
    fn: (...a: unknown[]) => unknown
  ) => unknown
}

/**
 * Pool `afterCreate` for SQLite: the pragmas every connection runs with, and the REGEXP operator
 * (SQLite has the syntax but no function behind it; sql-dialect.ts's try-casts use it).
 */
export function sqliteAfterCreate(
  conn: SqliteConnection,
  done: (err: Error | null, c: unknown) => void
): void {
  try {
    conn.pragma('journal_mode = WAL')
    conn.pragma('foreign_keys = ON')
    conn.pragma('busy_timeout = 5000')
    conn.pragma('synchronous = NORMAL')
    conn.function('regexp', { deterministic: true }, sqliteRegexp)
    // The schema name INFORMATION_SCHEMA queries compare TABLE_SCHEMA with (point 6).
    conn.function('database', { deterministic: true }, () => 'main')
    conn.function('schema_name', { deterministic: true }, () => 'main')
    done(null, conn)
  } catch (err) {
    done(err as Error, conn)
  }
}

/** Connections in a SQLite pool: several readers (WAL); writes take the write lock. */
export function sqlitePoolMax(poolMax: number): number {
  return Math.max(2, Math.min(8, poolMax))
}

let patched = false

/**
 * Patch knex's better-sqlite3 client and SQLite compilers (points 1, 3 and 5 above).
 * Process-wide and idempotent; it only touches knex's SQLite code, never another dialect.
 */
export function sqliteCompat(): void {
  if (patched) return
  patched = true
  let Client: any
  try {
    Client = require('knex/lib/dialects/better-sqlite3/index.js')
  } catch {
    return
  }
  const proto = Client.prototype

  proto._formatBindings = (bindings: unknown[] | undefined) => {
    if (!bindings) return []
    return bindings.map((b) => {
      if (b instanceof Date) return toSqliteTime(b)
      if (typeof b === 'boolean') return Number(b)
      // better-sqlite3 binds every JS number as REAL: 12 would reach a text column as '12.0'.
      if (typeof b === 'number' && Number.isSafeInteger(b)) return BigInt(b)
      return b
    })
  }

  proto._query = async function (connection: any, obj: any) {
    if (!obj.sql) throw new Error('The query is empty')
    if (!connection) throw new Error('No connection provided')
    obj.sql = rewriteInformationSchema(obj.sql)
    const begin = BEGIN.test(obj.sql)
    if (begin) obj.sql = 'BEGIN IMMEDIATE'
    const statement = connection.prepare(obj.sql)
    const safeIntegers = this._optSafeIntegers(obj.options)
    if (safeIntegers !== undefined) statement.safeIntegers(safeIntegers)
    const bindings = this._formatBindings(obj.bindings)
    if ((begin || !statement.readonly) && sqliteWriteLock.holder !== connection)
      await sqliteWriteLock.acquire(connection)
    try {
      if (statement.reader) {
        obj.response = convertRows(statement.columns(), statement.all(bindings))
        return obj
      }
      const response = statement.run(bindings)
      obj.response = response
      obj.context = { lastID: response.lastInsertRowid, changes: response.changes }
      return obj
    } finally {
      if (sqliteWriteLock.holder === connection && !connection.inTransaction)
        sqliteWriteLock.release(connection)
    }
  }

  const destroy = proto.destroyRawConnection
  proto.destroyRawConnection = async function (connection: unknown) {
    sqliteWriteLock.release(connection)
    return destroy.call(this, connection)
  }

  // Timestamp defaults in the stored shape (point 1).
  const ColumnCompiler = require('knex/lib/dialects/sqlite3/schema/sqlite-columncompiler.js')
  const defaultTo = ColumnCompiler.prototype.defaultTo
  ColumnCompiler.prototype.defaultTo = function (...args: unknown[]) {
    const sql = defaultTo.apply(this, args) as string
    return /^default\s+CURRENT_TIMESTAMP$/i.test(sql) ? `default (${SQLITE_NOW})` : sql
  }
  const DDL = require('knex/lib/dialects/sqlite3/schema/ddl.js')
  const alterColumn = DDL.prototype.alterColumn
  DDL.prototype.alterColumn = function (columns: Array<{ defaultTo: unknown }>) {
    for (const c of columns)
      if (typeof c.defaultTo === 'string' && /^CURRENT_TIMESTAMP$/i.test(c.defaultTo))
        c.defaultTo = `(${SQLITE_NOW})`
    return alterColumn.call(this, columns)
  }

  // ADD COLUMN with a non-constant default → rebuild the table with the column (point 5).
  const { parseCreateTable } = require('knex/lib/dialects/sqlite3/schema/internal/parser.js')
  const { compileCreateTable } = require('knex/lib/dialects/sqlite3/schema/internal/compiler.js')
  DDL.prototype.addColumnRebuilding = async function (columnSql: string) {
    const { createTable, createIndices } = await this.getTableSql()
    const parsed = parseCreateTable(createTable)
    parsed.table = this.alteredName
    const extra = parseCreateTable(`CREATE TABLE x (${columnSql})`)
    const cols = parsed.columns
      .map((c: { name: string }) => `"${String(c.name).replace(/"/g, '""')}"`)
      .join(', ')
    parsed.columns.push(...extra.columns)
    const table = `"${this.tableName()}"`
    const temp = `"${this.alteredName}"`
    const sql = [
      compileCreateTable(parsed, this.wrap),
      `INSERT INTO ${temp} (${cols}) SELECT ${cols} FROM ${table}`,
      `DROP TABLE ${table}`,
      `ALTER TABLE ${temp} RENAME TO ${table}`,
      ...createIndices
    ]
    const fk = await this.isForeignCheckEnabled()
    return {
      pre: fk ? ['PRAGMA foreign_keys = OFF'] : [],
      sql,
      check: fk ? 'PRAGMA foreign_key_check' : null,
      post: fk ? ['PRAGMA foreign_keys = ON'] : []
    }
  }
  const TableCompiler = require('knex/lib/dialects/sqlite3/schema/sqlite-tablecompiler.js')
  const addColumns = TableCompiler.prototype.addColumns
  TableCompiler.prototype.addColumns = function (
    columns: any,
    prefix: unknown,
    ...rest: unknown[]
  ) {
    if (prefix === this.alterColumnsPrefix) return addColumns.call(this, columns, prefix, ...rest)
    const plain = { sql: [] as string[], bindings: [] as unknown[] }
    for (let i = 0; i < columns.sql.length; i++) {
      const sql = columns.sql[i] as string
      if (/\bdefault\s+\(/i.test(sql) || /\bdefault\s+CURRENT_(TIMESTAMP|DATE|TIME)\b/i.test(sql)) {
        const compiler = this
        this.pushQuery({
          sql: `PRAGMA table_info(${this.tableName()})`,
          statementsProducer(pragma: unknown, connection: unknown) {
            return compiler.client.ddl(compiler, pragma, connection).addColumnRebuilding(sql)
          }
        })
      } else {
        plain.sql.push(sql)
        plain.bindings.push(columns.bindings[i])
      }
    }
    if (plain.sql.length) return addColumns.call(this, plain, prefix, ...rest)
  }
}
