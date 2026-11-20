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
// The app binds timestamps as ISO-8601 text ('2026-12-01T10:00:00.000Z', `toISOString()`) all
// over. MySQL 8.0.19+ reads the zone and stores the UTC instant (sessions run in UTC). MariaDB
// has no zone syntax in datetime literals: a write refuses it ("Incorrect datetime value", strict
// mode) and a comparison truncates it with a warning (silently wrong for a non-zero offset). So on
// a MariaDB pool, a binding that is EXACTLY one zoned ISO timestamp is sent as its UTC wall time
// ('2026-12-01 10:00:00.000') — the same instant, in the form MariaDB reads for DATETIME /
// TIMESTAMP columns. Nothing else changes; MySQL / SQL Server / Postgres bindings are untouched.
// Trade-off: the same text bound to a TEXT column is stored without its 'Z' (still UTC).
const ZONED_ISO =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/

/** A zoned ISO timestamp as MariaDB's UTC literal text; any other value unchanged. */
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

let bindingsPatched = false
/**
 * Patch knex's MySQL client once so a MariaDB-marked pool (and its transactions, which share the
 * config) sends zoned ISO timestamps as UTC literal text. A no-op for every other pool.
 */
export function mariaDbBindingCompat(): void {
  if (bindingsPatched) return
  bindingsPatched = true
  // biome-ignore lint/suspicious/noExplicitAny: knex's dialect classes are untyped
  const MySQLClient = require('knex/lib/dialects/mysql/index.js') as any
  const base = MySQLClient.prototype.prepBindings
  MySQLClient.prototype.prepBindings = function (this: any, bindings: unknown) {
    const out = base.call(this, bindings)
    if (this.config?.[MYSQL_FLAVOR_KEY] !== 'mariadb' || !Array.isArray(out)) return out
    return out.map(mariaDbBinding)
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
