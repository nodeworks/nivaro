// Hub database provisioners (phase 3 task 3): exact SQL per engine against a fake knex that
// records every raw statement and answers from a script. No database is reached.
import type { Knex } from 'knex'
import { describe, expect, it } from 'vitest'
import {
  isCollation,
  isUserHost,
  ProvisionError,
  provisionerFor,
  rememberSecrets,
  withServerKnex
} from '../../../services/hub/db/provisioner.js'

type Call = { sql: string; bindings: unknown[] }
type Rule = [RegExp, unknown | ((b: unknown[]) => unknown)]

/**
 * A knex whose raw() records the call and answers the first matching rule (else no rows). The
 * answer is a promise with knex's `.timeout(ms, opts)`, recorded per statement in `timeouts`.
 */
function fake(rules: Rule[] = []) {
  const calls: Call[] = []
  const timeouts: Array<{ sql: string; ms: number; cancel: boolean } | null> = []
  const k = {
    raw: (sql: string, bindings: unknown[] = []) => {
      calls.push({ sql, bindings })
      const i = timeouts.push(null) - 1
      const p = (async () => {
        for (const [re, answer] of rules) {
          if (!re.test(sql)) continue
          const a =
            typeof answer === 'function' ? (answer as (b: unknown[]) => unknown)(bindings) : answer
          if (a instanceof Error) throw a
          return a
        }
        return []
      })()
      return Object.assign(p, {
        timeout(ms: number, o: { cancel?: boolean } = {}) {
          timeouts[i] = { sql, ms, cancel: o.cancel === true }
          return p
        }
      })
    }
  }
  return { k: k as unknown as Knex, calls, timeouts, sqls: () => calls.map((c) => c.sql) }
}

/** A database that does not exist until this fake sees CREATE DATABASE. */
function madeOnCreate(row: Record<string, unknown>): Rule[] {
  let made = false
  return [
    [
      /^CREATE DATABASE/,
      () => {
        made = true
        return []
      }
    ],
    [/sys\.databases|pg_database|SCHEMATA/, () => (made ? [[row], []] : [])]
  ]
}

const OWNED = { ownedDatabase: true }
const OWNED_ALL = { ownedDatabase: true, ownedLogin: true }

const PW = 'Abc123-_.~xyzXYZ0987654321abcdEF'
const LOGIN = 'shop_staging'
const DB = 'nivaro_shop_staging'
const LOGIN_TOKEN = /(?<![A-Za-z0-9_])shop_staging(?![A-Za-z0-9_])/

async function refusal(p: Promise<unknown>): Promise<ProvisionError> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(ProvisionError)
    return err as ProvisionError
  }
  throw new Error('expected a refusal')
}

// ─── SQL Server ──────────────────────────────────────────────────────────────

