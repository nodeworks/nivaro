import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 3: database servers, databases and the DBA checklist. Real SQLite holds the
// rows; the provisioner is a fake that keeps an in-memory server (databases, logins) and records
// every call, so the service's ownership flags, ordering and secret handling can be asserted.

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  return { db }
})

interface Call {
  fn: string
  args: Record<string, unknown>
}

// The fake server. Ownership semantics mirror the real provisioners (provision-common.ts).
const fake = {
  databases: new Set<string>(),
  logins: new Map<string, string>(),
  calls: [] as Call[],
  adminSeen: [] as Array<{ user: string; password: string }>,
  appSeen: [] as Array<{ database: string; user: string; password: string }>,
  failOwnerOnce: false,
  leakInErrors: '' as string,
  appState: new Map<string, string>(),
  probe: { ok: true, version: '16.0', can_create: true, missing: [] as string[], text: 'ok' },
  reset() {
    this.databases = new Set()
    this.logins = new Map()
    this.calls = []
    this.adminSeen = []
    this.appSeen = []
    this.failOwnerOnce = false
    this.leakInErrors = ''
    this.appState = new Map()
    this.probe = { ok: true, version: '16.0', can_create: true, missing: [], text: 'ok' }
  }
}

vi.mock('../../../services/hub/db/provisioner.js', async (orig) => {
  const real = (await orig()) as typeof import('../../../services/hub/db/provisioner.js')
  const { ProvisionError } = real
  const checkOf = (state: string, text: string) => ({
    state,
    ok: state === 'empty' || state === 'nivaro',
    version: '16.0',
    migrations: state === 'nivaro' ? 3 : null,
    last_migration: state === 'nivaro' ? '545_hub_creations' : null,
    text,
    at: new Date().toISOString()
  })
  const prov = {
    engine: 'pg',
    async probe() {
      fake.calls.push({ fn: 'probe', args: {} })
      return { ...fake.probe }
    },
    async databaseExists(_a: unknown, name: string) {
      fake.calls.push({ fn: 'databaseExists', args: { name } })
      return fake.databases.has(name)
    },
    async loginExists(_a: unknown, login: string) {
      fake.calls.push({ fn: 'loginExists', args: { login } })
      return fake.logins.has(login)
    },
    async ensureLogin(
      _a: unknown,
      login: string,
      password: string,
      opts: { ownedLogin?: boolean } = {}
    ) {
      fake.calls.push({ fn: 'ensureLogin', args: { login, password, ...opts } })
      if (fake.logins.has(login)) {
        if (!opts.ownedLogin) throw new ProvisionError('LOGIN_EXISTS', 'The login exists')
        fake.logins.set(login, password)
        return 'updated'
      }
      fake.logins.set(login, password)
      return 'created'
    },
    async ensureDatabase(
      _a: unknown,
      name: string,
      opts: { collation: string | null; owner: string; ownedDatabase?: boolean }
    ) {
      fake.calls.push({ fn: 'ensureDatabase', args: { name, ...opts } })
      if (fake.databases.has(name)) {
        if (!opts.ownedDatabase) throw new ProvisionError('DATABASE_EXISTS', 'exists')
        return 'existed'
      }
      fake.databases.add(name)
      return 'created'
    },
    async ensureOwner(
      _a: unknown,
      name: string,
      login: string,
      opts: { ownedDatabase?: boolean } = {}
    ) {
      fake.calls.push({ fn: 'ensureOwner', args: { name, login, ...opts } })
      if (!opts.ownedDatabase) throw new ProvisionError('NOT_OWNED', 'not owned')
      if (fake.failOwnerOnce) {
        fake.failOwnerOnce = false
        // A driver error that (wrongly) still carries secrets: the service must scrub it again.
        throw new ProvisionError('DB_ERROR', `permission denied ${fake.leakInErrors}`)
      }
    },
    async drop(
      _a: unknown,
      name: string,
      login: string | null,
      opts: { ownedDatabase?: boolean; ownedLogin?: boolean } = {}
    ) {
      fake.calls.push({ fn: 'drop', args: { name, login, ...opts } })
      if (opts.ownedDatabase) fake.databases.delete(name)
      if (login && opts.ownedLogin) fake.logins.delete(login)
    },
    async checkApp() {
      const last = fake.appSeen[fake.appSeen.length - 1]
      fake.calls.push({ fn: 'checkApp', args: { database: last?.database } })
      const state = fake.appState.get(last?.database ?? '') ?? 'empty'
      return checkOf(state, `Checked: ${state} ${fake.leakInErrors}`)
    }
  }
  return {
    ...real,
    provisionerFor: (engine: string, opts: { user_host?: string | null } = {}) => {
      if (!['mssql', 'pg', 'mysql2', 'mariadb'].includes(engine))
        throw new ProvisionError('ENGINE_NOT_PROVISIONABLE', 'no')
      fake.calls.push({ fn: 'provisionerFor', args: { engine, user_host: opts.user_host } })
      return prov
    },
    withServerKnex: async (
      _server: unknown,
      admin: { user: string; password: string },
      fn: (k: unknown) => Promise<unknown>
    ) => {
      fake.adminSeen.push({ ...admin })
      fake.calls.push({ fn: 'withServerKnex', args: {} })
      return fn({ admin: true })
    },
    withAppKnex: async (
      conn: { database: string; user: string; password: string },
      fn: (k: unknown) => Promise<unknown>
    ) => {
      fake.appSeen.push({ database: conn.database, user: conn.user, password: conn.password })
      fake.calls.push({ fn: 'withAppKnex', args: { database: conn.database } })
      return fn({ app: true })
    }
  }
})

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const m542 = await import('../../../db/migrations/542_hub_tables.js')
const m543 = await import('../../../db/migrations/543_hub_promotions.js')
const m544 = await import('../../../db/migrations/544_hub_databases.js')
const m545 = await import('../../../db/migrations/545_hub_creations.js')
const S = await import('../../../services/hub/db/servers.js')
const D = await import('../../../services/hub/db/databases.js')
const { dbaChecklist } = await import('../../../services/hub/db/checklist.js')
const { HUB_MASK, openSecret } = await import('../../../services/hub/secrets.js')

