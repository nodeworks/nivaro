import { createRequire } from 'node:module'
import type { Knex } from 'knex'

const require = createRequire(import.meta.url)

// MariaDB runs on knex's MySQL client ('mysql2', the same driver) and speaks the MySQL dialect:
// sqlDialect(knex) answers 'mysql' for it, so every MySQL branch in the app applies unchanged.
// What differs (a catalog read, a migration that MariaDB refuses, a helper's output) branches on
// isMariaDb(knex). The flavour is a mark on the knex config (DB_CLIENT=mariadb sets it on every
// pool db/index.ts builds; a cloud tenant pool with client 'mariadb' gets it too), never a
// server round trip — a transaction or a cloned client carries the same config.
//
// Oldest MariaDB supported: 10.11 LTS (JSON_TABLE, SKIP LOCKED, the UUID type and RETURNING on
// INSERT all exist there). A boot against an older one, or against the wrong server family, is
// refused with one line that names the setting to change (checkServerFlavor).

/** The knex config key that marks a MySQL-family pool as MariaDB. */
export const MYSQL_FLAVOR_KEY = 'nivaroMysqlFlavor'

/** Spread into a knex config: the MariaDB mark when `mariadb`, nothing otherwise. */
export function mysqlFlavorConfig(mariadb: boolean): Record<string, string> {
  return mariadb ? { [MYSQL_FLAVOR_KEY]: 'mariadb' } : {}
}

/** True when this knex is a MySQL-dialect pool talking to MariaDB. */
export function isMariaDb(knex: Knex | Knex.Transaction | null | undefined): boolean {
  // biome-ignore lint/suspicious/noExplicitAny: knex does not type client.config
  return (knex as any)?.client?.config?.[MYSQL_FLAVOR_KEY] === 'mariadb'
}

/** 'mariadb' | 'mysql' for a MySQL-dialect knex, null for SQL Server / Postgres. */
export function mysqlFlavor(knex: Knex | Knex.Transaction): 'mysql' | 'mariadb' | null {
  // biome-ignore lint/suspicious/noExplicitAny: knex does not type client.config
  const c = String((knex as any)?.client?.config?.client ?? '')
  if (c !== 'mysql' && c !== 'mysql2') return null
  return isMariaDb(knex) ? 'mariadb' : 'mysql'
}

/** Oldest MariaDB release Nivaro supports. */
export const MARIADB_MIN: readonly [number, number] = [10, 11]

/** True when a `SELECT VERSION()` string is a MariaDB server's ('11.4.3-MariaDB-ubu2404'). */
export function versionIsMariaDb(version: string): boolean {
  return /mariadb/i.test(version)
}

/**
 * Why this server cannot be used with the declared DB_CLIENT, as one line — or null when it can.
 * `declaredMariaDb` = DB_CLIENT=mariadb; `version` = the server's `SELECT VERSION()`; `charset` =
 * the database's `@@character_set_database` (judged on MariaDB only — MySQL is left as it was).
 */
export function serverFlavorProblem(
  declaredMariaDb: boolean,
  version: string,
  charset?: string | null
): string | null {
  const v = version.trim()
  const maria = versionIsMariaDb(v)
  if (maria && !declaredMariaDb)
    return `DB_CLIENT=mysql2 but the database server is MariaDB (${v}). Set DB_CLIENT=mariadb.`
  if (!maria && declaredMariaDb)
    return `DB_CLIENT=mariadb but the database server is MySQL (${v}). Set DB_CLIENT=mysql2.`
  if (maria) {
    const m = /^(\d+)\.(\d+)/.exec(v)
    const [maj, min] = m ? [Number(m[1]), Number(m[2])] : [0, 0]
    if (maj < MARIADB_MIN[0] || (maj === MARIADB_MIN[0] && min < MARIADB_MIN[1]))
      return `MariaDB ${v} is older than ${MARIADB_MIN.join('.')}, the oldest release Nivaro supports. Upgrade the server.`
    // Upstream MariaDB before 11.6 defaults to latin1 (MySQL 8, the Docker image and the distro
    // packages use utf8mb4): tables created there refuse emoji and most non-Latin text.
    if (charset && charset.toLowerCase() !== 'utf8mb4')
      return `The database's default character set is ${charset}; Nivaro needs utf8mb4. Run ALTER DATABASE <name> CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci before the first start.`
  }
  return null
}

/**
 * Ask a MySQL-dialect pool which server it reached and judge it against the declared flavour.
 * Null (no problem) for SQL Server / Postgres pools.
 */