describe('mssql provisioner', () => {
  const p = provisionerFor('mssql')

  const CREATE_LOGIN =
    "DECLARE @sql nvarchar(max) = N'CREATE LOGIN [shop_staging] WITH PASSWORD = ' + QUOTENAME(?, N'''') + N', CHECK_POLICY = ON, CHECK_EXPIRATION = OFF'; IF @sql IS NULL THROW 50000, N'The password could not be quoted', 1; EXEC (@sql)"

  it('fresh create: login, database (one CREATE each), owner (RCSI + user + db_owner)', async () => {
    const f = fake(madeOnCreate({ rcsi: false }))
    expect(await p.ensureLogin(f.k, LOGIN, PW)).toBe('created')
    expect(await p.ensureDatabase(f.k, DB, { collation: null, owner: LOGIN })).toBe('created')
    await p.ensureOwner(f.k, DB, LOGIN, OWNED)
    expect(f.calls).toEqual([
      {
        sql: 'SELECT 1 AS x FROM sys.server_principals WHERE name = ?',
        bindings: [LOGIN]
      },
      { sql: CREATE_LOGIN, bindings: [PW] },
      {
        sql: 'SELECT is_read_committed_snapshot_on AS rcsi FROM sys.databases WHERE name = ?',
        bindings: [DB]
      },
      {
        sql: 'CREATE DATABASE [nivaro_shop_staging] COLLATE SQL_Latin1_General_CP1_CI_AS',
        bindings: []
      },
      {
        sql: 'SELECT is_read_committed_snapshot_on AS rcsi FROM sys.databases WHERE name = ?',
        bindings: [DB]
      },
      { sql: 'ALTER DATABASE [nivaro_shop_staging] SET READ_COMMITTED_SNAPSHOT ON', bindings: [] },
      {
        sql: 'USE [nivaro_shop_staging]; IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = ? AND sid = SUSER_SID(?)) CREATE USER [shop_staging] FOR LOGIN [shop_staging]; ALTER ROLE db_owner ADD MEMBER [shop_staging];',
        bindings: [LOGIN, LOGIN]
      }
    ])
    // The password never reaches SQL text: it is bound. No statement carries a knex timeout.
    expect(f.sqls().join('\n')).not.toContain(PW)
    expect(f.timeouts.every((t) => t === null)).toBe(true)
  })

  it('uses the given collation', async () => {
    const f = fake()
    await p.ensureDatabase(f.k, DB, { collation: 'Latin1_General_100_CI_AS_SC_UTF8', owner: LOGIN })
    expect(f.sqls()[1]).toBe(
      'CREATE DATABASE [nivaro_shop_staging] COLLATE Latin1_General_100_CI_AS_SC_UTF8'
    )
  })

  it('an existing login is refused unless it is this creation’s own', async () => {
    const f = fake([[/server_principals/, [{ x: 1 }]]])
    const err = await refusal(p.ensureLogin(f.k, LOGIN, PW))
    expect(err.code).toBe('LOGIN_EXISTS')
    expect(f.calls).toHaveLength(1)

    const g = fake([[/server_principals/, [{ x: 1 }]]])
    expect(await p.ensureLogin(g.k, LOGIN, PW, { ownedLogin: true })).toBe('updated')
    expect(g.calls[1]).toEqual({
      sql: "DECLARE @sql nvarchar(max) = N'ALTER LOGIN [shop_staging] WITH PASSWORD = ' + QUOTENAME(?, N''''); IF @sql IS NULL THROW 50000, N'The password could not be quoted', 1; EXEC (@sql)",
      bindings: [PW]
    })
    expect(g.sqls().join('\n')).not.toMatch(/CREATE LOGIN/)
  })

  it('an existing database: DATABASE_EXISTS without the flag; with it existed, nothing written', async () => {
    const off = [[/sys\.databases/, [{ rcsi: false }]]] as Rule[]
    const a = fake(off)
    const err = await refusal(p.ensureDatabase(a.k, DB, { collation: null, owner: LOGIN }))
    expect(err.code).toBe('DATABASE_EXISTS')
    expect(a.calls).toHaveLength(1)

    // Even with RCSI off: ensureDatabase never writes to an existing database.
    const b = fake(off)
    expect(
      await p.ensureDatabase(b.k, DB, { collation: null, owner: LOGIN, ownedDatabase: true })
    ).toBe('existed')
    expect(b.calls).toHaveLength(1)
  })

  it('ensureOwner refuses without the ownership flag; RCSI left alone when already on', async () => {
    const f = fake([[/sys\.databases/, [{ rcsi: true }]]])
    expect((await refusal(p.ensureOwner(f.k, DB, LOGIN))).code).toBe('NOT_OWNED')
    expect((await refusal(p.ensureOwner(f.k, DB, LOGIN, {}))).code).toBe('NOT_OWNED')
    expect(f.calls).toHaveLength(0)
    await p.ensureOwner(f.k, DB, LOGIN, OWNED)
    expect(f.sqls().some((s) => s.includes('READ_COMMITTED_SNAPSHOT'))).toBe(false)
  })

  it('drop: only what the flags name; SINGLE_USER + DROP in one batch', async () => {
    const rules: Rule[] = [
      [/sys\.databases/, [{ rcsi: true }]],
      [/server_principals/, [{ x: 1 }]]
    ]
    const none = fake(rules)
    await p.drop(none.k, DB, LOGIN)
    await p.drop(none.k, DB, LOGIN, {})
    expect(none.calls).toHaveLength(0)

    const f = fake(rules)
    await p.drop(f.k, DB, LOGIN, OWNED_ALL)
    expect(f.sqls()).toEqual([
      'SELECT is_read_committed_snapshot_on AS rcsi FROM sys.databases WHERE name = ?',
      'ALTER DATABASE [nivaro_shop_staging] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [nivaro_shop_staging];',
      'SELECT 1 AS x FROM sys.server_principals WHERE name = ?',
      'DROP LOGIN [shop_staging]'
    ])

    const dbOnly = fake(rules)
    await p.drop(dbOnly.k, DB, LOGIN, { ownedDatabase: true })
    expect(dbOnly.sqls().some((s) => s.includes('LOGIN'))).toBe(false)
    const loginOnly = fake(rules)
    await p.drop(loginOnly.k, DB, LOGIN, { ownedLogin: true })
    expect(loginOnly.sqls().some((s) => s.includes('DATABASE'))).toBe(false)
  })

  it('probe: rights, too old, Azure SQL Database', async () => {
    const q = /HAS_PERMS_BY_NAME/
    const ok = await p.probe(
      fake([[q, [{ v: '16.0.4135.4', edition: 3, can_db: 1, can_login: 1 }]]]).k
    )
    expect(ok).toMatchObject({ ok: true, can_create: true, missing: [], version: '16.0.4135.4' })

    const noLogin = await p.probe(
      fake([[q, [{ v: '15.0.2000.5', edition: 2, can_db: 1, can_login: 0 }]]]).k
    )
    expect(noLogin.can_create).toBe(false)
    expect(noLogin.missing).toEqual(['ALTER ANY LOGIN'])
    expect(noLogin.text).toContain('ALTER ANY LOGIN')

    const old = await p.probe(
      fake([[q, [{ v: '14.0.3456.2', edition: 3, can_db: 1, can_login: 1 }]]]).k
    )
    expect(old).toMatchObject({ ok: false, can_create: false })
    expect(old.text).toMatch(/older than SQL Server 2019/)

    const azure = await p.probe(
      fake([[q, [{ v: '12.0.2000.8', edition: 5, can_db: null, can_login: null }]]]).k
    )
    expect(azure).toMatchObject({ ok: true, can_create: false })
    expect(azure.text).toBe('Azure SQL Database: use manual mode')
    const mi = await p.probe(
      fake([[q, [{ v: '12.0.2000.8', edition: 8, can_db: 1, can_login: 1 }]]]).k
    )
    expect(mi).toMatchObject({ ok: true, can_create: false })
    expect(mi.text).toBe('Azure SQL Managed Instance: use manual mode')

    const down = await p.probe(fake([[q, new Error('Failed to connect to db1:1433')]]).k)
    expect(down).toMatchObject({ ok: false, can_create: false, version: null })
  })

  it('checkApp classifies empty, nivaro, foreign, no rights, too old, unreachable', async () => {
    const info = (o: Record<string, unknown>): Rule => [
      /IS_ROLEMEMBER/,
      [{ v: '16.0.1000.6', edition: 3, owner: 1, tables: 0, ledger: null, ...o }]
    ]
    expect((await p.checkApp(fake([info({})]).k)).state).toBe('empty')

    const n = await p.checkApp(
      fake([
        info({ tables: 412, ledger: 901578 }),
        [/FROM nivaro_migrations/, [{ n: 543, last: '543_hub_promotions.ts' }]]
      ]).k
    )
    expect(n).toMatchObject({
      state: 'nivaro',
      ok: true,
      migrations: 543,
      last_migration: '543_hub_promotions.ts'
    })

    const foreign = await p.checkApp(fake([info({ tables: 3 })]).k)
    expect(foreign).toMatchObject({ state: 'foreign', ok: false })

    expect((await p.checkApp(fake([info({ owner: 0 })]).k)).state).toBe('no_rights')
    expect((await p.checkApp(fake([info({ v: '14.0.1.1' })]).k)).state).toBe('too_old')
    // Azure SQL Database reports 12.x and is always current.
    expect((await p.checkApp(fake([info({ v: '12.0.2000.8', edition: 5 })]).k)).state).toBe('empty')
    const down = await p.checkApp(fake([[/IS_ROLEMEMBER/, new Error('ETIMEOUT')]]).k)
    expect(down).toMatchObject({ state: 'unreachable', ok: false })
  })
})