const KEY = 'd'.repeat(64)
const ADMIN_PASSWORD = 'Adm1nPassw0rd-very-secret'
const ADMIN_USER = 'hubprovisioner'
const MANUAL_ADMIN_PASSWORD = 'Manu4lPassw0rd-also-secret'
const DBA_PASSWORD = 'DbaGiv3nPassw0rd-secret'

// Everything the service answered, logged, stored as text or threw — checked for secrets.
const seen: string[] = []
const remember = <T>(v: T): T => {
  seen.push(JSON.stringify(v))
  return v
}
async function refusal(p: Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await p
  } catch (err) {
    const e = err as Error & { code: string; status: number }
    seen.push(String(e.message), String(e.stack ?? ''))
    return { code: e.code, status: e.status }
  }
  throw new Error('expected a refusal')
}
const logLines: string[] = []
const log = (line: string) => {
  logLines.push(line)
}

let prevKey: string | undefined
beforeAll(async () => {
  prevKey = process.env.ENCRYPTION_KEY
  process.env.ENCRYPTION_KEY = KEY
  await m542.up(db)
  await m543.up(db)
  await m544.up(db)
  await m545.up(db)
})
afterAll(async () => {
  // No secret anywhere the service put text: answers, errors, logs, stored checks.
  const stored = (await db('nivaro_hub_databases').select('last_check')) as Array<{
    last_check: string | null
  }>
  const all = [...seen, ...logLines, ...stored.map((r) => r.last_check ?? '')].join('\n')
  const appPasswords = new Set(
    fake.calls.filter((c) => c.fn === 'ensureLogin').map((c) => String(c.args.password))
  )
  for (const s of [ADMIN_PASSWORD, MANUAL_ADMIN_PASSWORD, DBA_PASSWORD, ...allAppPasswords])
    expect(all).not.toContain(s)
  for (const s of appPasswords) expect(all).not.toContain(s)
  if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = prevKey
  await db.destroy()
})

