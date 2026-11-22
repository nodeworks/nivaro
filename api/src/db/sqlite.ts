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
//     A write made with `db` (not the transaction's `trx`) from INSIDE a transaction's callback
//     would wait for that same transaction's lock forever. Code everywhere does that (an
//     activity row, a revision, a notification written with `db` mid-transaction), so the write
//     runs on the transaction's own connection instead: it commits or rolls back with the
//     transaction. (SQL Server runs it on another connection, committed at once.)
//     All of this holds inside one process only, so a second process is refused: a cloud tenant,
//     NIVARO_ROLE (several processes by design) and a read replica at load
//     (sqliteDeploymentProblem), and a second process opening the same file — another API, a
//     `pnpm migrate` while the API runs — by the `<file>.lock` the first one holds
//     (claimSqliteFile).
//  4. Pragmas on every connection: foreign_keys=ON, journal_mode=WAL, busy_timeout=5000,
//     synchronous=NORMAL.
//  6. INFORMATION_SCHEMA. SQLite has none; the app reads INFORMATION_SCHEMA.TABLES / COLUMNS /
//     VIEWS / TABLE_CONSTRAINTS / KEY_COLUMN_USAGE in ~70 files (its portable path for Postgres
//     and MySQL). A statement naming one gets it replaced by a subquery over sqlite_master and the
//     table pragmas with the standard column names (rewriteInformationSchema), and DATABASE() /
//     SCHEMA_NAME() answer 'main'. Only SQL that SQLite would refuse is touched.
//  7. LIKE. SQLite's own LIKE has no escape character unless the statement names one, and folds
//     ASCII letters only. Postgres and MySQL escape with a backslash by default, and the app
//     writes its portable patterns that way (`'nivaro\_%'`, escapeLikeFor), so `like()` is
//     replaced on every connection: backslash is the default escape, an ESCAPE clause still
//     names its own, and the match is case-insensitive for every letter (SQL Server's default
//     collation is case-insensitive). STDDEV_SAMP (aggregate), CURRENT_SCHEMA() and the plain
//     text functions every other database has (LEFT, RIGHT, CHAR_LENGTH, LPAD, LOCATE; MD5 below) are
//     added for the spellings the shared SQL uses; each answers what SQL Server / Postgres /
//     MySQL answer (characters, not bytes; NULL in → NULL out).
//  5. Schema changes knex does by rebuilding the table (alter, drop column) need foreign_keys off,
//     which SQLite ignores inside a transaction, so migrations run without knex's per-migration
//     transaction on SQLite (MySQL never had it either: its DDL commits by itself). An added
//     column whose default is not a constant (CURRENT_TIMESTAMP) — which SQLite's ADD COLUMN
//     refuses — is added by rebuilding the table the same way.
//  8. Text compares like SQL Server's default (case-insensitive) collation: every text column
//     (varchar, char, text, uuid's char(36)) is declared COLLATE NOCASE, so `=`, IN, ORDER BY,
//     GROUP BY, DISTINCT, MIN/MAX and unique indexes ignore ASCII case as SQL Server does —
//     'Abc' = 'abc', 'ABC' cannot sit beside 'abc' under a unique index, and sorting is
//     a, B, c rather than B, a, c. New columns get it from knex's column compiler; a database
//     created before that is brought in line once after migrations (db/sqlite-collation.ts).
//     NOCASE folds ASCII letters only: 'é' = 'É' holds on SQL Server, not here (LIKE, point 7,
//     folds every letter).
//  9. Text length. SQLite stores any length in a varchar(10); SQL Server refuses the write
//     ("String or binary data would be truncated", answered 422 VALUE_TOO_LONG). Every sized
//     text column carries `CHECK (length(col) <= n)` (the column compiler; older databases get it
//     with point 8's pass), so a too-long value is refused on every write path, not only the
//     items service (which checks lengths itself first). Types and conversions of record
//     values: db/sqlite-values.ts.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { hostname } from 'node:os'
import { isMultiTenant } from '../services/deployment-mode.js'

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
  if (isMultiTenant(env))
    return 'DB_CLIENT=sqlite cannot run in cloud mode (CLOUD_META_DB_URL is set): tenants need a server database (SQL Server, Postgres or MySQL).'
  const role = (env.NIVARO_ROLE ?? '').trim()
  if (role)
    return `DB_CLIENT=sqlite runs as ONE process; NIVARO_ROLE=${role} splits the app over several processes, which needs a server database (SQL Server, Postgres or MySQL). Unset NIVARO_ROLE or use a server database.`
  if (env.DB_READ_HOST) return 'DB_CLIENT=sqlite has no read replica: unset DB_READ_HOST.'
  return null
}