// ─── Postgres ────────────────────────────────────────────────────────────────

describe('pg provisioner', () => {
  const p = provisionerFor('pg')

  it('fresh create: role, grant to self, database (one CREATE), owner + revoke connect', async () => {
    const f = fake()
    expect(await p.ensureLogin(f.k, LOGIN, PW)).toBe('created')
    expect(await p.ensureDatabase(f.k, DB, { collation: null, owner: LOGIN })).toBe('created')
    await p.ensureOwner(f.k, DB, LOGIN, OWNED)
    expect(f.calls).toEqual([
      { sql: 'SELECT 1 AS x FROM pg_roles WHERE rolname = ?', bindings: [LOGIN] },
      { sql: `CREATE ROLE "shop_staging" WITH LOGIN PASSWORD '${PW}'`, bindings: [] },
      { sql: 'SELECT 1 AS x FROM pg_database WHERE datname = ?', bindings: [DB] },
      { sql: 'GRANT "shop_staging" TO CURRENT_USER', bindings: [] },
      {
        sql: `CREATE DATABASE "nivaro_shop_staging" OWNER "shop_staging" ENCODING 'UTF8' TEMPLATE template0`,
        bindings: []
      },
      { sql: 'GRANT "shop_staging" TO CURRENT_USER', bindings: [] },
      { sql: 'ALTER DATABASE "nivaro_shop_staging" OWNER TO "shop_staging"', bindings: [] },
      { sql: 'REVOKE CONNECT ON DATABASE "nivaro_shop_staging" FROM PUBLIC', bindings: [] }
    ])
    expect(f.timeouts.every((t) => t === null)).toBe(true)
  })

  it('ignores an error from GRANT … TO CURRENT_USER', async () => {
    const f = fake([[/^GRANT/, new Error('permission denied to grant role "shop_staging"')]])
    expect(await p.ensureDatabase(f.k, DB, { collation: null, owner: LOGIN })).toBe('created')
    expect(f.sqls()).toContain(
      `CREATE DATABASE "nivaro_shop_staging" OWNER "shop_staging" ENCODING 'UTF8' TEMPLATE template0`
    )
    await p.ensureOwner(f.k, DB, LOGIN, OWNED)
  })

  it('existing role: refused, or ALTER ROLE when owned', async () => {
    const f = fake([[/pg_roles/, [{ x: 1 }]]])
    expect((await refusal(p.ensureLogin(f.k, LOGIN, PW))).code).toBe('LOGIN_EXISTS')
    const g = fake([[/pg_roles/, [{ x: 1 }]]])
    expect(await p.ensureLogin(g.k, LOGIN, PW, { ownedLogin: true })).toBe('updated')
    expect(g.sqls()[1]).toBe(`ALTER ROLE "shop_staging" WITH LOGIN PASSWORD '${PW}'`)
  })

  it('existing database: DATABASE_EXISTS without the flag; existed with it; no writes', async () => {
    const a = fake([[/pg_database/, [{ x: 1 }]]])
    expect((await refusal(p.ensureDatabase(a.k, DB, { collation: null, owner: LOGIN }))).code).toBe(
      'DATABASE_EXISTS'
    )
    expect(a.calls).toHaveLength(1)
    const b = fake([[/pg_database/, [{ x: 1 }]]])
    expect(await p.ensureDatabase(b.k, DB, { collation: null, owner: LOGIN, ...OWNED })).toBe(
      'existed'
    )
    expect(b.calls).toHaveLength(1)
  })

  it('ensureOwner refuses without the ownership flag', async () => {
    const f = fake()
    expect((await refusal(p.ensureOwner(f.k, DB, LOGIN))).code).toBe('NOT_OWNED')
    expect(f.calls).toHaveLength(0)
  })

  it('drop: only with the flags, and only a database the login owns', async () => {
    const owned = [[/datdba/, [{ owner: LOGIN }]]] as Rule[]
    const none = fake(owned)
    await p.drop(none.k, DB, LOGIN)
    expect(none.calls).toHaveLength(0)

    const f = fake(owned)
    await p.drop(f.k, DB, LOGIN, OWNED_ALL)
    expect(f.sqls()).toEqual([
      'SELECT pg_catalog.pg_get_userbyid(datdba) AS owner FROM pg_catalog.pg_database WHERE datname = ?',
      'DROP DATABASE IF EXISTS "nivaro_shop_staging" WITH (FORCE)',
      'DROP ROLE IF EXISTS "shop_staging"'
    ])

    // Owned by someone else: refused, nothing dropped (not even the login).
    const other = fake([[/datdba/, [{ owner: 'another_app' }]]])
    expect((await refusal(p.drop(other.k, DB, LOGIN, OWNED_ALL))).code).toBe('NOT_OWNED')
    expect(other.sqls().some((s) => s.startsWith('DROP'))).toBe(false)
    // No login to compare against: refused too.
    const nologin = fake(owned)
    expect((await refusal(p.drop(nologin.k, DB, null, OWNED))).code).toBe('NOT_OWNED')
    // Already gone: only the login goes.
    const gone = fake()
    await p.drop(gone.k, DB, LOGIN, OWNED_ALL)
    expect(gone.sqls()).toEqual([
      'SELECT pg_catalog.pg_get_userbyid(datdba) AS owner FROM pg_catalog.pg_database WHERE datname = ?',
      'DROP ROLE IF EXISTS "shop_staging"'
    ])
  })

  it('probe: rights named, too old', async () => {
    const q = /rolcreatedb/
    const row = (o: Record<string, unknown>) => [
      [{ num: '160004', v: '16.4', super: false, createdb: true, createrole: true, ...o }]
    ]
    expect(await p.probe(fake([[q, row({})[0]]]).k)).toMatchObject({
      ok: true,
      can_create: true,
      version: '16.4'
    })
    expect(
      await p.probe(fake([[q, row({ createdb: false, createrole: false, super: true })[0]]]).k)
    ).toMatchObject({ can_create: true })
    const noRole = await p.probe(fake([[q, row({ createrole: false })[0]]]).k)
    expect(noRole).toMatchObject({ ok: true, can_create: false, missing: ['CREATEROLE'] })
    const old = await p.probe(fake([[q, row({ num: '130012', v: '13.12' })[0]]]).k)
    expect(old).toMatchObject({ ok: false, can_create: false })
    expect(old.text).toMatch(/older than 14/)
  })

  it('checkApp classifications', async () => {
    const info = (o: Record<string, unknown>): Rule => [
      /current_database\(\)/,
      [
        {
          num: '160004',
          v: '16.4',
          owner: true,
          can_create: true,
          tables: '0',
          ledger: false,
          ...o
        }
      ]
    ]
    expect((await p.checkApp(fake([info({})]).k)).state).toBe('empty')
    expect((await p.checkApp(fake([info({ owner: false })]).k)).state).toBe('empty')
    expect((await p.checkApp(fake([info({ owner: false, can_create: false })]).k)).state).toBe(
      'no_rights'
    )
    expect((await p.checkApp(fake([info({ tables: '7' })]).k)).state).toBe('foreign')
    expect((await p.checkApp(fake([info({ num: '120001', v: '12.1' })]).k)).state).toBe('too_old')
    const n = await p.checkApp(
      fake([
        info({ tables: '300', ledger: true }),
        [/FROM nivaro_migrations/, [{ n: '540', last: '540_five_database_fixes.ts' }]]
      ]).k
    )
    expect(n).toMatchObject({ state: 'nivaro', migrations: 540 })
    expect(
      (await p.checkApp(fake([[/current_database/, new Error('ECONNREFUSED')]]).k)).state
    ).toBe('unreachable')
  })
})