// App passwords from every test (fake.reset clears calls per test).
const allAppPasswords = new Set<string>()

beforeEach(async () => {
  for (const c of fake.calls)
    if (c.fn === 'ensureLogin') allAppPasswords.add(String(c.args.password))
  for (const s of fake.appSeen) allAppPasswords.add(s.password)
  fake.reset()
  logLines.length = 0
  for (const t of [
    'nivaro_hub_databases',
    'nivaro_hub_db_servers',
    'nivaro_hub_environments',
    'nivaro_hub_apps'
  ])
    await db(t).del()
})

function serverInput(over: Record<string, unknown> = {}) {
  return {
    name: 'Postgres 1',
    engine: 'pg',
    host: 'pg1.internal',
    port: 5432,
    provision_mode: 'automatic',
    admin_secret: { user: ADMIN_USER, password: ADMIN_PASSWORD },
    ...over
  }
}

async function automaticServer(over: Record<string, unknown> = {}) {
  const v = S.validateServerInput(serverInput(over))
  if (!v.ok) throw new Error(v.message)
  const s = remember(await S.createServer(v.row))
  const row = await S.getServerRow(s.id)
  if (!row) throw new Error('no row')
  return row
}

async function manualServer(over: Record<string, unknown> = {}) {
  const v = S.validateServerInput(
    serverInput({
      name: 'Manual SQL',
      engine: 'mssql',
      host: 'sql1.corp',
      port: null,
      provision_mode: 'manual',
      admin_secret: null,
      notes: 'Replicated: tell the DBA before adding tables to publications.',
      ...over
    })
  )
  if (!v.ok) throw new Error(v.message)
  const s = remember(await S.createServer(v.row))
  const row = await S.getServerRow(s.id)
  if (!row) throw new Error('no row')
  return row
}

async function attach(dbId: number) {
  const [appId] = await db('nivaro_hub_apps').insert({ key: 'shop', name: 'Shop' }, ['id'])
  const app_id = typeof appId === 'object' ? (appId as { id: number }).id : appId
  await db('nivaro_hub_environments').insert({
    app_id,
    key: 'staging',
    base_url: 'https://shop-staging.example.com',
    db_ref: D.dbRef(dbId)
  })
}

const fns = () => fake.calls.map((c) => c.fn)

describe('validateServerInput', () => {
  it('refuses sqlite as not provisionable and unknown engines as BAD_ENGINE', () => {
    const a = S.validateServerInput(serverInput({ engine: 'sqlite' }))
    expect(a.ok === false && a.code).toBe('ENGINE_NOT_PROVISIONABLE')
    const b = S.validateServerInput(serverInput({ engine: 'oracle' }))
    expect(b.ok === false && b.code).toBe('BAD_ENGINE')
  })

  it('checks name, host, port and mode', () => {
    const codes = [
      S.validateServerInput(serverInput({ name: '' })),
      S.validateServerInput(serverInput({ host: 'pg1.internal/evil?x=' })),
      S.validateServerInput(serverInput({ port: 70000 })),
      S.validateServerInput(serverInput({ provision_mode: 'sometimes' }))
    ].map((v) => (v.ok ? 'ok' : v.code))
    expect(codes).toEqual(['BAD_NAME', 'BAD_HOST', 'BAD_PORT', 'BAD_MODE'])
  })

  it('needs a provisioning login for automatic servers', () => {
    const v = S.validateServerInput(serverInput({ admin_secret: null }))
    expect(v.ok === false && v.code).toBe('ADMIN_REQUIRED')
    const w = S.validateServerInput(serverInput({ admin_secret: { user: 'x' } }))
    expect(w.ok === false && w.code).toBe('ADMIN_REQUIRED')
    const m = S.validateServerInput(serverInput({ provision_mode: 'manual', admin_secret: null }))
    expect(m.ok).toBe(true)
  })

  it('keeps the stored login on the mask, but not when the host or engine changes', async () => {
    const row = await automaticServer()
    const keep = S.validateServerInput({ name: 'Renamed', admin_secret: HUB_MASK }, row)
    expect(keep.ok && keep.row.admin_secret).toBe(row.admin_secret)
    const moved = S.validateServerInput({ host: 'elsewhere.example.com' }, row)
    expect(moved.ok === false && moved.code).toBe('SECRET_REQUIRED')
    const engine = S.validateServerInput({ engine: 'mysql2', admin_secret: HUB_MASK }, row)
    expect(engine.ok === false && engine.code).toBe('SECRET_REQUIRED')
    const fresh = S.validateServerInput(
      { host: 'elsewhere.example.com', admin_secret: { user: 'u2', password: 'P4ssword-new' } },
      row
    )
    expect(fresh.ok).toBe(true)
  })
})

