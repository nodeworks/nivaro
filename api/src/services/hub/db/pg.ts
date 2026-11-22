// Postgres provisioner (plan decision 2): CREATE ROLE … LOGIN PASSWORD, GRANT <role> TO
// CURRENT_USER (Postgres 16 lets a CREATEROLE user create a database owned by a role only as a
// member of it; superusers and older servers may refuse or not need it, so its error is
// ignored), CREATE DATABASE … OWNER … ENCODING 'UTF8' TEMPLATE template0, REVOKE CONNECT FROM
// PUBLIC. Postgres DDL cannot take parameters: names are isDbIdentifier-checked and
// double-quoted, the password is assertPassword-checked and written as an escaped literal.
import type { Knex } from 'knex'
import {
  assertCollation,
  assertDbName,
  assertLoginName,
  assertPassword,
  check,
  contentCheck,
  type DbCheck,
  type EnsureLoginOptions,
  num,
  ProvisionError,
  type Provisioner,
  run,
  type ServerProbe,
  scrubbed,
  truthy,
  unreachableCheck
} from './provision-common.js'

const MIN_VERSION_NUM = 140000

const q = (name: string) => `"${name.replace(/"/g, '""')}"`
/** A standard_conforming_strings literal: only the quote needs doubling. */
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`

async function roleExists(k: Knex, login: string): Promise<boolean> {
  return (await run(k, 'SELECT 1 AS x FROM pg_roles WHERE rolname = ?', [login])).length > 0
}

async function dbExists(k: Knex, name: string): Promise<boolean> {
  return (await run(k, 'SELECT 1 AS x FROM pg_database WHERE datname = ?', [name])).length > 0
}

/** Membership needed to hand a database to the role; refused or needless → ignored. */
async function grantToSelf(k: Knex, login: string): Promise<void> {
  try {
    await run(k, `GRANT ${q(login)} TO CURRENT_USER`, [], { logins: [login] })
  } catch {
    // superuser, an older server or a role already held: CREATE / ALTER below says if it matters
  }
}

export const pgProvisioner: Provisioner = {
  engine: 'pg',

  async probe(admin: Knex): Promise<ServerProbe> {
    let row: Record<string, unknown> | undefined
    try {
      ;[row] = await run(
        admin,
        "SELECT current_setting('server_version_num') AS num, current_setting('server_version') AS v, r.rolsuper AS super, r.rolcreatedb AS createdb, r.rolcreaterole AS createrole FROM pg_roles r WHERE r.rolname = current_user"
      )
    } catch (err) {
      return {
        ok: false,
        version: null,
        can_create: false,
        missing: [],
        text: `Could not connect: ${(err as Error).message}`
      }
    }
    const version = row?.v != null ? String(row.v) : null
    if (num(row?.num) < MIN_VERSION_NUM)
      return {
        ok: false,
        version,
        can_create: false,
        missing: [],
        text: `Postgres ${version ?? '(unknown version)'} is older than 14, the oldest release Nivaro supports.`
      }
    const missing: string[] = []
    if (!truthy(row?.super)) {
      if (!truthy(row?.createdb)) missing.push('CREATEDB')
      if (!truthy(row?.createrole)) missing.push('CREATEROLE')
    }
    return {
      ok: true,
      version,
      can_create: missing.length === 0,
      missing,
      text: missing.length
        ? `The provisioning role lacks ${missing.join(' and ')}.`
        : `Postgres ${version}: can create databases and roles.`
    }
  },

  async databaseExists(admin, name) {
    assertDbName('pg', name)
    return dbExists(admin, name)
  },

  async loginExists(admin, login) {
    assertLoginName('pg', login)
    return roleExists(admin, login)
  },

  async ensureLogin(admin, login, password, opts: EnsureLoginOptions = {}) {
    assertLoginName('pg', login)
    assertPassword(password)
    const secrets = { passwords: [password], logins: [login] }
    if (await roleExists(admin, login)) {
      if (!opts.ownedLogin)
        throw new ProvisionError(
          'LOGIN_EXISTS',
          'A role with this name already exists on the server and does not belong to this database'
        )
      await run(admin, `ALTER ROLE ${q(login)} WITH LOGIN PASSWORD ${lit(password)}`, [], secrets)
      return 'updated'
    }
    await run(admin, `CREATE ROLE ${q(login)} WITH LOGIN PASSWORD ${lit(password)}`, [], secrets)
    return 'created'
  },

  async ensureDatabase(admin, name, opts) {
    assertDbName('pg', name)
    assertLoginName('pg', opts.owner)
    // The collation setting is SQL Server's; a value is still never allowed to be hostile.
    if (opts.collation != null) assertCollation(opts.collation)
    if (await dbExists(admin, name)) return 'existed'
    await grantToSelf(admin, opts.owner)
    await run(
      admin,
      `CREATE DATABASE ${q(name)} OWNER ${q(opts.owner)} ENCODING 'UTF8' TEMPLATE template0`,
      [],
      { logins: [opts.owner] }
    )
    await run(admin, `REVOKE CONNECT ON DATABASE ${q(name)} FROM PUBLIC`)
    return 'created'
  },

  async ensureOwner(admin, name, login) {
    assertDbName('pg', name)
    assertLoginName('pg', login)
    await grantToSelf(admin, login)
    await run(admin, `ALTER DATABASE ${q(name)} OWNER TO ${q(login)}`, [], { logins: [login] })
    // Again here, so a retry after CREATE succeeded finishes the job.
    await run(admin, `REVOKE CONNECT ON DATABASE ${q(name)} FROM PUBLIC`)
  },

  async drop(admin, name, login) {
    assertDbName('pg', name)
    if (login !== null) assertLoginName('pg', login)
    await run(admin, `DROP DATABASE IF EXISTS ${q(name)} WITH (FORCE)`)
    if (login !== null) await run(admin, `DROP ROLE IF EXISTS ${q(login)}`, [], { logins: [login] })
  },

  async checkApp(app: Knex): Promise<DbCheck> {
    let row: Record<string, unknown> | undefined
    try {
      ;[row] = await run(
        app,
        "SELECT current_setting('server_version_num') AS num, current_setting('server_version') AS v, pg_catalog.pg_has_role(current_user, d.datdba, 'MEMBER') AS owner, CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'public') THEN has_schema_privilege('public', 'CREATE') ELSE false END AS can_create, (SELECT COUNT(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')) AS tables, to_regclass('nivaro_migrations') IS NOT NULL AS ledger FROM pg_catalog.pg_database d WHERE d.datname = current_database()"
      )
    } catch (err) {
      return unreachableCheck(app, err)
    }
    const version = row?.v != null ? String(row.v) : null
    if (num(row?.num) < MIN_VERSION_NUM)
      return check(
        'too_old',
        `Postgres ${version ?? '(unknown version)'} is older than 14, the oldest release Nivaro supports.`,
        { version }
      )
    if (!truthy(row?.owner) && !truthy(row?.can_create))
      return check(
        'no_rights',
        'Connected, but the login neither owns this database nor may create tables in schema public.',
        { version }
      )
    if (!truthy(row?.ledger)) return contentCheck(version ?? '', num(row?.tables), null)
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