// ─── MySQL / MariaDB ─────────────────────────────────────────────────────────

describe('mysql provisioner', () => {
  const p = provisionerFor('mysql2', { user_host: '10.0.%' })

  it('fresh create: user (bound), database, grant with escaped wildcards', async () => {
    const f = fake()
    expect(await p.ensureLogin(f.k, LOGIN, PW)).toBe('created')
    expect(await p.ensureDatabase(f.k, DB, { collation: null, owner: LOGIN })).toBe('created')
    await p.ensureOwner(f.k, DB, LOGIN, OWNED)
    expect(f.calls).toEqual([
      { sql: 'SELECT Host AS h FROM mysql.user WHERE User = ?', bindings: [LOGIN] },
      { sql: 'CREATE USER ?@? IDENTIFIED BY ?', bindings: [LOGIN, '10.0.%', PW] },
      {
        sql: 'SELECT 1 AS x FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
        bindings: [DB]
      },
      {
        sql: 'CREATE DATABASE `nivaro_shop_staging` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
        bindings: []
      },
      {
        sql: 'GRANT ALL PRIVILEGES ON `nivaro\\_shop\\_staging`.* TO ?@?',
        bindings: [LOGIN, '10.0.%']
      }
    ])
    expect(f.sqls().join('\n')).not.toContain(PW)
    // Every MySQL statement carries knex's cancelling timeout.
    expect(f.timeouts).toHaveLength(5)
    for (const t of f.timeouts) expect(t).toMatchObject({ ms: 120_000, cancel: true })
  })

  it('mariadb uses utf8mb4_unicode_ci and % by default', async () => {
    const m = provisionerFor('mariadb')
    const f = fake()
    await m.ensureDatabase(f.k, DB, { collation: null, owner: LOGIN })
    await m.ensureLogin(f.k, LOGIN, PW)
    expect(f.sqls()[1]).toBe(
      'CREATE DATABASE `nivaro_shop_staging` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
    )
    expect(f.calls[3].bindings).toEqual([LOGIN, '%', PW])
  })

  it('existing user: refused, ALTER USER when owned at this host', async () => {
    const f = fake([[/mysql\.user/, [[{ h: '10.0.%' }], []]]])
    expect((await refusal(p.ensureLogin(f.k, LOGIN, PW))).code).toBe('LOGIN_EXISTS')
    const g = fake([[/mysql\.user/, [[{ h: '10.0.%' }], []]]])
    expect(await p.ensureLogin(g.k, LOGIN, PW, { ownedLogin: true })).toBe('updated')
    expect(g.calls[1]).toEqual({
      sql: 'ALTER USER ?@? IDENTIFIED BY ?',
      bindings: [LOGIN, '10.0.%', PW]
    })
  })

  it('existing database: DATABASE_EXISTS without the flag; existed with it; no writes', async () => {
    const a = fake([[/SCHEMATA/, [[{ x: 1 }], []]]])
    expect((await refusal(p.ensureDatabase(a.k, DB, { collation: null, owner: LOGIN }))).code).toBe(
      'DATABASE_EXISTS'
    )
    expect(a.calls).toHaveLength(1)
    const b = fake([[/SCHEMATA/, [[{ x: 1 }], []]]])
    expect(await p.ensureDatabase(b.k, DB, { collation: null, owner: LOGIN, ...OWNED })).toBe(
      'existed'
    )
    expect(b.calls).toHaveLength(1)
  })

  it('ensureOwner (GRANT ALL) refuses without the ownership flag', async () => {
    const f = fake()
    expect((await refusal(p.ensureOwner(f.k, DB, LOGIN))).code).toBe('NOT_OWNED')
    expect(f.calls).toHaveLength(0)
  })

  it('drop: only what the flags name', async () => {
    const none = fake()
    await p.drop(none.k, DB, LOGIN)
    expect(none.calls).toHaveLength(0)
    const f = fake()
    await p.drop(f.k, DB, LOGIN, OWNED_ALL)
    expect(f.calls).toEqual([
      { sql: 'DROP DATABASE IF EXISTS `nivaro_shop_staging`', bindings: [] },
      { sql: 'DROP USER IF EXISTS ?@?', bindings: [LOGIN, '10.0.%'] }
    ])
    const dbOnly = fake()
    await p.drop(dbOnly.k, DB, LOGIN, OWNED)
    expect(dbOnly.calls).toHaveLength(1)
    const loginOnly = fake()
    await p.drop(loginOnly.k, DB, LOGIN, { ownedLogin: true })
    expect(loginOnly.sqls()).toEqual(['DROP USER IF EXISTS ?@?'])
  })

  const grants = (lines: string[]) => [lines.map((l) => ({ 'Grants for x@%': l })), []]

  it('probe: grants, flavour mismatch, version floor', async () => {
    const mysql8Root = grants([
      'GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, RELOAD, SHUTDOWN, PROCESS, FILE, REFERENCES, INDEX, ALTER, SHOW DATABASES, SUPER, CREATE TEMPORARY TABLES, LOCK TABLES, EXECUTE, REPLICATION SLAVE, REPLICATION CLIENT, CREATE VIEW, SHOW VIEW, CREATE ROUTINE, ALTER ROUTINE, CREATE USER, EVENT, TRIGGER, CREATE TABLESPACE, CREATE ROLE, DROP ROLE ON *.* TO `root`@`%` WITH GRANT OPTION',
      'GRANT APPLICATION_PASSWORD_ADMIN,AUDIT_ADMIN ON *.* TO `root`@`%` WITH GRANT OPTION'
    ])
    const ok = await p.probe(
      fake([
        [/VERSION\(\)/, [[{ v: '8.4.3' }], []]],
        [/SHOW GRANTS/, mysql8Root]
      ]).k
    )
    expect(ok).toMatchObject({ ok: true, can_create: true, missing: [], version: '8.4.3' })

    // CREATE + CREATE USER + GRANT OPTION is not enough: GRANT ALL ON <db>.* needs every
    // privilege it hands over (MySQL refuses it otherwise; seen live on 8.4).
    const narrow = await p.probe(
      fake([
        [/VERSION\(\)/, [[{ v: '8.0.36' }], []]],
        [/SHOW GRANTS/, grants(['GRANT CREATE, CREATE USER ON *.* TO `prov`@`%`'])]
      ]).k
    )
    expect(narrow).toMatchObject({ ok: true, can_create: false })
    expect(narrow.missing).toContain('GRANT OPTION')
    expect(narrow.missing).toContain('SELECT')
    expect(narrow.missing).toContain('DROP')
    expect(narrow.missing).not.toContain('CREATE')
    expect(narrow.missing).not.toContain('CREATE USER')

    const listed = await p.probe(
      fake([
        [/VERSION\(\)/, [[{ v: '8.0.36' }], []]],
        [
          /SHOW GRANTS/,
          grants([
            'GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER, CREATE TEMPORARY TABLES, LOCK TABLES, EXECUTE, CREATE VIEW, SHOW VIEW, CREATE ROUTINE, ALTER ROUTINE, EVENT, TRIGGER, CREATE USER ON *.* TO `prov`@`%` WITH GRANT OPTION'
          ])
        ]
      ]).k
    )
    expect(listed).toMatchObject({ ok: true, can_create: true, missing: [] })
    // MariaDB also hands over DELETE HISTORY.
    const mariaListed = await provisionerFor('mariadb').probe(
      fake([
        [/VERSION\(\)/, [[{ v: '10.11.9-MariaDB' }], []]],
        [
          /SHOW GRANTS/,
          grants([
            'GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER, CREATE TEMPORARY TABLES, LOCK TABLES, EXECUTE, CREATE VIEW, SHOW VIEW, CREATE ROUTINE, ALTER ROUTINE, EVENT, TRIGGER, CREATE USER ON *.* TO `prov`@`%` WITH GRANT OPTION'
          ])
        ]
      ]).k
    )
    expect(mariaListed.missing).toEqual(['DELETE HISTORY'])

    // WITH GRANT OPTION on the dynamic-privilege line does not cover the static privileges.
    const dynamicOnly = await p.probe(
      fake([
        [/VERSION\(\)/, [[{ v: '8.4.3' }], []]],
        [
          /SHOW GRANTS/,
          grants([
            'GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER, CREATE TEMPORARY TABLES, LOCK TABLES, EXECUTE, CREATE VIEW, SHOW VIEW, CREATE ROUTINE, ALTER ROUTINE, EVENT, TRIGGER, CREATE USER ON *.* TO `prov`@`%`',
            'GRANT AUDIT_ADMIN,BACKUP_ADMIN ON *.* TO `prov`@`%` WITH GRANT OPTION'
          ])
        ]
      ]).k
    )
    expect(dynamicOnly.missing).toEqual(['GRANT OPTION'])

    const maria = await p.probe(fake([[/VERSION\(\)/, [[{ v: '11.4.3-MariaDB-ubu2404' }], []]]]).k)
    expect(maria).toMatchObject({ ok: false, can_create: false })
    expect(maria.text).toMatch(/MariaDB.*engine to MariaDB/)

    const reverse = await provisionerFor('mariadb').probe(
      fake([[/VERSION\(\)/, [[{ v: '8.4.3' }], []]]]).k
    )
    expect(reverse).toMatchObject({ ok: false })
    expect(reverse.text).toMatch(/MySQL.*engine to MySQL/)

    const old = await p.probe(fake([[/VERSION\(\)/, [[{ v: '8.0.12' }], []]]]).k)
    expect(old.ok).toBe(false)
    expect(old.text).toMatch(/older than 8\.0\.13/)
    const oldMaria = await provisionerFor('mariadb').probe(
      fake([[/VERSION\(\)/, [[{ v: '10.6.18-MariaDB' }], []]]]).k
    )
    expect(oldMaria.text).toMatch(/older than 10\.11/)

    const mariaRoot = await provisionerFor('mariadb').probe(
      fake([
        [/VERSION\(\)/, [[{ v: '10.11.9-MariaDB' }], []]],
        [
          /SHOW GRANTS/,
          grants([
            "GRANT ALL PRIVILEGES ON *.* TO `root`@`%` IDENTIFIED BY PASSWORD '*ABCDEF' WITH GRANT OPTION"
          ])
        ]
      ]).k
    )
    expect(mariaRoot).toMatchObject({ ok: true, can_create: true })
    expect(JSON.stringify(mariaRoot)).not.toContain('ABCDEF')
  })

  it('checkApp: rights read from SHOW GRANTS, wildcard escapes honoured', async () => {
    const info = (o: Record<string, unknown>): Rule => [
      /DATABASE\(\) AS d/,
      [[{ v: '8.4.3', d: DB, tables: 0, ledger: 0, ...o }], []]
    ]
    const own = grants([
      'GRANT USAGE ON *.* TO `shop_staging`@`%`',
      'GRANT ALL PRIVILEGES ON `nivaro\\_shop\\_staging`.* TO `shop_staging`@`%`'
    ])
    expect((await p.checkApp(fake([info({}), [/SHOW GRANTS/, own]]).k)).state).toBe('empty')

    // A grant on another app's database does not count, even one `_` would match as a wildcard.
    const other = grants([
      'GRANT USAGE ON *.* TO `x`@`%`',
      'GRANT ALL PRIVILEGES ON `nivaro\\_shop\\_staginx`.* TO `x`@`%`'
    ])
    expect((await p.checkApp(fake([info({}), [/SHOW GRANTS/, other]]).k)).state).toBe('no_rights')
    const split = grants([
      'GRANT CREATE, ALTER, INDEX, DROP, SELECT ON `nivaro_shop_staging`.* TO `x`@`%`'
    ])
    expect((await p.checkApp(fake([info({}), [/SHOW GRANTS/, split]]).k)).state).toBe('empty')
    const partial = grants(['GRANT SELECT, INSERT ON `nivaro\\_shop\\_staging`.* TO `x`@`%`'])
    expect((await p.checkApp(fake([info({}), [/SHOW GRANTS/, partial]]).k)).state).toBe('no_rights')

    expect((await p.checkApp(fake([info({ tables: 4 }), [/SHOW GRANTS/, own]]).k)).state).toBe(
      'foreign'
    )
    const n = await p.checkApp(
      fake([
        info({ tables: 400, ledger: 1 }),
        [/SHOW GRANTS/, own],
        [/FROM nivaro_migrations/, [[{ n: 12, last: '012_x.ts' }], []]]
      ]).k
    )
    expect(n).toMatchObject({ state: 'nivaro', migrations: 12, last_migration: '012_x.ts' })
    expect(
      (await p.checkApp(fake([info({ v: '10.11.2-MariaDB' }), [/SHOW GRANTS/, own]]).k)).state
    ).toBe('too_old')
    expect(
      (await p.checkApp(fake([[/DATABASE\(\) AS d/, new Error('ECONNREFUSED')]]).k)).state
    ).toBe('unreachable')
  })
})