describe('servers', () => {
  it('stores the provisioning login sealed and answers only the mask', async () => {
    const row = await automaticServer()
    expect(row.admin_secret).not.toContain(ADMIN_PASSWORD)
    expect(JSON.parse(openSecret(row.admin_secret) ?? '{}')).toEqual({
      user: ADMIN_USER,
      password: ADMIN_PASSWORD
    })
    const list = remember(await S.listServers())
    expect(list).toHaveLength(1)
    expect(list[0].admin_secret).toBe(HUB_MASK)
    expect(list[0].provision_mode).toBe('automatic')
  })

  it('refuses a second server with the same name', async () => {
    await automaticServer()
    const v = S.validateServerInput(serverInput())
    if (!v.ok) throw new Error(v.message)
    expect((await refusal(S.createServer(v.row))).code).toBe('NAME_TAKEN')
  })

  it('tests an automatic server with the provisioning login', async () => {
    const row = await automaticServer()
    const probe = remember(await S.testServer(row.id))
    expect(probe.can_create).toBe(true)
    expect(fake.adminSeen).toEqual([{ user: ADMIN_USER, password: ADMIN_PASSWORD }])
  })

  it('a manual server without a login answers manual without connecting', async () => {
    const row = await manualServer()
    const probe = remember(await S.testServer(row.id))
    expect(probe).toMatchObject({ ok: true, can_create: false, text: 'manual' })
    expect(fake.calls).toEqual([])
  })

  it('a manual server with a login checks reachability only', async () => {
    const row = await manualServer({
      admin_secret: { user: 'reader', password: MANUAL_ADMIN_PASSWORD }
    })
    const probe = remember(await S.testServer(row.id))
    expect(probe.ok).toBe(true)
    expect(probe.can_create).toBe(false)
  })

  it('refuses to delete a server a database row names', async () => {
    const server = await automaticServer()
    await D.recordDatabase({
      server,
      database_name: 'nivaro_shop_staging',
      login_name: 'shop_staging',
      by: null
    })
    expect(await S.deleteServer(server.id)).toEqual({ ok: false, code: 'IN_USE' })
    expect(await S.deleteServer(999)).toEqual({ ok: false, code: 'NOT_FOUND' })
  })
})