export async function checkServerFlavor(
  knex: Knex,
  declaredMariaDb = isMariaDb(knex)
): Promise<string | null> {
  if (!mysqlFlavor(knex)) return null
  const res = await knex.raw('SELECT VERSION() AS v, @@character_set_database AS cs')
  const rows = Array.isArray(res) && Array.isArray(res[0]) ? res[0] : res
  const row = (Array.isArray(rows) ? rows[0] : rows) as { v?: unknown; cs?: unknown } | undefined
  return serverFlavorProblem(declaredMariaDb, String(row?.v ?? ''), row?.cs ? String(row.cs) : null)
}

// ─── Zoned ISO timestamps as bindings ─────────────────────────────────────────
// The app binds timestamps as ISO-8601 text ('2026-12-01T10:00:00.000Z', `toISOString()`, request
// bodies) all over. In strict mode MySQL 8.4 AND MariaDB refuse that text in any data-changing
// statement that puts it against a DATE / DATETIME / TIMESTAMP column — the value written
// (INSERT, UPDATE … SET) and a comparison in its WHERE (UPDATE / DELETE … WHERE at < '…Z' →
// "Incorrect datetime value" / "Truncated incorrect datetime value"). A SELECT reads it (a
// warning at most, the same instant for 'Z'; an offset is dropped as SQL Server's datetime2 does).
//
// So on every MySQL-family pool (both flavours alike), a data-changing statement sends each
// binding that is EXACTLY one zoned ISO timestamp as its UTC wall time ('2026-12-01
// 10:00:00.000' — the same instant, sessions run in UTC: mysql-session.ts), which every date
// column takes. The one exception keeps text exact: a query builder's value for a column the
// catalog says is NOT a date (an insert / update value, or a plain where / whereIn on the
// statement's own table) is left as given, so a string or JSON field holding an ISO timestamp
// stores and matches exactly what SQL Server stores. Raw SQL statements have no column
// information: every zoned ISO binding of a raw INSERT / UPDATE / DELETE / REPLACE / CALL is
// sent as wall time. SELECTs are never touched. SQL Server / Postgres / SQLite: nothing changes.
const ZONED_ISO =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/

/** A zoned ISO timestamp as MySQL / MariaDB UTC literal text; any other value unchanged. */
export function mariaDbBinding(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > 40) return value
  const m = ZONED_ISO.exec(value)
  if (!m) return value
  const [, date, hm, sec = '00', frac = '', zone] = m
  const ms = Date.parse(`${date}T${hm}:${sec}${zone}`)
  if (Number.isNaN(ms)) return value
  const utc = new Date(ms).toISOString() // seconds resolution here; the fraction is kept as sent
  if (utc.slice(0, 10) !== date && zone === 'Z') return value // an impossible date (02-30): let the server refuse it
  return `${utc.slice(0, 10)} ${utc.slice(11, 19)}${frac ? `.${frac.slice(0, 6)}` : ''}`
}

function isZonedIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && ZONED_ISO.test(value)
}

/** A text binding that must reach the server exactly as given (its column is not a date). */
export class ExactText {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value
  }
  toJSON(): string {
    return this.value
  }
}

const WRITE_METHODS = new Set(['insert', 'update', 'del', 'delete', 'upsert', 'counter'])
const WRITE_SQL =
  /^\s*(?:\/\*[\s\S]*?\*\/\s*)*(?:insert|update|delete|replace|call)\b|\b(?:insert\s+(?:ignore\s+)?into|replace\s+into|delete\s+from)\b|\bupdate\s+\S+(?:\s+(?:as\s+)?\w+)?\s+set\b/i

/** Whether a compiled statement changes data (knex builder method, or raw SQL text). */
export function isWriteStatement(method: unknown, sql: unknown): boolean {
  if (typeof method === 'string' && method !== 'raw') return WRITE_METHODS.has(method)
  return typeof sql === 'string' && WRITE_SQL.test(sql)
}

/** The bindings a MySQL-family server gets: ExactText unwrapped; in a data-changing statement
 *  every other zoned ISO timestamp as UTC wall time. */
export function mysqlStatementBindings(bindings: unknown, write: boolean): unknown {
  if (!Array.isArray(bindings)) return bindings
  return bindings.map((b) => (b instanceof ExactText ? b.value : write ? mariaDbBinding(b) : b))
}

// Column types per database + table (lower-cased name → is a date), for the ExactText marks.
const COLUMN_TTL_MS = 60_000
const columnTypeCache = new Map<
  string,
  { at: number; cols: Promise<Map<string, boolean> | null> }
>()
const DATE_TYPES = new Set(['date', 'datetime', 'timestamp'])