// ─── Guards, registry, scrubbing ─────────────────────────────────────────────

describe('guards', () => {
  const HOSTILE_NAMES = [
    "x'; drop database master; --",
    'a]b',
    'a"b',
    'a`b',
    'Shop',
    'a',
    '1abc',
    'a b',
    'a\\b',
    'nivaro_shop%',
    `n${'x'.repeat(63)}`,
    ''
  ]
  const RESERVED = ['master', 'postgres', 'mysql_app', 'pg_x', 'sa', 'root', 'tempdb']

  for (const engine of ['mssql', 'pg', 'mysql2', 'mariadb'] as const) {
    it(`${engine}: unsafe or reserved names and bad passwords throw before any SQL`, async () => {
      const p = provisionerFor(engine)
      const f = fake()
      for (const bad of [...HOSTILE_NAMES, ...RESERVED]) {
        const codes = [
          (await refusal(p.ensureLogin(f.k, bad, PW))).code,
          (await refusal(p.ensureDatabase(f.k, bad, { collation: null, owner: LOGIN }))).code,
          (await refusal(p.ensureDatabase(f.k, DB, { collation: null, owner: bad }))).code,
          (await refusal(p.ensureOwner(f.k, bad, LOGIN))).code,
          (await refusal(p.ensureOwner(f.k, DB, bad))).code,
          (await refusal(p.drop(f.k, bad, LOGIN))).code,
          (await refusal(p.drop(f.k, DB, bad))).code,
          (await refusal(p.databaseExists(f.k, bad))).code,
          (await refusal(p.loginExists(f.k, bad))).code
        ]
        for (const c of codes) expect(['UNSAFE_IDENTIFIER', 'RESERVED_NAME']).toContain(c)
      }
      for (const pw of [
        "abc'def-ghijklmnopqrstuvwxyz0123",
        'a\\bcdefghijklmnopqrstuvwxyz01234',
        'short',
        'x'.repeat(200),
        `${PW}%`
      ]) {
        expect((await refusal(p.ensureLogin(f.k, LOGIN, pw))).code).toBe('UNSAFE_IDENTIFIER')
      }
      expect(f.calls).toHaveLength(0)
    })
  }

  it('mysql logins longer than 32 characters are refused', async () => {
    const f = fake()
    const long = `a${'b'.repeat(32)}`
    expect((await refusal(provisionerFor('mysql2').ensureLogin(f.k, long, PW))).code).toBe(
      'UNSAFE_IDENTIFIER'
    )
    expect(f.calls).toHaveLength(0)
    // 33 characters is fine on Postgres (63).
    const g = fake()
    expect(await provisionerFor('pg').ensureLogin(g.k, long, PW)).toBe('created')
  })

  it('collation and user_host validators', async () => {
    expect(isCollation('SQL_Latin1_General_CP1_CI_AS')).toBe(true)
    for (const bad of ['Latin1; DROP', "x'", 'a b', '1abc', '', `a${'b'.repeat(128)}`])
      expect(isCollation(bad)).toBe(false)
    const f = fake()
    expect(
      (
        await refusal(
          provisionerFor('mssql').ensureDatabase(f.k, DB, {
            collation: 'X COLLATE Y',
            owner: LOGIN
          })
        )
      ).code
    ).toBe('UNSAFE_IDENTIFIER')
    expect(f.calls).toHaveLength(0)

    for (const ok of ['%', 'localhost', '10.0.%', '192.168.1.10', 'app-1.internal', 'fe80::1'])
      expect(isUserHost(ok)).toBe(true)
    for (const bad of ["%' OR '1", 'a b', '', 'h/24', 'x'.repeat(61), 'a`b'])
      expect(isUserHost(bad)).toBe(false)
    expect(() => provisionerFor('mysql2', { user_host: "%' OR 1" })).toThrow(ProvisionError)
  })

  it('provisionerFor refuses engines it cannot provision', () => {
    for (const e of ['sqlite3', 'better-sqlite3', 'oracledb', '', 'mssql ']) {
      try {
        provisionerFor(e as never)
        throw new Error('expected a refusal')
      } catch (err) {
        expect((err as ProvisionError).code).toBe('ENGINE_NOT_PROVISIONABLE')
      }
    }
  })
})

