// SQL Server provisioner (plan decision 2): CREATE DATABASE … COLLATE, READ_COMMITTED_SNAPSHOT,
// CREATE LOGIN … CHECK_POLICY = ON, a database user for the login and db_owner — nothing
// server-wide. Names are isDbIdentifier-checked and bracket-quoted; the password is bound and
// turned into a literal by QUOTENAME inside dynamic SQL, so it never sits in the SQL text.
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
  unreachableCheck
} from './provision-common.js'

const DEFAULT_COLLATION = 'SQL_Latin1_General_CP1_CI_AS'
const MIN_MAJOR = 15 // SQL Server 2019
// Azure SQL Database (5) and Azure SQL Managed Instance (8) report 12.x and are always current.
const AZURE_EDITIONS = new Set([5, 8])
const AZURE_TEXT: Record<number, string> = {
  5: 'Azure SQL Database: use manual mode',
  8: 'Azure SQL Managed Instance: use manual mode'
}

/** [name]; names are isDbIdentifier already, the doubling is belt and braces. */
const q = (name: string) => `[${name.replace(/]/g, ']]')}]`

async function dbRow(k: Knex, name: string) {
  const rows = await run<{ rcsi: unknown }>(
    k,
    'SELECT is_read_committed_snapshot_on AS rcsi FROM sys.databases WHERE name = ?',
    [name]
  )
  return rows[0] ?? null
}

async function loginRow(k: Knex, login: string): Promise<boolean> {
  const rows = await run(k, 'SELECT 1 AS x FROM sys.server_principals WHERE name = ?', [login])
  return rows.length > 0
}

const on = (v: unknown) => v === true || v === 1 || v === '1'