function columnTypesOf(client: any, table: string): Promise<Map<string, boolean> | null> {
  const key = `${client?.config?.connection?.database ?? ''}|${table.toLowerCase()}`
  const hit = columnTypeCache.get(key)
  if (hit && Date.now() - hit.at < COLUMN_TTL_MS) return hit.cols
  const cols = Promise.resolve(
    client.raw(
      'SELECT COLUMN_NAME AS c, DATA_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [table]
    )
  )
    .then((res: unknown) => {
      const rows = (Array.isArray(res) && Array.isArray(res[0]) ? res[0] : res) as Array<{
        c?: unknown
        t?: unknown
      }>
      if (!Array.isArray(rows) || rows.length === 0) return null
      return new Map(
        rows.map((r) => [String(r.c).toLowerCase(), DATE_TYPES.has(String(r.t).toLowerCase())])
      )
    })
    .catch(() => null)
  columnTypeCache.set(key, { at: Date.now(), cols })
  return cols
}

/** Test hook: forget the cached column types. */
export function forgetMysqlColumnTypes(): void {
  columnTypeCache.clear()
}

const hasZonedValue = (o: unknown): boolean =>
  !!o && typeof o === 'object' && Object.values(o as Record<string, unknown>).some(isZonedIso)

/**
 * Before a MySQL-family data-changing builder runs: its zoned ISO values that target a column the
 * catalog says is not a date become ExactText (kept exactly). Returns a restore function (the
 * builder is put back as the caller built it), or null when nothing changed.
 */
