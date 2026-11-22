// Postgres provisioner (plan decision 2): CREATE ROLE … LOGIN PASSWORD '<verifier>', GRANT <role> TO
// CURRENT_USER (Postgres 16 lets a CREATEROLE user create a database owned by a role only as a
// member of it; superusers and older servers may refuse or not need it, so its error is
// ignored), CREATE DATABASE … OWNER … ENCODING 'UTF8' TEMPLATE template0; ensureOwner: OWNER TO
// and REVOKE CONNECT FROM PUBLIC. Postgres DDL cannot take parameters: names are isDbIdentifier-checked and
// double-quoted. The password itself never reaches the statement text (ruling P3-32): a failing
// CREATE/ALTER ROLE is written to the server's log with its text (log_min_error_statement), and
// log_statement = ddl logs every one. The role gets a SCRAM-SHA-256 verifier computed here, which
// Postgres stores as it is; only the verifier can ever reach a log.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import type { Knex } from 'knex'
import {
  assertCollation,
  assertDbName,
  assertLoginName,
  assertOwnedDatabase,
  assertPassword,
  check,
  contentCheck,
  type DbCheck,
  type DropOptions,
  type EnsureLoginOptions,
  num,
  ProvisionError,
  type Provisioner,
  refuseExistingDatabase,
  run,
  type ServerProbe,
  scrubbed,
  truthy,
  unreachableCheck
} from './provision-common.js'

const MIN_VERSION_NUM = 140000

const q = (name: string) => `"${name.replace(/"/g, '""')}"`
/**
 * A string literal: here only the SCRAM verifier (base64, `$`, `:` and digits — no quote and no
 * backslash, so neither standard_conforming_strings nor E'' escapes can change its meaning).
 * The quote doubling is belt and braces.
 */
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`

/** Postgres' own default iteration count for SCRAM-SHA-256 (scram_iterations). */
export const SCRAM_ITERATIONS = 4096

/**
 * The SCRAM-SHA-256 verifier Postgres keeps for a password (RFC 5802 / 7677, Postgres'
 * `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`, base64). Postgres stores a
 * password in this shape as it is (already hashed). The password is ASCII (assertPassword), so
 * SASLprep leaves it unchanged. `salt` is for tests; a real role gets 16 random bytes.
 */
export function scramVerifier(
  password: string,
  salt: Buffer = randomBytes(16),
  iterations = SCRAM_ITERATIONS
): string {
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', salted).update('Server Key').digest()
  const b64 = (b: Buffer) => b.toString('base64')
  return `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`
}

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
          'A role with this name already exists on the server and was not made by this creation'
        )
      await run(
        admin,
        `ALTER ROLE ${q(login)} WITH LOGIN PASSWORD ${lit(scramVerifier(password))}`,
        [],
        secrets
      )
      return 'updated'
    }
    await run(
      admin,
      `CREATE ROLE ${q(login)} WITH LOGIN PASSWORD ${lit(scramVerifier(password))}`,
      [],
      secrets
    )
    return 'created'
  },

  async ensureDatabase(admin, name, opts) {
    assertDbName('pg', name)
    assertLoginName('pg', opts.owner)
    // The collation setting is SQL Server's; a value is still never allowed to be hostile.
    if (opts.collation != null) assertCollation(opts.collation)
    // An existing database is never written to here; OWNER TO + REVOKE live in ensureOwner.
    if (await dbExists(admin, name)) {
      if (!opts.ownedDatabase) refuseExistingDatabase()
      return 'existed'
    }
    await grantToSelf(admin, opts.owner)
    await run(
      admin,
      `CREATE DATABASE ${q(name)} OWNER ${q(opts.owner)} ENCODING 'UTF8' TEMPLATE template0`,
      [],
      { logins: [opts.owner] }
    )
    return 'created'
  },

  async ensureOwner(admin, name, login, opts) {
    assertDbName('pg', name)
    assertLoginName('pg', login)
    assertOwnedDatabase(opts)
    await grantToSelf(admin, login)
    await run(admin, `ALTER DATABASE ${q(name)} OWNER TO ${q(login)}`, [], { logins: [login] })
    await run(admin, `REVOKE CONNECT ON DATABASE ${q(name)} FROM PUBLIC`)
  },

  async drop(admin, name, login, opts: DropOptions = {}) {
    assertDbName('pg', name)
    if (login !== null) assertLoginName('pg', login)
    if (opts.ownedDatabase) {
      // Belt and braces on top of the marker: the database must still belong to the login.
      const [row] = await run<{ owner: unknown }>(
        admin,
        'SELECT pg_catalog.pg_get_userbyid(datdba) AS owner FROM pg_catalog.pg_database WHERE datname = ?',
        [name]
      )
      if (row) {
        if (login === null || String(row.owner) !== login)
          throw new ProvisionError(
            'NOT_OWNED',
            'The database is not owned by this creation’s login: not dropped'
          )
        await run(admin, `DROP DATABASE IF EXISTS ${q(name)} WITH (FORCE)`)
      }
    }
    if (login !== null && opts.ownedLogin)
      await run(admin, `DROP ROLE IF EXISTS ${q(login)}`, [], { logins: [login] })
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
