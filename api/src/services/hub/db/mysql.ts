// MySQL and MariaDB provisioner (plan decision 2): CREATE DATABASE … CHARACTER SET utf8mb4
// (MySQL utf8mb4_0900_ai_ci, MariaDB utf8mb4_unicode_ci), CREATE USER '<login>'@'<user_host>'
// and GRANT ALL PRIVILEGES on that one database. The login, host and password are bound (mysql2
// escapes them as string literals); the database name is isDbIdentifier-checked and backquoted,
// and in GRANT it goes through mysqlGrantDb so `_` and `%` are literal, not wildcards (a grant on
// `nivaro_a_b` would otherwise also cover `nivaroXaYb`).
import type { Knex } from 'knex'
import type { HubDbEngine } from './connection.js'
import { mysqlGrantDb } from './names.js'
import {
  assertCollation,
  assertDbName,
  assertLoginName,
  assertOwnedDatabase,
  assertPassword,
  assertUserHost,
  check,
  contentCheck,
  type DbCheck,
  type DropOptions,
  type EnsureLoginOptions,
  num,
  ProvisionError,
  type Provisioner,
  refuseExistingDatabase,
  run as runStatement,
  type Secrets,
  type ServerProbe,
  scrubbed,
  unreachableCheck,
  versionBelow
} from './provision-common.js'

type Flavor = 'mysql2' | 'mariadb'

// Every statement is killed (KILL QUERY on a separate raw connection) if it outlives this:
// MySQL's max_execution_time covers SELECTs only, so DDL needs the client-side bound.
const STATEMENT_MS = 120_000

const run = <T = Record<string, unknown>>(
  k: Knex,
  sql: string,
  bindings: readonly unknown[] = [],
  secrets: Secrets = {}
) => runStatement<T>(k, sql, bindings, secrets, { timeoutMs: STATEMENT_MS })

const FLOOR: Record<Flavor, readonly [number, number, number]> = {
  mysql2: [8, 0, 13],
  mariadb: [10, 11, 0]
}
const LABEL: Record<Flavor, string> = { mysql2: 'MySQL', mariadb: 'MariaDB' }
const COLLATION: Record<Flavor, string> = {
  mysql2: 'utf8mb4_0900_ai_ci',
  mariadb: 'utf8mb4_unicode_ci'
}

const q = (name: string) => `\`${name.replace(/`/g, '``')}\``

// ─── SHOW GRANTS ─────────────────────────────────────────────────────────────

export interface GrantLine {
  privileges: Set<string>
  /** `*.*`, or the database pattern as written (backquotes removed, escapes kept). */
  on: string
  grantOption: boolean
}

/** Grant lines with an ON clause; role grants (`GRANT r TO u`) and PROXY are skipped. */
export function parseGrants(lines: string[]): GrantLine[] {
  const out: GrantLine[] = []
  for (const raw of lines) {
    const line = raw.trim()
    const m =
      /^GRANT\s+(.+?)\s+ON\s+(?:(?:TABLE|FUNCTION|PROCEDURE)\s+)?((?:`(?:[^`]|``)*`|[^\s.`]+)\.(?:`(?:[^`]|``)*`|\*|[^\s`]+))\s+TO\s+/i.exec(
        line
      )
    if (!m) continue
    const privs = new Set(
      m[1]
        .split(',')
        .map((p) =>
          p
            .replace(/\(.*\)/, '')
            .trim()
            .toUpperCase()
        )
        .filter(Boolean)
    )
    if (privs.has('PROXY')) continue
    const [dbPart, objPart] = splitTarget(m[2])
    // Table- or routine-level grants say nothing about creating tables in the database.
    if (objPart !== '*') continue
    out.push({
      privileges: privs,
      on: dbPart === '*' ? '*.*' : dbPart,
      grantOption: /\bWITH\s+GRANT\s+OPTION\s*$/i.test(line) || privs.has('GRANT OPTION')
    })
  }
  return out
}