export async function markExactText(client: any, builder: any): Promise<(() => void) | null> {
  const method = builder?._method
  if (!WRITE_METHODS.has(method)) return null
  const single = builder._single ?? {}
  if (typeof single.table !== 'string') return null
  const m = /^\s*(?:[`"\w]+\.)?[`"]?(\w+)[`"]?(?:\s+(?:as\s+)?[`"]?(\w+)[`"]?)?\s*$/i.exec(
    single.table
  )
  if (!m) return null
  const table = m[1]
  const names = new Set([table.toLowerCase(), (m[2] ?? table).toLowerCase()])
  const insert = single.insert
  const rows = Array.isArray(insert) ? insert : insert && typeof insert === 'object' ? [insert] : []
  const whereStmts = ((builder._statements ?? []) as Array<Record<string, unknown>>).filter(
    (st) =>
      st.grouping === 'where' &&
      typeof st.column === 'string' &&
      ((st.type === 'whereBasic' && isZonedIso(st.value)) ||
        (st.type === 'whereIn' && Array.isArray(st.value) && st.value.some(isZonedIso)))
  )
  if (!rows.some(hasZonedValue) && !hasZonedValue(single.update) && whereStmts.length === 0)
    return null
  const types = await columnTypesOf(client, table)
  if (!types) return null
  const keep = (col: string, v: unknown) =>
    isZonedIso(v) && types.get(col.toLowerCase()) === false ? new ExactText(v) : v
  const own = (column: string): string | null => {
    const dot = column.lastIndexOf('.')
    if (dot < 0) return column
    return names.has(column.slice(0, dot).replace(/[`"]/g, '').toLowerCase())
      ? column.slice(dot + 1)
      : null
  }
  const mark = (o: unknown) =>
    o && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype
      ? Object.fromEntries(
          Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, keep(k, v)])
        )
      : o
  const before = { insert: single.insert, update: single.update }
  const values = new Map<Record<string, unknown>, unknown>()
  if (rows.length) single.insert = Array.isArray(insert) ? insert.map(mark) : mark(insert)
  if (single.update) single.update = mark(single.update)
  for (const st of whereStmts) {
    const col = own(st.column as string)
    if (!col) continue
    values.set(st, st.value)
    st.value = Array.isArray(st.value) ? st.value.map((v) => keep(col, v)) : keep(col, st.value)
  }
  return () => {
    single.insert = before.insert
    single.update = before.update
    for (const [st, v] of values) st.value = v
  }
}

let bindingsPatched = false
/**
 * Patch knex's MySQL client (mysql2 extends it) once: data-changing statements send zoned ISO
 * timestamps as UTC wall time, except builder values for non-date columns (markExactText). Both
 * flavours alike; no other dialect is touched.
 */
export function mysqlTimestampWriteCompat(): void {
  if (bindingsPatched) return
  bindingsPatched = true
  const MySQLClient = require('knex/lib/dialects/mysql/index.js') as any
  const baseQuery = MySQLClient.prototype._query
  MySQLClient.prototype._query = function (this: any, connection: unknown, obj: any) {
    if (obj && typeof obj === 'object' && Array.isArray(obj.bindings))
      obj.bindings = mysqlStatementBindings(obj.bindings, isWriteStatement(obj.method, obj.sql))
    return baseQuery.call(this, connection, obj)
  }
  const Runner = require('knex/lib/execution/runner.js') as any
  const baseRun = Runner.prototype.run
  Runner.prototype.run = async function (this: any) {
    if (!(this.client instanceof MySQLClient) || !WRITE_METHODS.has(this.builder?._method))
      return baseRun.call(this)
    const restore = await markExactText(this.client, this.builder).catch(() => null)
    try {
      return await baseRun.call(this)
    } finally {
      restore?.()
    }
  }
}

/**
 * The knex `client` (+ flavour mark) for a tenant's `dbClient` as the control plane names it:
 * 'mariadb' → knex client 'mysql2' marked MariaDB; every other name unchanged.
 */
export function knexClientFor(dbClient: string): { client: string } & Record<string, string> {
  return dbClient === 'mariadb'
    ? { client: 'mysql2', ...mysqlFlavorConfig(true) }
    : { client: dbClient }
}

/**
 * information_schema.COLUMNS.COLUMN_DEFAULT as MySQL words it. MariaDB (10.2.7+) quotes string
 * defaults ("'abc'"), reports a nullable column without a default as the TEXT 'NULL' and writes
 * current_timestamp(); MySQL gives abc, SQL NULL and CURRENT_TIMESTAMP. Catalog reads that show or
 * compare a default pass MariaDB's value through this (`isMariaDb(knex)`); other values unchanged.
 */
export function mariaDbColumnDefault(value: string | null | undefined): string | null {
  if (value == null || value === 'NULL') return null
  const quoted = /^'([\s\S]*)'$/.exec(value)
  if (quoted) return quoted[1].replace(/''/g, "'").replace(/\\\\/g, '\\')
  if (/^current_timestamp\((\d*)\)$/i.test(value))
    return value.replace(/^current_timestamp\((\d*)\)$/i, (_, p) =>
      p ? `CURRENT_TIMESTAMP(${p})` : 'CURRENT_TIMESTAMP'
    )
  return value
}

/**
 * information_schema.COLUMNS.COLUMN_DEFAULT (or knex columnInfo().defaultValue) on Postgres, worded
 * as MySQL shows it. Postgres keeps the expression text: `'abc'::character varying`,
 * `'-1'::integer`, `NULL::text`, `false`, `nextval('t_id_seq'::regclass)`, `now()`. Here: the plain
 * value (abc, -1), SQL NULL for none, booleans as 0 / 1, an identity's sequence as no default (SQL
 * Server and MySQL report none for identity / AUTO_INCREMENT), now() as CURRENT_TIMESTAMP, the UTC
 * clock as utc_timestamp(), a UTC timestamp literal without its +00. Other expressions
 * (gen_random_uuid()) lose only their casts and outer parentheses.
 */
export function pgColumnDefault(value: string | null | undefined): string | null {
  if (value == null) return null
  let v = String(value).trim()
  // ('-1'::integer) — Postgres wraps some negative / cast defaults in parentheses.
  while (/^\(([\s\S]*)\)$/.test(v) && !/^\([\s\S]*\)[\s\S]*\(/.test(v)) v = v.slice(1, -1).trim()
  // Trailing casts: 'abc'::character varying, 'x'::text::character varying, NULL::text.
  const cast = /::\s*"?[a-z_][a-z0-9_ ]*"?(\(\d+(,\s*\d+)?\))?(\[\])?\s*$/i
  while (cast.test(v) && !/^'[^']*$/.test(v.replace(cast, ''))) v = v.replace(cast, '').trim()
  if (/^null$/i.test(v)) return null
  if (/^nextval\(/i.test(v)) return null
  if (/^true$/i.test(v)) return '1'
  if (/^false$/i.test(v)) return '0'
  if (/^(now\(\)|current_timestamp|transaction_timestamp\(\))$/i.test(v)) return 'CURRENT_TIMESTAMP'
  // The UTC clock (`now() AT TIME ZONE 'utc'`, `timezone('utc', now())`): MySQL says utc_timestamp().
  if (
    /^\(?\s*(now\(\)|current_timestamp)\s*\)?\s+at\s+time\s+zone\s+'utc'(::text)?$/i.test(v) ||
    /^timezone\('utc'(::text)?,\s*(now\(\)|current_timestamp)\)$/i.test(v)
  )
    return 'utc_timestamp()'
  const quoted = /^'([\s\S]*)'$/.exec(v)
  if (quoted) {
    const text = quoted[1].replace(/''/g, "'")
    return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\+00(:00)?$/.test(text)
      ? text.replace(/\+00(:00)?$/, '')
      : text
  }
  return v
}