describe('automatic databases', () => {
  async function recorded() {
    const server = await automaticServer()
    const rec = remember(
      await D.recordDatabase({
        server,
        database_name: 'nivaro_shop_staging',
        login_name: 'shop_staging',
        by: null
      })
    )
    return { server, rec }
  }

  it('records with a sealed generated password, then provisions to ready', async () => {
    const { rec } = await recorded()
    expect(rec.status).toBe('creating')
    expect(rec.created_by_hub).toBe(true)
    expect(rec.connection).toBe(HUB_MASK)
    const raw = await db('nivaro_hub_databases').where({ id: rec.id }).first()
    const conn = JSON.parse(openSecret(raw.connection) ?? '{}')
    expect(conn.password).toMatch(/^[A-Za-z0-9._~-]{32}$/)
    expect(fake.calls).toEqual([]) // nothing on the server until provisioning

    const done = remember(await D.provisionDatabase(rec.id, log))
    expect(done.status).toBe('ready')
    expect(done.connection).toBe(HUB_MASK)
    expect(done.last_check?.state).toBe('empty')
    expect(fns().filter((f) => f.startsWith('ensure') || f === 'checkApp')).toEqual([
      'ensureLogin',
      'ensureDatabase',
      'ensureOwner',
      'checkApp'
    ])
    const login = fake.calls.find((c) => c.fn === 'ensureLogin')
    expect(login?.args).toMatchObject({ login: 'shop_staging', password: conn.password })
    expect(login?.args.ownedLogin).toBeFalsy()
    const owner = fake.calls.find((c) => c.fn === 'ensureOwner')
    expect(owner?.args.ownedDatabase).toBe(true)
    expect(fake.adminSeen[0]).toEqual({ user: ADMIN_USER, password: ADMIN_PASSWORD })
    expect(fake.appSeen[0]).toMatchObject({ user: 'shop_staging', password: conn.password })
    expect(logLines.length).toBeGreaterThan(0)

    const opened = await D.openDatabaseConnection(rec.id)
    expect(opened).toEqual({
      engine: 'pg',
      host: 'pg1.internal',
      port: 5432,
      database: 'nivaro_shop_staging',
      user: 'shop_staging',
      password: conn.password,
      ssl_mode: null,
      trust_server_cert: false
    })

    // Provisioning a ready row again touches nothing.
    fake.calls = []
    expect((await D.provisionDatabase(rec.id, log)).status).toBe('ready')
    expect(fake.calls).toEqual([])
  })

  it('a retry after a failed ensureOwner reuses the stored password and its own login', async () => {
    const { rec } = await recorded()
    fake.failOwnerOnce = true
    fake.leakInErrors = `${ADMIN_PASSWORD} ${ADMIN_USER}`
    const r = await refusal(D.provisionDatabase(rec.id, log))
    expect(r.code).toBe('DB_ERROR')
    const failed = remember(await D.getDatabase(rec.id))
    expect(failed?.status).toBe('failed')
    expect(failed?.last_check?.ok).toBe(false)

    const done = remember(await D.provisionDatabase(rec.id, log))
    expect(done.status).toBe('ready')
    const logins = fake.calls.filter((c) => c.fn === 'ensureLogin')
    expect(logins).toHaveLength(2)
    expect(logins[0].args.password).toBe(logins[1].args.password)
    expect(logins[1].args.ownedLogin).toBe(true)
    const dbs = fake.calls.filter((c) => c.fn === 'ensureDatabase')
    expect(dbs[1].args.ownedDatabase).toBe(true)
    expect(fake.logins.size).toBe(1)
  })

  it('refuses DATABASE_EXISTS for a database it did not make, and never makes a login for it', async () => {
    const { rec } = await recorded()
    fake.databases.add('nivaro_shop_staging')
    expect((await refusal(D.provisionDatabase(rec.id, log))).code).toBe('DATABASE_EXISTS')
    expect(fns()).not.toContain('ensureLogin')
    expect(fns()).not.toContain('ensureOwner')
    const row = remember(await D.getDatabase(rec.id))
    expect(row?.status).toBe('failed')
    // Still refused on retry: the row has no marker for that database.
    expect((await refusal(D.provisionDatabase(rec.id, log))).code).toBe('DATABASE_EXISTS')
    // A failed creation never gets drop rights over what it did not make.
    expect(
      (await refusal(D.deleteDatabase(rec.id, { confirm: 'nivaro_shop_staging', drop: true }))).code
    ).toBe('DROP_NOT_ALLOWED')
    expect(fns()).not.toContain('drop')
  })

  it('refuses LOGIN_EXISTS for a login it did not make and never touches its database', async () => {
    const { rec } = await recorded()
    fake.logins.set('shop_staging', 'someone-elses')
    expect((await refusal(D.provisionDatabase(rec.id, log))).code).toBe('LOGIN_EXISTS')
    expect(fns()).not.toContain('ensureDatabase')
    expect(fake.logins.get('shop_staging')).toBe('someone-elses')
    expect(
      (await refusal(D.deleteDatabase(rec.id, { confirm: 'nivaro_shop_staging', drop: true }))).code
    ).toBe('DROP_NOT_ALLOWED')
  })

  it('drops only what its markers say it made', async () => {
    const { rec } = await recorded()
    await D.provisionDatabase(rec.id, log)
    fake.calls = []
    const res = remember(
      await D.deleteDatabase(rec.id, { confirm: 'nivaro_shop_staging', drop: true })
    )
    expect(res).toEqual({ dropped: true })
    const drop = fake.calls.find((c) => c.fn === 'drop')
    expect(drop?.args).toMatchObject({
      name: 'nivaro_shop_staging',
      login: 'shop_staging',
      ownedDatabase: true,
      ownedLogin: true
    })
    expect(await D.getDatabase(rec.id)).toBeNull()
  })

  it('a database that was only half made drops only the login it made', async () => {
    const { rec } = await recorded()
    fake.databases.add('other_twin') // unrelated
    // ensureDatabase refuses because the name appears between the pre-check and the create
    const prov = (await import('../../../services/hub/db/provisioner.js')).provisionerFor(
      'pg'
    ) as unknown as {
      databaseExists: (a: unknown, n: string) => Promise<boolean>
    }
    const orig = prov.databaseExists
    prov.databaseExists = async () => {
      fake.databases.add('nivaro_shop_staging')
      return false
    }
    try {
      expect((await refusal(D.provisionDatabase(rec.id, log))).code).toBe('DATABASE_EXISTS')
    } finally {
      prov.databaseExists = orig
    }
    fake.calls = []
    await D.deleteDatabase(rec.id, { confirm: 'nivaro_shop_staging', drop: true })
    const drop = fake.calls.find((c) => c.fn === 'drop')
    expect(drop?.args.ownedLogin).toBe(true)
    expect(drop?.args.ownedDatabase).toBeFalsy()
    expect(fake.databases.has('nivaro_shop_staging')).toBe(true)
  })

  it('refuses drop when the server is no longer automatic', async () => {
    const { server, rec } = await recorded()
    await D.provisionDatabase(rec.id, log)
    await db('nivaro_hub_db_servers').where({ id: server.id }).update({ provision_mode: 'manual' })
    expect(
      (await refusal(D.deleteDatabase(rec.id, { confirm: 'nivaro_shop_staging', drop: true }))).code
    ).toBe('DROP_NOT_ALLOWED')
  })

  it('refuses a second record for the same host and database', async () => {
    const { server } = await recorded()
    const again = refusal(
      D.recordDatabase({
        server,
        database_name: 'nivaro_shop_staging',
        login_name: 'shop_staging2',
        by: null
      })
    )
    expect((await again).code).toBe('DATABASE_RECORDED')
  })

  it('refuses unsafe names before anything is stored', async () => {
    const server = await automaticServer()
    const r = await refusal(
      D.recordDatabase({ server, database_name: "x'; drop", login_name: 'ok_login', by: null })
    )
    expect(r.code).toBe('DATABASE_NAME_INVALID')
    const s = await refusal(
      D.recordDatabase({ server, database_name: 'fine_name', login_name: 'postgres', by: null })
    )
    expect(s.code).toBe('LOGIN_NAME_INVALID')
    expect(await db('nivaro_hub_databases').count({ n: '*' })).toEqual([{ n: 0 }])
  })

  it('stores a non-empty fresh database as failed', async () => {
    const { rec } = await recorded()
    fake.appState.set('nivaro_shop_staging', 'foreign')
    expect((await refusal(D.provisionDatabase(rec.id, log))).code).toBe('DATABASE_NOT_EMPTY')
    const row = remember(await D.getDatabase(rec.id))
    expect(row?.status).toBe('failed')
    expect(row?.last_check?.state).toBe('foreign')
  })
})