export const mssqlProvisioner: Provisioner = {
  engine: 'mssql',

  async probe(admin: Knex): Promise<ServerProbe> {
    let row: Record<string, unknown> | undefined
    try {
      const res = await run(
        admin,
        "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS v, CAST(SERVERPROPERTY('EngineEdition') AS int) AS edition, HAS_PERMS_BY_NAME(NULL, NULL, 'CREATE ANY DATABASE') AS can_db, HAS_PERMS_BY_NAME(NULL, NULL, 'ALTER ANY LOGIN') AS can_login"
      )
      row = res[0]
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
    const edition = num(row?.edition)
    if (AZURE_EDITIONS.has(edition))
      return {
        ok: true,
        version,
        can_create: false,
        missing: [],
        text: AZURE_TEXT[edition]
      }
    const major = Number(/^(\d+)/.exec(version ?? '')?.[1] ?? 0)
    if (major < MIN_MAJOR)
      return {
        ok: false,
        version,
        can_create: false,
        missing: [],
        text: `SQL Server ${version ?? '(unknown version)'} is older than SQL Server 2019 (15), the oldest release Nivaro supports.`
      }
    const missing: string[] = []
    if (num(row?.can_db) !== 1) missing.push('CREATE ANY DATABASE')
    if (num(row?.can_login) !== 1) missing.push('ALTER ANY LOGIN')
    return {
      ok: true,
      version,
      can_create: missing.length === 0,
      missing,
      text: missing.length
        ? `The provisioning login lacks ${missing.join(' and ')}.`
        : `SQL Server ${version}: can create databases and logins.`
    }
  },

  async databaseExists(admin, name) {
    assertDbName('mssql', name)
    return (await dbRow(admin, name)) !== null
  },

  async loginExists(admin, login) {
    assertLoginName('mssql', login)
    return loginRow(admin, login)
  },

  async ensureLogin(admin, login, password, opts: EnsureLoginOptions = {}) {
    assertLoginName('mssql', login)
    assertPassword(password)
    const secrets = { passwords: [password], logins: [login] }
    // QUOTENAME answers NULL past 128 characters: never EXEC a NULL (or truncated) statement.
    const quoted = (stmt: string, tail: string) =>
      `DECLARE @sql nvarchar(max) = N'${stmt} WITH PASSWORD = ' + QUOTENAME(?, N'''')${tail}; IF @sql IS NULL THROW 50000, N'The password could not be quoted', 1; EXEC (@sql)`
    if (await loginRow(admin, login)) {
      if (!opts.ownedLogin)
        throw new ProvisionError(
          'LOGIN_EXISTS',
          'A login with this name already exists on the server and was not made by this creation'
        )
      await run(admin, quoted(`ALTER LOGIN ${q(login)}`, ''), [password], secrets)
      return 'updated'
    }
    await run(
      admin,
      quoted(`CREATE LOGIN ${q(login)}`, " + N', CHECK_POLICY = ON, CHECK_EXPIRATION = OFF'"),
      [password],
      secrets
    )
    return 'created'
  },

  async ensureDatabase(admin, name, opts) {
    assertDbName('mssql', name)
    assertLoginName('mssql', opts.owner)
    const collation = opts.collation ?? DEFAULT_COLLATION
    assertCollation(collation)
    // An existing database is never written to here; RCSI is switched on in ensureOwner.
    if (await dbRow(admin, name)) {
      if (!opts.ownedDatabase) refuseExistingDatabase()
      return 'existed'
    }
    await run(admin, `CREATE DATABASE ${q(name)} COLLATE ${collation}`)
    return 'created'
  },

  async ensureOwner(admin, name, login, opts) {
    assertDbName('mssql', name)
    assertLoginName('mssql', login)
    assertOwnedDatabase(opts)
    const row = await dbRow(admin, name)
    if (!row) throw new ProvisionError('DB_ERROR', 'The database does not exist on the server')
    if (!on(row.rcsi)) await run(admin, `ALTER DATABASE ${q(name)} SET READ_COMMITTED_SNAPSHOT ON`)
    // One batch: USE holds only inside it. The user is matched by name AND the login's SID, so a
    // retry never adds a second user; ALTER ROLE … ADD MEMBER is a no-op for a member.
    await run(
      admin,
      `USE ${q(name)}; IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = ? AND sid = SUSER_SID(?)) CREATE USER ${q(login)} FOR LOGIN ${q(login)}; ALTER ROLE db_owner ADD MEMBER ${q(login)};`,
      [login, login],
      { logins: [login] }
    )
  },

  async drop(admin, name, login, opts: DropOptions = {}) {
    assertDbName('mssql', name)
    if (login !== null) assertLoginName('mssql', login)
    if (opts.ownedDatabase && (await dbRow(admin, name)))
      // One batch, so no other session slips in between SINGLE_USER and DROP.
      await run(
        admin,
        `ALTER DATABASE ${q(name)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${q(name)};`
      )
    if (login !== null && opts.ownedLogin && (await loginRow(admin, login)))
      await run(admin, `DROP LOGIN ${q(login)}`, [], { logins: [login] })
  },

  async checkApp(app: Knex): Promise<DbCheck> {
    let row: Record<string, unknown> | undefined
    try {
      const res = await run(
        app,
        "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS v, CAST(SERVERPROPERTY('EngineEdition') AS int) AS edition, IS_ROLEMEMBER('db_owner') AS owner, (SELECT COUNT(*) FROM sys.tables WHERE is_ms_shipped = 0) AS tables, OBJECT_ID(N'nivaro_migrations', N'U') AS ledger"
      )
      row = res[0]
    } catch (err) {
      return unreachableCheck(app, err)
    }
    const version = row?.v != null ? String(row.v) : null
    const major = Number(/^(\d+)/.exec(version ?? '')?.[1] ?? 0)
    if (!AZURE_EDITIONS.has(num(row?.edition)) && major < MIN_MAJOR)
      return check(
        'too_old',
        `SQL Server ${version ?? '(unknown version)'} is older than SQL Server 2019 (15), the oldest release Nivaro supports.`,
        { version }
      )
    if (num(row?.owner) !== 1)
      return check(
        'no_rights',
        'Connected, but the login is not a member of db_owner in this database.',
        { version }
      )
    if (row?.ledger == null) return contentCheck(version ?? '', num(row?.tables), null)
    try {
      const [l] = await run(
        app,
        'SELECT (SELECT COUNT(*) FROM nivaro_migrations) AS n, (SELECT TOP 1 name FROM nivaro_migrations ORDER BY id DESC) AS last'
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