/** How long an owner's lock file may go untouched before another process may take it. */
export const SQLITE_LOCK_STALE_MS = 90_000

export interface SqliteLockOwner {
  pid: number
  host: string
  started: string
}

/**
 * One process per database file (point 3: the write lock is in-process, and two processes
 * writing one file would stall each other's event loop on SQLite's file lock). The first
 * process to open the file writes `<file>.lock` (pid, host) and touches it every 30 s; a
 * second process — a second API, `pnpm migrate` against a running API, a worker started by
 * hand — is refused while that lock is live. A lock is stale, and taken over, when it names
 * this very process id (a restarted container), a process on this host that no longer runs, or
 * has not been touched for SQLITE_LOCK_STALE_MS (an owner on another host that died).
 * Returns why this process may not open the file, else null (and the lock is ours).
 */
export function claimSqliteFile(
  file: string,
  now = Date.now(),
  self: SqliteLockOwner = {
    pid: process.pid,
    host: hostname(),
    started: new Date(now).toISOString()
  },
  alive: (pid: number) => boolean = processAlive
): string | null {
  if (!file || file === ':memory:' || /^file::memory:/i.test(file)) return null
  const lock = `${file}.lock`
  const body = JSON.stringify(self)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, body, { flag: 'wx' })
      return null
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    let owner: Partial<SqliteLockOwner> = {}
    let touched = 0
    try {
      owner = JSON.parse(readFileSync(lock, 'utf8')) as Partial<SqliteLockOwner>
      touched = statSync(lock).mtimeMs
    } catch {
      // unreadable or gone: treated as stale
    }
    const sameHost = owner.host === self.host
    const live =
      now - touched < SQLITE_LOCK_STALE_MS &&
      !(sameHost && owner.pid === self.pid) &&
      !(sameHost && typeof owner.pid === 'number' && !alive(owner.pid))
    if (live)
      return `DB_CLIENT=sqlite runs as ONE process, and ${file} is already open in another one (pid ${owner.pid} on ${owner.host}, since ${owner.started}). Stop that process first, or use a server database (SQL Server, Postgres or MySQL) for several processes. If no such process runs, delete ${lock}.`
    try {
      unlinkSync(lock)
    } catch {}
  }
  return `DB_CLIENT=sqlite: could not take ${lock}; another process is starting on the same database.`
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Keep this process's lock file fresh, and remove it when the process ends. */
export function holdSqliteFile(file: string): void {
  if (!file || file === ':memory:' || /^file::memory:/i.test(file)) return
  const lock = `${file}.lock`
  const mine = readFileSync(lock, 'utf8')
  const timer = setInterval(() => {
    try {
      const t = new Date()
      utimesSync(lock, t, t)
    } catch {}
  }, 30_000)
  timer.unref?.()
  process.once('exit', () => {
    clearInterval(timer)
    try {
      if (readFileSync(lock, 'utf8') === mine) unlinkSync(lock)
    } catch {}
  })
}

/**
 * Why the SQLite driver cannot load, or null. better-sqlite3 is an OPTIONAL dependency (a native
 * module: an image build that cannot fetch or compile its binary goes on without it), so
 * DB_CLIENT=sqlite checks it is really there before anything connects.
 */