describe('manual databases', () => {
  async function requested(name = 'nivaro_shop_production') {
    const server = await manualServer()
    const rec = remember(
      await D.recordDatabase({ server, database_name: name, login_name: 'shop_prod', by: null })
    )
    return { server, rec }
  }
  const dbaConn = (database = 'nivaro_shop_production') => ({
    engine: 'mssql',
    host: 'sql1.corp',
    database,
    user: 'shop_prod',
    password: DBA_PASSWORD
  })

  it('records as requested with no connection, and provisioning is refused', async () => {
    const { rec } = await requested()
    expect(rec).toMatchObject({ status: 'requested', connection: null, created_by_hub: false })
    expect((await refusal(D.provisionDatabase(rec.id, log))).code).toBe('NOT_AUTOMATIC')
    expect(fake.calls).toEqual([])
  })

  it('a foreign check keeps the row requested', async () => {
    const { rec } = await requested()
    fake.appState.set('nivaro_shop_production', 'foreign')
    fake.leakInErrors = DBA_PASSWORD
    const { db: row, check } = remember(await D.setConnection(rec.id, dbaConn()))
    expect(check.state).toBe('foreign')
    expect(row.status).toBe('requested')
    expect(row.last_check?.state).toBe('foreign')
    expect(row.connection).toBe(HUB_MASK)
    expect(fns()).not.toContain('ensureLogin')
    expect((await refusal(D.openDatabaseConnection(rec.id))).code).toBe('NOT_READY')

    // The DBA empties it; Check now makes it ready.
    fake.appState.set('nivaro_shop_production', 'empty')
    const again = remember(await D.checkDatabase(rec.id))
    expect(again.state).toBe('empty')
    expect((await D.getDatabase(rec.id))?.status).toBe('ready')
  })

  it('an empty check makes it ready', async () => {
    const { rec } = await requested()
    const { db: row } = remember(await D.setConnection(rec.id, dbaConn()))
    expect(row.status).toBe('ready')
    expect(row.adopted).toBe(false)
    expect((await D.openDatabaseConnection(rec.id)).password).toBe(DBA_PASSWORD)
  })

  it('refuses a connection to a database another row records', async () => {
    const { rec } = await requested()
    const server = await S.getServerRow(rec.server_id as number)
    if (!server) throw new Error('no server')
    const other = await D.recordDatabase({
      server,
      database_name: 'nivaro_shop_staging',
      login_name: 'shop_stg',
      by: null
    })
    await D.setConnection(other.id, dbaConn('nivaro_shop_staging'))
    const r = await refusal(D.setConnection(rec.id, dbaConn('NIVARO_SHOP_STAGING')))
    expect(r.code).toBe('DATABASE_IN_USE')
    expect((await D.getDatabase(rec.id))?.connection).toBeNull()
  })

  it('refuses a connection for another engine, and on automatic rows', async () => {
    const { rec } = await requested()
    const r = await refusal(D.setConnection(rec.id, { ...dbaConn(), engine: 'pg' }))
    expect(r.code).toBe('ENGINE_MISMATCH')
    const auto = await automaticServer()
    const a = await D.recordDatabase({
      server: auto,
      database_name: 'nivaro_a_b',
      login_name: 'a_b',
      by: null
    })
    expect(
      (await refusal(D.setConnection(a.id, { ...dbaConn('nivaro_a_b'), engine: 'pg' }))).code
    ).toBe('NOT_MANUAL')
  })
})