function splitTarget(t: string): [string, string] {
  const unq = (s: string) => (s.startsWith('`') ? s.slice(1, -1).replace(/``/g, '`') : s)
  const m = /^(`(?:[^`]|``)*`|[^.]+)\.(.+)$/.exec(t)
  if (!m) return [t, '']
  return [unq(m[1]), unq(m[2])]
}

/** A grant's database pattern against a name: `\_` / `\%` literal, `_` / `%` wildcards. */
export function grantCovers(pattern: string, name: string): boolean {
  if (pattern === '*.*') return true
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\' && i + 1 < pattern.length) {
      re += escapeRe(pattern[++i])
    } else if (c === '_') re += '.'
    else if (c === '%') re += '.*'
    else re += escapeRe(c)
  }
  return new RegExp(`^${re}$`, 'i').test(name)
}

const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

const holdsAll = (g: GrantLine) => g.privileges.has('ALL PRIVILEGES') || g.privileges.has('ALL')

/** Static privileges are words (SELECT, CREATE USER); dynamic ones are FOO_ADMIN names. */
const holdsStatic = (g: GrantLine) =>
  holdsAll(g) || [...g.privileges].some((p) => p !== 'USAGE' && !p.includes('_'))

async function showGrants(k: Knex): Promise<GrantLine[]> {
  const rows = await run<Record<string, unknown>>(k, 'SHOW GRANTS')
  return parseGrants(rows.map((r) => String(Object.values(r)[0] ?? '')))
}

/** Plan decision 5: ALL, or CREATE + ALTER + INDEX + DROP on this database (or on *.*). */
export function appHasRights(grants: GrantLine[], db: string): boolean {
  const covering = grants.filter((g) => g.on === '*.*' || grantCovers(g.on, db))
  if (covering.some(holdsAll)) return true
  const held = new Set(covering.flatMap((g) => [...g.privileges]))
  return ['CREATE', 'ALTER', 'INDEX', 'DROP'].every((p) => held.has(p))
}

// What GRANT ALL PRIVILEGES ON <db>.* hands over. The server refuses that GRANT unless the
// granting login holds every one of them itself (globally: the database is new), so a login
// with only CREATE + CREATE USER + GRANT OPTION cannot provision (proved on MySQL 8.4).
const DB_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'DROP',
  'REFERENCES',
  'INDEX',
  'ALTER',
  'CREATE TEMPORARY TABLES',
  'LOCK TABLES',
  'EXECUTE',
  'CREATE VIEW',
  'SHOW VIEW',
  'CREATE ROUTINE',
  'ALTER ROUTINE',
  'EVENT',
  'TRIGGER'
]

/** Global privileges a provisioning login needs besides GRANT OPTION, in the order named. */
export function provisionRights(flavor: Flavor, version: string): string[] {
  const list = ['CREATE USER', ...DB_PRIVILEGES]
  if (flavor === 'mariadb') {
    list.push('DELETE HISTORY')
    if (!versionBelow(version, [11, 3, 0])) list.push('SHOW CREATE ROUTINE')
  }
  return list
}

/** Why the server cannot be used as this flavour, or null. */
function flavorProblem(flavor: Flavor, version: string): string | null {
  const maria = /mariadb/i.test(version)
  const v = version.replace(/-.*$/, '')
  if (maria && flavor === 'mysql2')
    return `The server is MariaDB (${v}), not MySQL. Set this server's engine to MariaDB.`
  if (!maria && flavor === 'mariadb')
    return `The server is MySQL (${v}), not MariaDB. Set this server's engine to MySQL.`
  if (versionBelow(version, FLOOR[flavor]))
    return `${LABEL[flavor]} ${v} is older than ${FLOOR[flavor].join('.').replace(/\.0$/, '')}, the oldest release Nivaro supports.`
  return null
}