describe('driver errors are scrubbed (Review Focus 3)', () => {
  const ADMIN_PW = 'AdminPw-9f3c1a7e5b2d8046'

  it('every engine: a failing DDL names neither the password nor the login', async () => {
    for (const engine of ['mssql', 'pg', 'mysql2', 'mariadb'] as const) {
      const p = provisionerFor(engine)
      const boom = new Error(
        `CREATE LOGIN [${LOGIN}] WITH PASSWORD = N'${PW}' - Login failed for user '${LOGIN}'. connect postgres://${LOGIN}:${encodeURIComponent(PW)}@db1/x admin ${ADMIN_PW}`
      )
      const f = fake([[/CREATE|ALTER|IDENTIFIED/, boom]])
      rememberSecrets(f.k, { passwords: [ADMIN_PW], logins: ['sa'] })
      const err = await refusal(p.ensureLogin(f.k, LOGIN, PW))
      expect(err.code).toBe('DB_ERROR')
      expect(err.message).not.toContain(PW)
      expect(err.message).not.toContain(encodeURIComponent(PW))
      expect(err.message).not.toMatch(LOGIN_TOKEN)
      expect(err.message).not.toContain(LOGIN)
      expect(err.message).not.toContain(ADMIN_PW)
    }
  })

  it('every engine: ensureOwner, ensureDatabase and drop errors mask the login', async () => {
    for (const engine of ['mssql', 'pg', 'mysql2', 'mariadb'] as const) {
      const p = provisionerFor(engine)
      const boom = () => new Error(`denied for user '${LOGIN}'@'%' (role "${LOGIN}")`)
      // [step, what the existence reads answer so the step reaches its DDL]
      const steps: Array<[(k: Knex) => Promise<unknown>, unknown]> = [
        [(k) => p.ensureOwner(k, DB, LOGIN, OWNED), [[{ x: 1, rcsi: false }], []]],
        [(k) => p.ensureDatabase(k, DB, { collation: null, owner: LOGIN }), []],
        [(k) => p.drop(k, DB, LOGIN, OWNED_ALL), [[{ x: 1, rcsi: true, owner: LOGIN }], []]]
      ]
      for (const [step, exists] of steps) {
        const f = fake([
          [/^SELECT/, exists],
          [/./, boom()]
        ])
        const err = await refusal(step(f.k))
        expect(err.code).toBe('DB_ERROR')
        expect(err.message).not.toMatch(LOGIN_TOKEN)
      }
    }
  })

  it('knex’s "<sql> - " prefix is dropped so the driver reason survives the 300-character cut', async () => {
    const f = fake([
      [
        /^CREATE USER/,
        new Error(
          `CREATE USER '${LOGIN}'@'%' IDENTIFIED BY '${PW}' /* ${'x'.repeat(400)} */ - Operation CREATE USER failed for '${LOGIN}'@'%'`
        )
      ]
    ])
    const err = await refusal(provisionerFor('mysql2').ensureLogin(f.k, LOGIN, PW))
    expect(err.message).toBe("Operation CREATE USER failed for '••••'@'%'")
  })

  it('logins are masked before the 300-character cut (never half a login)', async () => {
    const f = fake([[/^CREATE ROLE/, new Error(`${'word '.repeat(58)}${LOGIN} is invalid`)]])
    const err = await refusal(provisionerFor('pg').ensureLogin(f.k, LOGIN, PW))
    expect(err.message.length).toBeLessThanOrEqual(300)
    expect(err.message).not.toContain('shop_st')
  })

  it('withServerKnex rethrows an app error as a fresh error of the same class', async () => {
    class AppError extends Error {
      code = 'APP_REFUSED'
      status = 409
    }
    const original = new AppError(`refused for ${LOGIN} with ${ADMIN_PW}`)
    const err = await withServerKnex(
      { engine: 'pg', host: '127.0.0.1', port: 1, ssl_mode: null, trust_server_cert: false },
      { user: LOGIN, password: ADMIN_PW },
      async () => {
        throw original
      }
    ).catch((e) => e)
    expect(err).toBeInstanceOf(AppError)
    expect(err).not.toBe(original)
    expect(err).toMatchObject({ code: 'APP_REFUSED', status: 409 })
    for (const text of [err.message, err.stack]) {
      expect(text).not.toContain(ADMIN_PW)
      expect(text).not.toMatch(LOGIN_TOKEN)
    }
  })

  it('checkApp unreachable text is scrubbed of the app credentials', async () => {
    for (const engine of ['mssql', 'pg', 'mysql2', 'mariadb'] as const) {
      const f = fake([
        [
          /./,
          new Error(
            `password authentication failed for user "${LOGIN}" (postgres://${LOGIN}:${PW}@db1:5432/${DB})`
          )
        ]
      ])
      rememberSecrets(f.k, { passwords: [PW], logins: [LOGIN] })
      const c = await provisionerFor(engine).checkApp(f.k)
      expect(c.state).toBe('unreachable')
      expect(JSON.stringify(c)).not.toContain(PW)
      // The database name holds the login as a part; the login itself is masked.
      expect(JSON.stringify(c)).not.toMatch(LOGIN_TOKEN)
      expect(c.text).toContain('postgres://••••@db1')
    }
  })

  it('probe failure text is scrubbed of the admin credentials', async () => {
    const f = fake([[/./, new Error(`Login failed for user 'hubadmin'. password=${ADMIN_PW}`)]])
    rememberSecrets(f.k, { passwords: [ADMIN_PW], logins: ['hubadmin'] })
    const r = await provisionerFor('mssql').probe(f.k)
    expect(JSON.stringify(r)).not.toContain(ADMIN_PW)
    expect(JSON.stringify(r)).not.toContain('hubadmin')
  })
})

describe('login masking keeps other words readable', () => {
  it('a short admin login is masked as a token, not inside words', async () => {
    const f = fake([[/./, new Error("Login failed for user 'sa'. The transaction ended.")]])
    rememberSecrets(f.k, { passwords: ['Pw-123456789abcdefXYZ'], logins: ['sa'] })
    const r = await provisionerFor('mssql').probe(f.k)
    expect(r.text).toContain("user '••••'")
    expect(r.text).toContain('transaction')
  })
})