describe('adopt', () => {
  const conn = (database: string) => ({
    url: `postgres://legacy:${encodeURIComponent(DBA_PASSWORD)}@pg9.internal:5432/${database}`
  })

  it('adopts an existing Nivaro database without provisioning anything', async () => {
    fake.appState.set('legacy_app', 'nivaro')
    const row = remember(await D.adoptDatabase(conn('legacy_app'), null))
    expect(row).toMatchObject({
      status: 'ready',
      adopted: true,
      created_by_hub: false,
      database_name: 'legacy_app',
      connection: HUB_MASK
    })
    expect(row.last_check?.state).toBe('nivaro')
    expect(fns().filter((f) => f.startsWith('ensure') || f === 'drop')).toEqual([])
    expect(fake.adminSeen).toEqual([])
  })

  it('adopts an empty database', async () => {
    const row = remember(await D.adoptDatabase(conn('fresh_one'), null))
    expect(row.status).toBe('ready')
  })

  it('refuses a foreign database and one another row records', async () => {
    fake.appState.set('someone_else', 'foreign')
    expect((await refusal(D.adoptDatabase(conn('someone_else'), null))).code).toBe(
      'DATABASE_NOT_NIVARO'
    )
    await D.adoptDatabase(conn('fresh_one'), null)
    expect((await refusal(D.adoptDatabase(conn('fresh_one'), null))).code).toBe('DATABASE_IN_USE')
    expect((await refusal(D.adoptDatabase({ url: 'sqlite:./x.db' }, null))).code).toBe(
      'BAD_CONNECTION'
    )
  })

  it('refuses drop on an adopted database; detach leaves the server untouched', async () => {
    const row = await D.adoptDatabase(conn('legacy_app'), null)
    fake.calls = []
    expect(
      (await refusal(D.deleteDatabase(row.id, { confirm: 'legacy_app', drop: true }))).code
    ).toBe('DROP_NOT_ALLOWED')
    expect(
      remember(await D.deleteDatabase(row.id, { confirm: 'legacy_app', drop: false }))
    ).toEqual({ dropped: false })
    expect(fake.calls).toEqual([])
    expect(await D.getDatabase(row.id)).toBeNull()
  })
})