export function sqliteDriverProblem(load: (id: string) => unknown = require): string | null {
  try {
    load('better-sqlite3')
    return null
  } catch (err) {
    const why = (err as Error)?.message?.split('\n')[0] ?? String(err)
    return `DB_CLIENT=sqlite needs the better-sqlite3 module, which this build cannot load (${why}). It is an optional dependency: its native binary was not downloaded or built for this platform. Install it (\`pnpm add better-sqlite3\` in api/, needs python3, make and a C++ compiler when no prebuilt binary exists) or use SQL Server, Postgres or MySQL.`
  }
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

/** A declared type SQLite gives text affinity (varchar, char, text, clob). */
export function isTextAffinity(declared: string | null | undefined): boolean {
  return /char|clob|text/i.test(String(declared ?? ''))
}

/** A column type as knex compiled it, with COLLATE NOCASE when it holds text (point 8). */
export function withNocase(type: string): string {
  return isTextAffinity(type) && !/\bcollate\b/i.test(type) ? `${type} collate nocase` : type
}

/** The character limit of a sized text type — varchar(n), char(n), nvarchar(n) — else null.
 *  char(36) is knex's uuid (SQL Server's uniqueidentifier), not a sized text column. */
export function sizedTextLength(declared: string | null | undefined): number | null {
  const m = /^\s*n?(?:var)?char(?:acter)?(?:\s+varying)?\s*\(\s*(\d+)\s*\)/i.exec(
    String(declared ?? '')
  )
  if (!m || /^\s*char\s*\(\s*36\s*\)/i.test(String(declared))) return null
  return Number(m[1])
}

/** The CHECK that holds a sized text column to its length, as SQL Server's nvarchar(n) does
 *  (point 9). Unnamed, so SQLite's refusal names the column ("CHECK constraint failed:
 *  length("name") <= 10"), and a column rename rewrites it. */
export function lengthCheck(column: string, length: number): string {
  return `check (length("${column.replace(/"/g, '""')}") <= ${length})`
}

/** A refusal of a lengthCheck: the column it names and the limit. */
export const LENGTH_CHECK_FAILED =
  /CHECK constraint failed: length\(["`]?([^"`)]+)["`]?\)\s*<=\s*(\d+)/i

/** Declared column types read back as dates. */
export function isDateType(declared: string | null | undefined): boolean {
  const t = String(declared ?? '').toLowerCase()
  return t === 'date' || /datetime|timestamp/.test(t)
}

/** Declared bigint columns (knex's `bigInteger()`). */
export function isBigintType(declared: string | null | undefined): boolean {
  return /^bigint\b/i.test(String(declared ?? '').trim())
}
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE = -MAX_SAFE

/** Declared column types read back as true / false (knex's `table.boolean()` declares `boolean`). */
export function isBooleanType(declared: string | null | undefined): boolean {
  const t = String(declared ?? '').toLowerCase()
  return t === 'boolean' || t === 'bool'
}

const DATE_OPS = new Set([
  '_eq',
  '_neq',
  '_gt',
  '_gte',
  '_lt',
  '_lte',
  '_between',
  '_nbetween',
  '_in',
  '_nin'
])

/**
 * Filter values against a date / datetime column, in place, in the stored shape: SQLite compares
 * the TEXT, so '2026-11-20 10:00' or a bare date against stored '…T…Z' values would compare
 * wrong, and a value that is no date at all would quietly match by text order where the other
 * databases refuse the conversion. Returns the operator of a value that is not a date (the
 * caller refuses it), else null. A date column keeps 'YYYY-MM-DD'.
 */
export function fitSqliteDateOps(ops: Record<string, unknown>, declared: string): string | null {
  const dateOnly = String(declared).toLowerCase() === 'date'
  const fit = (v: unknown): { ok: boolean; v: unknown } => {
    if (v == null) return { ok: true, v }
    const d = v instanceof Date ? v : typeof v === 'string' ? fromSqliteTime(v.trim()) : null
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return { ok: false, v }
    return { ok: true, v: dateOnly ? d.toISOString().slice(0, 10) : d.toISOString() }
  }
  for (const [op, val] of Object.entries(ops)) {
    if (!DATE_OPS.has(op)) continue
    const vals = Array.isArray(val) ? val : [val]
    const fitted = vals.map(fit)
    if (fitted.some((f) => !f.ok)) return op
    ops[op] = Array.isArray(val) ? fitted.map((f) => f.v) : fitted[0].v
  }
  return null
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
  const bigs: string[] = []
  for (const c of columns) {
    if (isBigintType(c.type)) bigs.push(c.name)
    if (isDateType(c.type)) dated.push(c.name)
    else if (isBooleanType(c.type)) bools.push(c.name)
    else if (c.type == null) exprs.push(c.name)
  }
  const wide = bigs.length > 0
  if (!dated.length && !bools.length && !exprs.length && !wide) return rows
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const r = row as Record<string, unknown>
    // 64-bit integers (a read with a bigint column, above). A bigint column reads as its digits,
    // like SQL Server (tedious), Postgres and MySQL (mysqlTypeCast); any other integer in the same
    // read is a number while exact, else its digits.
    if (wide) {
      for (const [k, v] of Object.entries(r))
        if (typeof v === 'bigint') r[k] = v >= MIN_SAFE && v <= MAX_SAFE ? Number(v) : v.toString()
      for (const k of bigs) {
        const v = r[k]
        if (typeof v === 'number' && Number.isInteger(v)) r[k] = String(v)
      }
    }
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

/** The INFORMATION_SCHEMA views as SQLite subqueries (standard column names). Table and column
 *  names compare case-insensitively, as SQL Server's catalog does (point 8). */
export const SQLITE_INFORMATION_SCHEMA: Record<string, string> = {
  TABLES: `SELECT 'main' AS TABLE_CATALOG, 'main' AS TABLE_SCHEMA, m.name COLLATE NOCASE AS TABLE_NAME, CASE m.type WHEN 'view' THEN 'VIEW' ELSE 'BASE TABLE' END AS TABLE_TYPE FROM sqlite_master m WHERE ${USER_TABLES}`,
  VIEWS: `SELECT 'main' AS TABLE_CATALOG, 'main' AS TABLE_SCHEMA, m.name COLLATE NOCASE AS TABLE_NAME, m.sql AS VIEW_DEFINITION FROM sqlite_master m WHERE m.type = 'view'`,
  COLUMNS: `SELECT 'main' AS TABLE_CATALOG, 'main' AS TABLE_SCHEMA, m.name COLLATE NOCASE AS TABLE_NAME, p.name COLLATE NOCASE AS COLUMN_NAME, p.cid + 1 AS ORDINAL_POSITION, p.dflt_value AS COLUMN_DEFAULT, CASE WHEN p."notnull" = 1 OR p.pk > 0 THEN 'NO' ELSE 'YES' END AS IS_NULLABLE, ${typeBase} AS DATA_TYPE, CASE WHEN instr(p.type, '(') > 0 AND ${typeBase} LIKE '%char%' THEN CAST(substr(p.type, instr(p.type, '(') + 1) AS INTEGER) END AS CHARACTER_MAXIMUM_LENGTH, CASE WHEN instr(p.type, '(') > 0 AND ${typeBase} IN ('decimal', 'numeric') THEN CAST(substr(p.type, instr(p.type, '(') + 1) AS INTEGER) END AS NUMERIC_PRECISION, CASE WHEN instr(p.type, ',') > 0 AND ${typeBase} IN ('decimal', 'numeric') THEN CAST(substr(p.type, instr(p.type, ',') + 1) AS INTEGER) END AS NUMERIC_SCALE, NULL AS DATETIME_PRECISION, NULL AS COLLATION_NAME, lower(p.type) AS COLUMN_TYPE, CASE WHEN p.pk > 0 THEN 'PRI' ELSE '' END AS COLUMN_KEY, CASE WHEN p.pk = 1 AND lower(p.type) = 'integer' AND lower(m.sql) LIKE '%autoincrement%' THEN 'auto_increment' ELSE '' END AS EXTRA, CASE WHEN p.pk = 1 AND lower(p.type) = 'integer' AND lower(m.sql) LIKE '%autoincrement%' THEN 'YES' ELSE 'NO' END AS IS_IDENTITY FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE ${USER_TABLES}`,
  TABLE_CONSTRAINTS: `SELECT 'main' AS CONSTRAINT_CATALOG, 'main' AS CONSTRAINT_SCHEMA, 'pk_' || m.name AS CONSTRAINT_NAME, 'main' AS TABLE_SCHEMA, m.name COLLATE NOCASE AS TABLE_NAME, 'PRIMARY KEY' AS CONSTRAINT_TYPE FROM sqlite_master m WHERE ${BASE_TABLES} AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) p WHERE p.pk > 0) UNION ALL SELECT DISTINCT 'main', 'main', 'fk_' || m.name || '_' || f.id, 'main', m.name, 'FOREIGN KEY' FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE ${BASE_TABLES} UNION ALL SELECT 'main', 'main', il.name, 'main', m.name, 'UNIQUE' FROM sqlite_master m JOIN pragma_index_list(m.name) il WHERE ${BASE_TABLES} AND il."unique" = 1 AND il.origin <> 'pk' AND il.partial = 0`,
  KEY_COLUMN_USAGE: `SELECT 'main' AS CONSTRAINT_CATALOG, 'main' AS CONSTRAINT_SCHEMA, 'pk_' || m.name AS CONSTRAINT_NAME, 'main' AS TABLE_SCHEMA, m.name COLLATE NOCASE AS TABLE_NAME, p.name COLLATE NOCASE AS COLUMN_NAME, p.pk AS ORDINAL_POSITION, NULL AS REFERENCED_TABLE_SCHEMA, NULL AS REFERENCED_TABLE_NAME, NULL AS REFERENCED_COLUMN_NAME FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE ${BASE_TABLES} AND p.pk > 0 UNION ALL SELECT 'main', 'main', 'fk_' || m.name || '_' || f.id, 'main', m.name, f."from", f.seq + 1, 'main', f."table", f."to" FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE ${BASE_TABLES} UNION ALL SELECT 'main', 'main', il.name, 'main', m.name, ii.name, ii.seqno + 1, NULL, NULL, NULL FROM sqlite_master m JOIN pragma_index_list(m.name) il JOIN pragma_index_info(il.name) ii WHERE ${BASE_TABLES} AND il."unique" = 1 AND il.origin <> 'pk' AND il.partial = 0`
}

// Bare or quoted (knex's builder writes `information_schema`.`columns` on SQLite).
const INFO_SCHEMA =
  /[`"[]?\binformation_schema[`"\]]?\s*\.\s*[`"[]?(tables|views|columns|table_constraints|key_column_usage)\b[`"\]]?/gi

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

interface TxScope {
  connection: { inTransaction?: boolean; prepare: (sql: string) => any }
  trx: { isCompleted: () => boolean }
}

/** The knex transaction whose callback is running (point 3: writes made with `db` inside it). */
export const sqliteTxScope = new AsyncLocalStorage<TxScope>()

/** The connection a write on `connection` must run on: the enclosing transaction's, while it holds the lock. */
export function sqliteWriteTarget(connection: unknown): TxScope['connection'] | null {
  const scope = sqliteTxScope.getStore()
  if (!scope || scope.connection === connection) return null
  if (scope.trx.isCompleted() || !scope.connection.inTransaction) return null
  return sqliteWriteLock.holder === scope.connection ? scope.connection : null
}

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

const likes = new Map<string, RegExp>()

/**
 * `value LIKE pattern [ESCAPE esc]` (SQLite calls like(pattern, value[, esc])): `%` any run, `_`
 * one character, the escape character (default backslash) makes the next one literal; case-
 * insensitive. NULL in → NULL out; a blob never matches (as SQLite's LIKE_DOESNT_MATCH_BLOBS).
 */
export function sqliteLike(pattern: unknown, value: unknown, escapeChar?: unknown): number | null {
  if (pattern == null || value == null) return null
  if (value instanceof Uint8Array || pattern instanceof Uint8Array) return 0
  const p = String(pattern)
  const esc = escapeChar === undefined ? '\\' : String(escapeChar ?? '')
  const key = `${esc}\u0000${p}`
  let re = likes.get(key)
  if (!re) {
    let body = ''
    const chars = [...p]
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i]
      if (esc && c === esc && i + 1 < chars.length) {
        body += chars[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
      } else if (c === '%') body += '[\\s\\S]*'
      else if (c === '_') body += '[\\s\\S]'
      else body += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    }
    re = new RegExp(`^${body}$`, 'iu')
    if (likes.size > 2000) likes.clear()
    likes.set(key, re)
  }
  return re.test(typeof value === 'string' ? value : String(value)) ? 1 : 0
}

const chars = (v: unknown): string[] => [...String(v)]

/** Text functions SQLite lacks, as the other databases define them (NULL in → NULL out). */
export const sqliteTextFunctions: Record<string, (...a: unknown[]) => unknown> = {
  left: (s, n) =>
    s == null || n == null
      ? null
      : chars(s)
          .slice(0, Math.max(0, Number(n)))
          .join(''),
  right: (s, n) => {
    if (s == null || n == null) return null
    const k = Math.max(0, Number(n))
    return k ? chars(s).slice(-k).join('') : ''
  },
  char_length: (s) => (s == null ? null : chars(s).length),
  lpad: (s, n, pad) => {
    if (s == null || n == null || pad == null) return null
    const c = chars(s)
    const len = Math.max(0, Number(n))
    if (c.length >= len) return c.slice(0, len).join('')
    const p = chars(pad)
    if (!p.length) return null
    const fill: string[] = []
    while (fill.length < len - c.length) fill.push(p[fill.length % p.length])
    return fill.join('') + c.join('')
  },
  locate: (needle, hay, from) => {
    if (needle == null || hay == null) return null
    const h = chars(hay)
    const start = Math.max(1, from == null ? 1 : Number(from))
    const at = h
      .slice(start - 1)
      .join('')
      .indexOf(String(needle))
    return at < 0
      ? 0
      : chars(
          h
            .slice(start - 1)
            .join('')
            .slice(0, at)
        ).length + start
  }
}

interface StdevState {
  n: number
  mean: number
  m2: number
}

/** STDDEV_SAMP as an aggregate (Welford): NULL for fewer than two values, like STDEV. */
export const sqliteStddevSamp = {
  start: (): StdevState => ({ n: 0, mean: 0, m2: 0 }),
  step: (st: StdevState, v: unknown): StdevState => {
    if (v == null) return st
    const x = Number(v)
    if (!Number.isFinite(x)) return st
    st.n++
    const d = x - st.mean
    st.mean += d / st.n
    st.m2 += d * (x - st.mean)
    return st
  },
  result: (st: StdevState): number | null => (st.n > 1 ? Math.sqrt(st.m2 / (st.n - 1)) : null)
}

/**
 * Statements of a SQL script, split on `;` outside quotes and comments (better-sqlite3 prepares
 * one statement at a time). Empty statements are dropped.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const n = sql[i + 1]
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) j += 2
          else break
        } else j++
      }
      cur += sql.slice(i, j + 1)
      i = j + 1
    } else if (c === '-' && n === '-') {
      const j = sql.indexOf('\n', i)
      const end = j < 0 ? sql.length : j
      cur += sql.slice(i, end)
      i = end
    } else if (c === '/' && n === '*') {
      const j = sql.indexOf('*/', i + 2)
      const end = j < 0 ? sql.length : j + 2
      cur += sql.slice(i, end)
      i = end
    } else if (c === ';') {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      i++
    } else {
      cur += c
      i++
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

interface SqliteConnection {
  pragma: (s: string) => unknown
  aggregate?: (name: string, opts: Record<string, unknown>) => unknown
  function: (
    name: string,
    opts: { deterministic: boolean; varargs?: boolean },
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
    // MD5(text) as MySQL answers it (lower-case hex); NULL stays NULL. Grouping keys use it.
    conn.function('md5', { deterministic: true }, (v: unknown) =>
      v == null ? null : createHash('md5').update(String(v)).digest('hex')
    )
    // The schema name INFORMATION_SCHEMA queries compare TABLE_SCHEMA with (point 6).
    conn.function('database', { deterministic: true }, () => 'main')
    conn.function('schema_name', { deterministic: true }, () => 'main')
    conn.function('current_schema', { deterministic: true }, () => 'main')
    for (const [name, fn] of Object.entries(sqliteTextFunctions))
      conn.function(name, { deterministic: true, varargs: true }, fn)
    // Point 7: LIKE with a backslash escape by default, case-insensitive for every letter.
    conn.function('like', { deterministic: true }, (p: unknown, v: unknown) => sqliteLike(p, v))
    conn.function('like', { deterministic: true }, (p: unknown, v: unknown, e: unknown) =>
      sqliteLike(p, v, e)
    )
    conn.aggregate?.('stddev_samp', { ...sqliteStddevSamp, start: sqliteStddevSamp.start })
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
    let statement = connection.prepare(obj.sql)
    if (!begin && !statement.readonly) {
      const target = sqliteWriteTarget(connection)
      if (target) {
        // Point 3: a write with `db` inside a transaction's callback joins that transaction.
        connection = target
        statement = target.prepare(obj.sql)
      }
    }
    const safeIntegers = this._optSafeIntegers(obj.options)
    if (safeIntegers !== undefined) statement.safeIntegers(safeIntegers)
    // A bigint column past 2^53 reads back as its exact digits (text), as SQL Server's does,
    // instead of a rounded JS number: such a read takes 64-bit integers (convertRows).
    else if (statement.reader && statement.columns().some((c: ColumnInfo) => isBigintType(c.type)))
      statement.safeIntegers(true)
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

  // Point 3: every transaction callback runs inside sqliteTxScope (savepoints too).
  const SqliteTransaction = require('knex/lib/dialects/sqlite3/execution/sqlite-transaction.js')
  const onAcquire = SqliteTransaction.prototype._onAcquire
  SqliteTransaction.prototype._onAcquire = function (container: unknown, connection: any) {
    return sqliteTxScope.run({ connection, trx: this }, () =>
      onAcquire.call(this, container, connection)
    )
  }

  const destroy = proto.destroyRawConnection
  proto.destroyRawConnection = async function (connection: unknown) {
    sqliteWriteLock.release(connection)
    return destroy.call(this, connection)
  }

  // Row locks (point 3): `.forUpdate()` already compiles to nothing on SQLite; `.skipLocked()` /
  // `.noWait()` would throw. With one writer there is no locked row to skip or wait for.
  const QueryCompiler = require('knex/lib/dialects/sqlite3/query/sqlite-querycompiler.js')
  QueryCompiler.prototype.skipLocked = () => ''
  QueryCompiler.prototype.noWait = () => ''

  // Timestamp defaults in the stored shape (point 1).
  const ColumnCompiler = require('knex/lib/dialects/sqlite3/schema/sqlite-columncompiler.js')
  const defaultTo = ColumnCompiler.prototype.defaultTo
  ColumnCompiler.prototype.defaultTo = function (...args: unknown[]) {
    const sql = defaultTo.apply(this, args) as string
    return /^default\s+CURRENT_TIMESTAMP$/i.test(sql) ? `default (${SQLITE_NOW})` : sql
  }
  // Point 8: text columns compare and sort case-insensitively (COLLATE NOCASE), and a decimal
  // keeps its declared precision and scale (knex declares every decimal `float` on SQLite).
  const BaseColumnCompiler = require('knex/lib/schema/columncompiler.js')
  ColumnCompiler.prototype.decimal = BaseColumnCompiler.prototype.decimal
  // Point 9: a sized text column carries its length check.
  const getColumnType = ColumnCompiler.prototype.getColumnType
  ColumnCompiler.prototype.getColumnType = function () {
    if (this._sqliteColumnType === undefined) {
      const type = getColumnType.call(this) as string
      const length = /\bcheck\b/i.test(type) ? null : sizedTextLength(type)
      this._sqliteColumnType =
        withNocase(type) + (length != null ? ` ${lengthCheck(this.getColumnName(), length)}` : '')
    }
    return this._sqliteColumnType
  }
  const DDL = require('knex/lib/dialects/sqlite3/schema/ddl.js')
  const { parseCreateTable } = require('knex/lib/dialects/sqlite3/schema/internal/parser.js')
  const { compileCreateTable } = require('knex/lib/dialects/sqlite3/schema/internal/compiler.js')
  const { isEqualId } = require('knex/lib/dialects/sqlite3/schema/internal/utils.js')
  // knex's own alterColumn (ddl.js), with two changes: CURRENT_TIMESTAMP defaults in the stored
  // shape (point 1), and a column whose new type text carries its collation and length check
  // (points 8 and 9) drops the old ones instead of keeping both.
  DDL.prototype.alterColumn = async function (
    columns: Array<{ name: string; type: string; defaultTo: unknown; notNull: boolean }>
  ) {
    for (const c of columns)
      if (typeof c.defaultTo === 'string' && /^CURRENT_TIMESTAMP$/i.test(c.defaultTo))
        c.defaultTo = `(${SQLITE_NOW})`
    const { createTable, createIndices } = await this.getTableSql()
    const parsedTable = parseCreateTable(createTable)
    parsedTable.table = this.alteredName
    parsedTable.columns = parsedTable.columns.map((column: any) => {
      const info = columns.find((c) => isEqualId(c.name, column.name))
      if (info) {
        column.type = info.type
        column.constraints.default =
          info.defaultTo !== null ? { name: null, value: info.defaultTo, expression: false } : null
        column.constraints.notnull = info.notNull ? { name: null, conflict: null } : null
        column.constraints.null = info.notNull ? null : column.constraints.null
        if (/\bcollate\b/i.test(info.type)) column.constraints.collate = null
        if (/"length"/i.test(JSON.stringify(column.constraints.check ?? null)))
          column.constraints.check = null
      }
      return column
    })
    return this.generateAlterCommands(compileCreateTable(parsedTable, this.wrap), createIndices)
  }

  // ADD COLUMN with a non-constant default → rebuild the table with the column (point 5).
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