export function mysqlProvisioner(flavor: Flavor, userHost: string | null = null): Provisioner {
  const host = userHost ?? '%'
  assertUserHost(host)
  const engine: HubDbEngine = flavor

  async function schemaExists(k: Knex, name: string): Promise<boolean> {
    const rows = await run(
      k,
      'SELECT 1 AS x FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [name]
    )
    return rows.length > 0
  }

  async function userHosts(k: Knex, login: string): Promise<string[]> {
    const rows = await run<{ h: unknown }>(k, 'SELECT Host AS h FROM mysql.user WHERE User = ?', [
      login
    ])
    return rows.map((r) => String(r.h))
  }

  return {
    engine,

    async probe(admin: Knex): Promise<ServerProbe> {
      let version: string | null = null
      try {
        const [row] = await run<{ v: unknown }>(admin, 'SELECT VERSION() AS v')
        version = row?.v != null ? String(row.v) : null
        const problem = flavorProblem(flavor, version ?? '')
        if (problem) return { ok: false, version, can_create: false, missing: [], text: problem }
        const grants = (await showGrants(admin)).filter((g) => g.on === '*.*')
        // ALL on *.*, or CREATE USER + every privilege GRANT ALL ON <db>.* hands over (global
        // SELECT also covers the mysql.user read in loginExists) — and GRANT OPTION either way.
        const missing: string[] = []
        if (!grants.some(holdsAll)) {
          const held = new Set(grants.flatMap((g) => [...g.privileges]))
          for (const p of provisionRights(flavor, version ?? '')) if (!held.has(p)) missing.push(p)
        }
        // GRANT OPTION counts only on the line that holds the static privileges: MySQL 8 lists
        // dynamic privileges (FOO_ADMIN) on a line of their own, whose WITH GRANT OPTION covers
        // those alone.
        if (!grants.some((g) => g.grantOption && holdsStatic(g))) missing.push('GRANT OPTION')
        return {
          ok: true,
          version,
          can_create: missing.length === 0,
          missing,
          text: missing.length
            ? `The provisioning login lacks ${missing.join(', ')} on *.*.`
            : `${LABEL[flavor]} ${version}: can create databases and logins.`
        }
      } catch (err) {
        return {
          ok: false,
          version,
          can_create: false,
          missing: [],
          text: `Could not connect: ${(err as Error).message}`
        }
      }
    },

    async databaseExists(admin, name) {
      assertDbName(engine, name)
      return schemaExists(admin, name)
    },

    async loginExists(admin, login) {
      assertLoginName(engine, login)
      return (await userHosts(admin, login)).length > 0
    },

    async ensureLogin(admin, login, password, opts: EnsureLoginOptions = {}) {
      assertLoginName(engine, login)
      assertPassword(password)
      const secrets = { passwords: [password], logins: [login] }
      // An account with this user name at ANY host counts: it may be another app's.
      const hosts = await userHosts(admin, login)
      if (hosts.length > 0 && !opts.ownedLogin)
        throw new ProvisionError(
          'LOGIN_EXISTS',
          'A login with this name already exists on the server and was not made by this creation'
        )
      if (hosts.includes(host)) {
        await run(admin, 'ALTER USER ?@? IDENTIFIED BY ?', [login, host, password], secrets)
        return 'updated'
      }
      await run(admin, 'CREATE USER ?@? IDENTIFIED BY ?', [login, host, password], secrets)
      return 'created'
    },

    async ensureDatabase(admin, name, opts) {
      assertDbName(engine, name)
      assertLoginName(engine, opts.owner)
      // The collation setting is SQL Server's; a value is still never allowed to be hostile.
      if (opts.collation != null) assertCollation(opts.collation)
      if (await schemaExists(admin, name)) {
        if (!opts.ownedDatabase) refuseExistingDatabase()
        return 'existed'
      }
      await run(
        admin,
        `CREATE DATABASE ${q(name)} CHARACTER SET utf8mb4 COLLATE ${COLLATION[flavor]}`
      )
      return 'created'
    },

    async ensureOwner(admin, name, login, opts) {
      assertDbName(engine, name)
      assertLoginName(engine, login)
      assertOwnedDatabase(opts)
      await run(admin, `GRANT ALL PRIVILEGES ON ${mysqlGrantDb(name)}.* TO ?@?`, [login, host], {
        logins: [login]
      })
    },

    async drop(admin, name, login, opts: DropOptions = {}) {
      assertDbName(engine, name)
      if (login !== null) assertLoginName(engine, login)
      if (opts.ownedDatabase) await run(admin, `DROP DATABASE IF EXISTS ${q(name)}`)
      if (login !== null && opts.ownedLogin)
        await run(admin, 'DROP USER IF EXISTS ?@?', [login, host], {
          logins: [login]
        })
    },

    async checkApp(app: Knex): Promise<DbCheck> {
      let row: Record<string, unknown> | undefined
      let grants: GrantLine[]
      try {
        ;[row] = await run(
          app,
          "SELECT VERSION() AS v, DATABASE() AS d, (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()) AS tables, (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nivaro_migrations') AS ledger"
        )
      } catch (err) {
        return unreachableCheck(app, err)
      }
      const version = row?.v != null ? String(row.v) : null
      const problem = flavorProblem(flavor, version ?? '')
      if (problem) return check('too_old', problem, { version })
      try {
        grants = await showGrants(app)
      } catch (err) {
        return check('no_rights', `Connected, but SHOW GRANTS failed: ${scrubbed(app, err)}`, {
          version
        })
      }
      if (!appHasRights(grants, String(row?.d ?? '')))
        return check(
          'no_rights',
          'Connected, but the login holds neither ALL nor CREATE, ALTER, INDEX and DROP on this database.',
          { version }
        )
      if (num(row?.ledger) === 0) return contentCheck(version ?? '', num(row?.tables), null)
      try {
        const [l] = await run(
          app,
          'SELECT (SELECT COUNT(*) FROM nivaro_migrations) AS n, (SELECT name FROM nivaro_migrations ORDER BY id DESC LIMIT 1) AS last'
        )
        return contentCheck(version ?? '', num(row?.tables), {
          count: num(l?.n),
          last: l?.last != null ? String(l.last) : null
        })
      } catch (err) {
        return check(
          'no_rights',
          `Connected, but the migration ledger cannot be read: ${scrubbed(app, err)}`,
          { version }
        )
      }
    }
  }
}