describe('delete', () => {
  it('needs the database name as confirmation and refuses an attached database', async () => {
    const row = await D.adoptDatabase(
      { url: `postgres://u:${encodeURIComponent(DBA_PASSWORD)}@pg9.internal/kept_db` },
      null
    )
    expect((await refusal(D.deleteDatabase(row.id, { confirm: 'wrong', drop: false }))).code).toBe(
      'CONFIRM_REQUIRED'
    )
    expect(
      (await refusal(D.deleteDatabase(row.id, { confirm: undefined, drop: false }))).code
    ).toBe('CONFIRM_REQUIRED')
    await attach(row.id)
    const r = await refusal(D.deleteDatabase(row.id, { confirm: 'kept_db', drop: false }))
    expect(r).toEqual({ code: 'IN_USE', status: 409 })
    const listed = remember(await D.listDatabases())
    expect(listed[0].environment).toMatchObject({ app_key: 'shop', env_key: 'staging' })
    expect((await refusal(D.deleteDatabase(4242, { confirm: 'x', drop: false }))).code).toBe(
      'NOT_FOUND'
    )
  })
})

describe('dbaChecklist', () => {
  it('lists what the DBA must create, per engine', async () => {
    const server = (await S.listServers()).length ? null : await manualServer()
    const pub = (await S.listServers())[0]
    expect(server).not.toBeNull()
    const items = dbaChecklist(pub, 'nivaro_shop_production', 'shop_prod')
    const byLabel = Object.fromEntries(items.map((i) => [i.label, i.value]))
    expect(byLabel['Database name']).toBe('nivaro_shop_production')
    expect(byLabel.Login).toBe('shop_prod')
    expect(byLabel.Collation).toBe('SQL_Latin1_General_CP1_CI_AS')
    expect(byLabel.Rights).toMatch(/owner of this database only/i)
    expect(byLabel['Read committed snapshot']).toBe('ON')
    expect(byLabel['Server notes']).toMatch(/Replicated/)
    const pg = dbaChecklist(
      { ...pub, engine: 'pg', collation: null, notes: null },
      'nivaro_a_b',
      'a_b'
    )
    expect(pg.map((i) => i.label)).not.toContain('Read committed snapshot')
    expect(pg.map((i) => i.label)).not.toContain('Server notes')
    const my = dbaChecklist({ ...pub, engine: 'mysql2', user_host: '10.0.%' }, 'nivaro_a_b', 'a_b')
    expect(my.find((i) => i.label === 'Login')?.note).toContain("'a_b'@'10.0.%'")
  })
})
