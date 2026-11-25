import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 3, Task 10: database server, database, target and app-creation routes.
// Real SQLite holds every Hub row and the real services run; the database server is a fake
// provisioner, the planner's remote looks are injected, and the creation steps after `database`
// are stand-ins (the runner's own tests walk the real ones). Every answer and activity row is
// swept for secrets at the end.

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
vi.mock('../../../middleware/authenticate.js', () => {
  const sign = async (req: {
    headers: Record<string, string | undefined>
    user?: unknown
    isAdmin?: boolean
  }) => {
    const id = req.headers['x-user']
    if (!id) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id, status: 'active' }
    req.isAdmin = req.headers['x-admin'] === '1'
  }
  const admin = async (req: Parameters<typeof sign>[0]) => {
    await sign(req)
    if (!req.isAdmin)
      throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'ADMIN_ONLY' })
  }
  return { requireAuth: vi.fn(sign), requireAdmin: vi.fn(admin), authenticate: vi.fn(sign) }
})

const activity: Array<Record<string, unknown>> = []
vi.mock('../../../services/activity.js', () => ({
  logActivity: async (o: Record<string, unknown>) => {
    const { req: _req, ...rest } = o
    activity.push(rest)
    return 1
  }
}))

const m = vi.hoisted(() => ({
  maint: vi.fn(),
  hold: null as null | { key: string; until: Promise<void> },
  deploy: null as null | (() => Promise<unknown>),
  sync: vi.fn(),
  recover: vi.fn(),
  waits: vi.fn(),
  resume: vi.fn(),
  installed: vi.fn(),
  testTarget: null as null | (() => Promise<unknown>)
}))
vi.mock('../../../services/security.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/security.js')>()),
  maintenanceState: m.maint
}))
vi.mock('../../../services/job-runs.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/job-runs.js')>()),
  startJobRun: async () => ({
    id: null,
    progress() {},
    log() {},
    async complete() {},
    async fail() {}
  }),
  readJobLog: async () => []
}))

// The fake database server: an app database is empty unless listed in `appState`.
const appState = new Map<string, string>()
/** Connections the fake made as an app login (each one a login try against a host). */
const connects: string[] = []
const connectTls: Array<{ ssl_mode: unknown; trust_server_cert: unknown }> = []
vi.mock('../../../services/hub/db/provisioner.js', async (orig) => {
  const real = (await orig()) as typeof import('../../../services/hub/db/provisioner.js')
  let lastApp = ''
  const prov = {
    engine: 'pg',
    async probe() {
      return { ok: true, version: '16.0', can_create: true, missing: [], text: 'ok' }
    },
    async databaseExists() {
      return false
    },
    async loginExists() {
      return false
    },
    async ensureLogin() {
      return 'created'
    },
    async ensureDatabase() {
      return 'created'
    },
    async ensureOwner() {},
    async drop() {},
    async checkApp() {
      const state = appState.get(lastApp) ?? 'empty'
      return {
        state,
        ok: state === 'empty' || state === 'nivaro',
        version: '16.0',
        migrations: null,
        last_migration: null,
        text: `Checked: ${state}`,
        at: new Date().toISOString()
      }
    }
  }
  return {
    ...real,
    provisionerFor: () => prov,
    withServerKnex: async (_s: unknown, _a: unknown, fn: (k: unknown) => Promise<unknown>) =>
      fn({ admin: true }),
    withAppKnex: async (
      conn: { database: string; host: string },
      fn: (k: unknown) => Promise<unknown>
    ) => {
      lastApp = conn.database
      connects.push(`${conn.host}:${(conn as { port?: number | null }).port ?? ''}`)
      connectTls.push({
        ssl_mode: (conn as { ssl_mode?: unknown }).ssl_mode,
        trust_server_cert: (conn as { trust_server_cert?: unknown }).trust_server_cert
      })
      return fn({ raw: async () => [{ s: conn.host, p: 5432, d: conn.database }] })
    }
  }
})

// The planner's remote looks: Docker Hub answers a digest, GitLab has no project, the Hub URL is set.
vi.mock('../../../services/hub/create/gather.js', async (orig) => {
  const real = (await orig()) as typeof import('../../../services/hub/create/gather.js')
  return {
    ...real,
    gatherCreationFacts: (input: Parameters<typeof real.gatherCreationFacts>[0]) =>
      real.gatherCreationFacts(input, {
        env: { HUB_URL: 'https://hub.example.com' } as unknown as NodeJS.ProcessEnv,
        imageDigest: async (_i, tag) => `sha256:${(tag.endsWith('-slim') ? 'b' : 'a').repeat(64)}`,
        projectExists: async () => false,
        databaseExists: async () => false,
        encryptionKey: () => true,
        timeoutMs: 500
      })
  }
})

// Steps after `database` are stand-ins; `m.hold` parks a leg inside one step.
vi.mock('../../../services/hub/create/steps.js', async (orig) => {
  const real = (await orig()) as typeof import('../../../services/hub/create/steps.js')
  const stub = (key: string) => async () => {
    if (m.hold?.key === key) await m.hold.until
    if (key === 'deploy' && m.deploy) return m.deploy()
    return { status: 'done', note: `${key} stand-in` }
  }
  const database = real.STEPS.database
  return {
    ...real,
    STEPS: {
      database: async (ctx: Parameters<typeof database>[0]) => {
        if (m.hold?.key === 'database') await m.hold.until
        return database(ctx)
      },
      repository: stub('repository'),
      variables: stub('variables'),
      config: stub('config'),
      deploy: stub('deploy'),
      name: stub('name'),
      link: stub('link'),
      admin: stub('admin'),
      template: stub('template')
    }
  }
})

vi.mock('../../../services/hub/create/run.js', async (orig) => {
  const real = (await orig()) as typeof import('../../../services/hub/create/run.js')
  m.sync.mockImplementation(real.syncTargetApps)
  m.recover.mockImplementation(real.recoverCreationsAtBoot)
  m.waits.mockImplementation(real.checkWaitingCreations)
  m.resume.mockImplementation(real.resumeCreation)
  m.installed.mockImplementation(real.confirmOperatorInstalled)
  return {
    ...real,
    syncTargetApps: m.sync,
    recoverCreationsAtBoot: m.recover,
    checkWaitingCreations: m.waits,
    resumeCreation: m.resume,
    confirmOperatorInstalled: m.installed
  }
})

vi.mock('../../../services/hub/create/targets.js', async (orig) => {
  const real = (await orig()) as typeof import('../../../services/hub/create/targets.js')
  return {
    ...real,
    testTarget: (id: number) => (m.testTarget ? m.testTarget() : real.testTarget(id))
  }
})

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const m542 = await import('../../../db/migrations/542_hub_tables.js')
const m543 = await import('../../../db/migrations/543_hub_promotions.js')
const m544 = await import('../../../db/migrations/544_hub_databases.js')
const m545 = await import('../../../db/migrations/545_hub_creations.js')
// Phase 7 merge: an environment delete also clears its sign-in client and switcher rows.
// X-6a: an environment delete also clears its stack settings (546).
const m546 = await import('../../../db/migrations/546_hub_stack_settings.js')
const m550 = await import('../../../db/migrations/550_hub_oidc.js')
const m551 = await import('../../../db/migrations/551_hub_signins.js')
const { hubRoutes } = await import('../../../routes/hub.js')
const { countOwnerTry } = await import('../../../routes/hub-create.js')
const { maintenanceFreezeHook } = await import('../../../services/maintenance-freeze.js')
const R = await import('../../../services/hub/create/run.js')
const store = await import('../../../services/hub/create/store.js')
const { memoryPromoteLock } = await import('../../../services/hub/promote-lock.js')
const { HUB_MASK, sealSecret } = await import('../../../services/hub/secrets.js')
const { GitlabWriteError } = await import('../../../services/hub/gitlab-write.js')
const { hubAppLinkRoutes } = await import('../../../routes/hub-app-link.js')
const { environmentForLinkToken, _resetLinkTokenForTests } = await import(
  '../../../services/hub/link-token.js'
)
const { openSecret } = await import('../../../services/hub/secrets.js')

const KEY = 'f'.repeat(64)
const ADMIN_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const OWNER = 'bbbbbbbb-0000-4000-8000-000000000002'
const OTHER = 'cccccccc-0000-4000-8000-000000000003'
const asAdmin = { 'x-user': ADMIN_ID, 'x-admin': '1' }
const asOwner = { 'x-user': OWNER }
const asOther = { 'x-user': OTHER }

const ADMIN_LOGIN = { user: 'hubprovisioner', password: 'Adm1n-provisioning-Secret' }
const GITLAB_TOKEN = 'glpat-target-token-Secret-0123'
const OIDC_SECRET = 'oidc-client-Secret-value-4567'
const DBA_PASSWORD = 'DbaGiv3n-Passw0rd-secret'
const SECRETS = [ADMIN_LOGIN.password, GITLAB_TOKEN, OIDC_SECRET, DBA_PASSWORD]

const targetConfig = {
  api: 'https://gitlab.example.com',
  namespace: 'apps',
  template_project: 'apps/nivaro-template',
  template_ref: 'v1.0.0',
  pin_file: '.hub/nivaro-version',
  deploy_job: 'deploy',
  deploy_host: 'deploy@swarm1.example.com',
  manager_known_hosts: `swarm1.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'k'.repeat(43)}`,
  proxy_network: 'proxy',
  dns_mode: 'automatic',
  wildcard_domain: 'apps.example.com',
  edge_address: null,
  scheme: 'https',
  port: null,
  cert_note: null
}

let app: FastifyInstance
let prevHub: string | undefined
let prevKey: string | undefined
const answers: string[] = []
const cron = { schedule: vi.fn() }

let targetId: number
let autoServer: number
let manualServer: number

const url = (p: string) => `/api/hub${p}`
async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  p: string,
  headers: Record<string, string>,
  payload?: unknown
) {
  const res = await app.inject({ method, url: url(p), headers, payload: payload as never })
  answers.push(res.body)
  return res
}

const insertId = async (table: string, row: Record<string, unknown>) => {
  await db(table).insert(row)
  return Number((await db(table).max('id as id').first())?.id)
}

const HUB_TABLES = [
  'nivaro_hub_creations',
  'nivaro_hub_databases',
  'nivaro_hub_db_servers',
  'nivaro_hub_components',
  'nivaro_hub_placements',
  'nivaro_hub_drivers',
  'nivaro_hub_environments',
  'nivaro_hub_app_owners',
  'nivaro_hub_apps',
  'nivaro_hub_targets'
]

async function counts() {
  const out: Record<string, number> = {}
  for (const t of HUB_TABLES)
    out[t] = Number(((await db(t).count('* as n').first()) as { n: number }).n)
  return out
}

function createInput(over: Record<string, unknown> = {}) {
  return {
    key: 'demo',
    name: 'Demo',
    owners: [OWNER],
    first_admin: { email: 'ada@example.com', first_name: 'Ada' },
    target_id: targetId,
    version: '1.2.3',
    signin: {
      issuer: 'https://login.microsoftonline.com/tenant/v2.0',
      client_id: 'client-123',
      client_secret: OIDC_SECRET
    },
    environments: [{ key: 'production', database: { server_id: autoServer } }],
    ...over
  }
}

/** Creates an app through the route and waits for its legs. */
async function created(over: Record<string, unknown> = {}) {
  const res = await call('POST', '/apps/create', asAdmin, createInput(over))
  expect(res.statusCode, res.body).toBe(202)
  const data = res.json().data as {
    app_id: number
    environments: Array<{ id: number; key: string }>
  }
  for (const e of data.environments) await R.awaitCreation(e.id)
  return data
}

beforeAll(async () => {
  prevHub = process.env.HUB
  prevKey = process.env.ENCRYPTION_KEY
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = KEY
  await m542.up(db)
  await m543.up(db)
  await m544.up(db)
  await m545.up(db)
  await m546.up(db)
  await m550.up(db)
  await m551.up(db)
  await db.schema.createTable('nivaro_users', (t) => t.uuid('id').primary())
  await db('nivaro_users').insert([{ id: ADMIN_ID }, { id: OWNER }, { id: OTHER }])
  app = Fastify()
  app.decorate('cron', cron as never)
  app.addHook('preHandler', maintenanceFreezeHook)
  await app.register(hubRoutes, { prefix: '/api/hub' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  // Nothing secret in any answer or activity row (Global Constraints).
  const all = [...answers, JSON.stringify(activity)].join('\n')
  for (const s of SECRETS) {
    expect(all.includes(s), 'secret in an answer').toBe(false)
    expect(all.includes(Buffer.from(s).toString('base64')), 'secret (base64) in an answer').toBe(
      false
    )
  }
  await db.destroy()
  if (prevHub === undefined) delete process.env.HUB
  else process.env.HUB = prevHub
  if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = prevKey
})

beforeEach(async () => {
  for (const t of HUB_TABLES) await db(t).del()
  activity.length = 0
  appState.clear()
  connects.length = 0
  connectTls.length = 0
  m.hold = null
  m.deploy = null
  m.testTarget = null
  m.maint.mockResolvedValue({ on: false })
  for (const f of [m.sync, m.resume, m.installed]) f.mockClear()
  targetId = await insertId('nivaro_hub_targets', {
    kind: 'gitlab',
    name: 'apps',
    config: JSON.stringify(targetConfig),
    secret: sealSecret(GITLAB_TOKEN)
  })
  autoServer = await insertId('nivaro_hub_db_servers', {
    name: 'pg-auto',
    engine: 'pg',
    host: 'pg1.example.com',
    port: 5432,
    provision_mode: 'automatic',
    admin_secret: sealSecret(JSON.stringify(ADMIN_LOGIN))
  })
  manualServer = await insertId('nivaro_hub_db_servers', {
    name: 'dba-pg',
    engine: 'pg',
    host: 'pg2.example.com',
    port: 5432,
    provision_mode: 'manual'
  })
})

// ── wiring ───────────────────────────────────────────────────────────────────

describe('wiring', () => {
  it('runs recovery once on ready and schedules the 5-minute creation cron', async () => {
    // Boot recovery: the lock is not asked, and a second pass is scheduled (P3-33).
    expect(m.recover).toHaveBeenCalledTimes(1)
    expect(m.recover.mock.calls[0][0]).toBeUndefined()
    const [id, expr, fn] = cron.schedule.mock.calls.find((c) => c[0] === 'hub-creation-waits') ?? []
    expect(id).toBe('hub-creation-waits')
    expect(expr).toBe('*/5 * * * *')
    expect(cron.schedule.mock.calls.filter((c) => c[0] === 'hub-creation-waits')).toHaveLength(1)
    m.waits.mockClear()
    await (fn as () => Promise<void>)()
    // Called with no arguments: never the cron's arguments read as deps.
    expect(m.waits).toHaveBeenCalledTimes(1)
    expect(m.waits.mock.calls[0]).toEqual([])
  })

  it('registers nothing with hub mode off', async () => {
    delete process.env.HUB
    const off = Fastify()
    await off.register(hubRoutes, { prefix: '/api/hub' })
    await off.ready()
    for (const [method, p] of [
      ['GET', '/db-servers'],
      ['GET', '/targets'],
      ['GET', '/databases'],
      ['POST', '/apps/create/plan'],
      ['POST', '/apps/create']
    ] as const)
      expect((await off.inject({ method, url: url(p), headers: asAdmin })).statusCode).toBe(404)
    await off.close()
    process.env.HUB = 'on'
  })
})

// ── access ───────────────────────────────────────────────────────────────────

describe('access', () => {
  it('non-admins get 403 on every admin write and list', async () => {
    const calls: Array<[Parameters<typeof call>[0], string]> = [
      ['GET', '/db-servers'],
      ['POST', '/db-servers'],
      ['PATCH', `/db-servers/${autoServer}`],
      ['DELETE', `/db-servers/${autoServer}`],
      ['POST', `/db-servers/${autoServer}/test`],
      ['GET', '/databases'],
      ['POST', '/databases/adopt'],
      ['DELETE', '/databases/1'],
      ['GET', '/targets'],
      ['POST', '/targets'],
      ['PATCH', `/targets/${targetId}`],
      ['DELETE', `/targets/${targetId}`],
      ['POST', `/targets/${targetId}/test`],
      ['POST', '/apps/create/plan'],
      ['POST', '/apps/create'],
      ['POST', '/environments/1/creation/retry'],
      ['POST', '/environments/1/creation/cancel']
    ]
    for (const [method, p] of calls)
      expect((await call(method, p, asOwner, {})).statusCode, `${method} ${p}`).toBe(403)
    expect(await counts()).toMatchObject({ nivaro_hub_apps: 0, nivaro_hub_db_servers: 2 })
  })

  it('an owner reads their environment’s creation and database; anyone else gets 404', async () => {
    const out = await created({
      environments: [{ key: 'production', database: { server_id: manualServer } }]
    })
    const envId = out.environments[0].id
    const dbId = Number(
      String((await db('nivaro_hub_environments').where({ id: envId }).first()).db_ref).split(
        ':'
      )[1]
    )
    for (const h of [asOwner, asAdmin]) {
      const c = await call('GET', `/environments/${envId}/creation`, h)
      expect(c.statusCode).toBe(200)
      expect(c.json().data).toMatchObject({ status: 'waiting', waiting_for: 'database' })
      const d = await call('GET', `/databases/${dbId}`, h)
      expect(d.statusCode).toBe(200)
      expect(d.json().data.status).toBe('requested')
      expect(d.json().data.checklist.map((i: { label: string }) => i.label)).toContain('Login')
      // P3-29: the row carries its server's TLS (never its login) for the connection form.
      const server = await db('nivaro_hub_db_servers')
        .where({ id: d.json().data.server_id })
        .first('ssl_mode', 'trust_server_cert')
      expect(d.json().data.server_tls).toEqual({
        ssl_mode: server.ssl_mode ?? null,
        trust_server_cert: Boolean(server.trust_server_cert)
      })
      expect(JSON.stringify(d.json().data)).not.toContain(ADMIN_LOGIN.password)
    }
    for (const [method, p] of [
      ['GET', `/environments/${envId}/creation`],
      ['POST', `/environments/${envId}/creation/check`],
      ['POST', `/environments/${envId}/creation/installed`],
      ['GET', `/databases/${dbId}`],
      ['PUT', `/databases/${dbId}/connection`],
      ['POST', `/databases/${dbId}/check`]
    ] as const)
      expect((await call(method, p, asOther, {})).statusCode, `${method} ${p}`).toBe(404)
    expect((await call('GET', '/environments/99999/creation', asAdmin)).statusCode).toBe(404)

    // The owner of a different app is no owner here.
    const otherApp = await insertId('nivaro_hub_apps', {
      key: 'other',
      name: 'Other',
      signin_mode: 'direct',
      extensions: '[]'
    })
    await db('nivaro_hub_app_owners').insert({ app_id: otherApp, user_id: OTHER })
    expect((await call('GET', `/databases/${dbId}`, asOther)).statusCode).toBe(404)
    expect((await call('GET', `/environments/${envId}/creation`, asOther)).statusCode).toBe(404)
  })

  it('the creation view carries the server’s TLS (P3-24) and nothing secret', async () => {
    await db('nivaro_hub_db_servers')
      .where({ id: manualServer })
      .update({
        ssl_mode: 'verify-full',
        trust_server_cert: true,
        admin_secret: sealSecret(JSON.stringify(ADMIN_LOGIN))
      })
    const out = await created({
      environments: [{ key: 'production', database: { server_id: manualServer } }]
    })
    const envId = out.environments[0].id
    for (const h of [asOwner, asAdmin]) {
      const c = await call('GET', `/environments/${envId}/creation`, h)
      expect(c.statusCode).toBe(200)
      const tls = c.json().data.database.server_tls
      expect(tls).toEqual({ ssl_mode: 'verify-full', trust_server_cert: true })
      expect(c.body).not.toContain(ADMIN_LOGIN.password)
      expect(c.body).not.toContain('admin_secret')
    }
  })
})

// ── servers ──────────────────────────────────────────────────────────────────

describe('database servers', () => {
  it('answers the provisioning login only as the mask; the mask re-sent keeps it', async () => {
    const res = await call('POST', '/db-servers', asAdmin, {
      name: 'mysql-auto',
      engine: 'mysql2',
      host: 'my1.example.com',
      provision_mode: 'automatic',
      admin_secret: { user: 'root', password: ADMIN_LOGIN.password }
    })
    expect(res.statusCode, res.body).toBe(200)
    const id = res.json().data.id
    expect(res.json().data.admin_secret).toBe(HUB_MASK)
    const list = (await call('GET', '/db-servers', asAdmin)).json().data
    for (const s of list) expect([HUB_MASK, null]).toContain(s.admin_secret)
    const sealed = (await db('nivaro_hub_db_servers').where({ id }).first()).admin_secret

    // Partial PATCH: the stored row fills the rest (validateServerInput gets `existing`).
    const p1 = await call('PATCH', `/db-servers/${id}`, asAdmin, { notes: 'rack 4' })
    expect(p1.statusCode, p1.body).toBe(200)
    expect(p1.json().data).toMatchObject({ name: 'mysql-auto', notes: 'rack 4' })
    const p2 = await call('PATCH', `/db-servers/${id}`, asAdmin, { admin_secret: HUB_MASK })
    expect(p2.statusCode).toBe(200)
    expect(p2.json().data.admin_secret).toBe(HUB_MASK)
    expect((await db('nivaro_hub_db_servers').where({ id }).first()).admin_secret).toBe(sealed)
    // Moving the server keeps no stored login (the service's SECRET_REQUIRED, mapped to 400).
    const moved = await call('PATCH', `/db-servers/${id}`, asAdmin, { host: 'my2.example.com' })
    expect(moved.statusCode).toBe(400)
    expect(moved.json().code).toBe('SECRET_REQUIRED')
    expect(activity.map((a) => a.action)).toEqual(['create', 'update', 'update'])
    expect(activity[1].changed_fields).toEqual(['notes'])
    expect(activity[2].changed_fields).toEqual([])
    // P3-26 (d): both halves sent back masked keep the stored login — not a change.
    const p3 = await call('PATCH', `/db-servers/${id}`, asAdmin, {
      notes: 'rack 5',
      admin_secret: { user: HUB_MASK, password: HUB_MASK }
    })
    expect(p3.statusCode, p3.body).toBe(200)
    expect((await db('nivaro_hub_db_servers').where({ id }).first()).admin_secret).toBe(sealed)
    expect(activity[3].changed_fields).toEqual(['notes'])
    // A new login is a change.
    await call('PATCH', `/db-servers/${id}`, asAdmin, {
      admin_secret: { user: 'root', password: 'another-secret-value' }
    })
    expect(activity[4].changed_fields).toEqual(['admin_secret'])
  })

  it('maps service refusals: NAME_TAKEN 409, IN_USE 409, unknown 404; Test answers the probe', async () => {
    const dup = await call('POST', '/db-servers', asAdmin, {
      name: 'PG-AUTO',
      engine: 'pg',
      host: 'x.example.com',
      provision_mode: 'manual'
    })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().code).toBe('NAME_TAKEN')
    await created()
    const inUse = await call('DELETE', `/db-servers/${autoServer}`, asAdmin)
    expect(inUse.statusCode).toBe(409)
    expect(inUse.json().code).toBe('IN_USE')
    expect((await call('PATCH', '/db-servers/999999', asAdmin, { name: 'x' })).statusCode).toBe(404)
    expect((await call('POST', '/db-servers/999999/test', asAdmin)).statusCode).toBe(404)
    const probe = await call('POST', `/db-servers/${autoServer}/test`, asAdmin)
    expect(probe.json().data).toMatchObject({ ok: true, can_create: true })
    const del = await call('DELETE', `/db-servers/${manualServer}`, asAdmin)
    expect(del.statusCode).toBe(200)
  })
})

// ── targets ──────────────────────────────────────────────────────────────────

describe('targets', () => {
  it('answers the token only as the mask; the mask re-sent keeps it; PATCH syncs the apps', async () => {
    const res = await call('POST', '/targets', asAdmin, {
      kind: 'gitlab',
      name: 'corp',
      config: { ...targetConfig, namespace: 'corp' },
      secret: GITLAB_TOKEN
    })
    expect(res.statusCode, res.body).toBe(200)
    const id = res.json().data.id
    expect(res.json().data.secret).toBe(HUB_MASK)
    for (const t of (await call('GET', '/targets', asAdmin)).json().data)
      expect(t.secret).toBe(HUB_MASK)
    const sealed = (await db('nivaro_hub_targets').where({ id }).first()).secret
    const p = await call('PATCH', `/targets/${id}`, asAdmin, {
      secret: HUB_MASK,
      config: { template_ref: 'v1.1.0' }
    })
    expect(p.statusCode, p.body).toBe(200)
    expect(p.json().data.config.template_ref).toBe('v1.1.0')
    expect(p.json().sync).toEqual([])
    expect((await db('nivaro_hub_targets').where({ id }).first()).secret).toBe(sealed)
    // The mask kept the token: no previous token to hand to the app drivers.
    expect(m.sync).toHaveBeenCalledWith(id, { previousSecret: null })
    // A new token: the previous sealed one goes along (P3-32, app driver copies follow).
    m.sync.mockClear()
    const rotated = await call('PATCH', `/targets/${id}`, asAdmin, {
      secret: 'glpat-rotated-0123456789abcdef'
    })
    expect(rotated.statusCode, rotated.body).toBe(200)
    expect(m.sync).toHaveBeenCalledWith(id, { previousSecret: sealed })
    // The mask re-sent kept the token: not a change.
    expect(activity.find((a) => a.action === 'update')?.changed_fields).toEqual(['config'])
  })

  it('a refused PATCH does not sync; a target an app uses cannot go', async () => {
    const bad = await call('PATCH', `/targets/${targetId}`, asAdmin, { config: { dns_mode: 'x' } })
    expect(bad.statusCode).toBe(400)
    expect(m.sync).not.toHaveBeenCalled()
    await created()
    const del = await call('DELETE', `/targets/${targetId}`, asAdmin)
    expect(del.statusCode).toBe(409)
    expect(del.json().code).toBe('IN_USE')
  })

  it('a mask re-sent while the GitLab address changes is SECRET_REQUIRED', async () => {
    const res = await call('PATCH', `/targets/${targetId}`, asAdmin, {
      secret: HUB_MASK,
      config: { api: 'https://gitlab.other.example.com' }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('SECRET_REQUIRED')
    expect(m.sync).not.toHaveBeenCalled()
  })

  it('a sync that cannot start never turns the saved PATCH into a 500', async () => {
    m.sync.mockRejectedValueOnce(new Error(`db down ${GITLAB_TOKEN}`))
    const res = await call('PATCH', `/targets/${targetId}`, asAdmin, { name: 'renamed' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      data: { name: 'renamed' },
      sync: null,
      sync_error: 'SYNC_READ_FAILED'
    })
    expect((await db('nivaro_hub_targets').where({ id: targetId }).first()).name).toBe('renamed')
  })

  it('an unknown error is a fixed 500 HUB_ERROR without its text', async () => {
    m.testTarget = async () => {
      throw new Error(`driver said ${GITLAB_TOKEN} at 10.0.0.5`)
    }
    const res = await call('POST', `/targets/${targetId}/test`, asAdmin)
    expect(res.statusCode).toBe(500)
    expect(res.json().code).toBe('HUB_ERROR')
    expect(res.body).not.toContain('10.0.0.5')
  })

  it('maps GitlabWriteError to 502 with its code, HubSecretError to 400 with its code', async () => {
    m.testTarget = async () => {
      throw new GitlabWriteError('GITLAB_UNREACHABLE', 'GitLab did not answer at 10.0.0.5', {
        step: 'currentUser'
      })
    }
    const t = await call('POST', `/targets/${targetId}/test`, asAdmin)
    expect(t.statusCode).toBe(502)
    expect(t.json()).toEqual({ code: 'GITLAB_UNREACHABLE', error: 'GitLab did not answer' })
    delete process.env.ENCRYPTION_KEY
    try {
      const s = await call('POST', '/targets', asAdmin, {
        kind: 'gitlab',
        name: 'nokey',
        config: targetConfig,
        secret: GITLAB_TOKEN
      })
      expect(s.statusCode).toBe(400)
      expect(s.json().code).toBe('HUB_NEEDS_ENCRYPTION_KEY')
    } finally {
      process.env.ENCRYPTION_KEY = KEY
    }
  })
})

// ── databases ────────────────────────────────────────────────────────────────

describe('databases', () => {
  it('lists masked connections; adopt records a ready row; detach and drop need the name', async () => {
    const adopt = await call('POST', '/databases/adopt', asAdmin, {
      engine: 'pg',
      host: 'pg9.example.com',
      database: 'legacy_app',
      user: 'legacy',
      password: DBA_PASSWORD
    })
    expect(adopt.statusCode, adopt.body).toBe(200)
    const id = adopt.json().data.id
    expect(adopt.json().data).toMatchObject({
      status: 'ready',
      adopted: true,
      connection: HUB_MASK
    })
    for (const d of (await call('GET', '/databases', asAdmin)).json().data)
      expect([HUB_MASK, null]).toContain(d.connection)
    expect((await call('GET', `/databases/${id}`, asAdmin)).json().data).toMatchObject({
      connection: HUB_MASK,
      checklist: null
    })
    const wrong = await call('DELETE', `/databases/${id}`, asAdmin, { confirm: 'nope' })
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json().code).toBe('CONFIRM_REQUIRED')
    const drop = await call('DELETE', `/databases/${id}`, asAdmin, {
      confirm: 'legacy_app',
      drop: true
    })
    expect(drop.statusCode).toBe(409)
    expect(drop.json().code).toBe('DROP_NOT_ALLOWED')
    const ok = await call('DELETE', `/databases/${id}`, asAdmin, { confirm: 'legacy_app' })
    expect(ok.json().data).toEqual({ id, dropped: false })
    expect(activity.map((a) => a.action)).toEqual(['hub-db-adopt', 'delete'])
    const foreign = await (async () => {
      appState.set('other_app', 'foreign')
      return call('POST', '/databases/adopt', asAdmin, {
        engine: 'pg',
        host: 'pg9.example.com',
        database: 'other_app',
        user: 'other',
        password: DBA_PASSWORD
      })
    })()
    expect(foreign.statusCode).toBe(409)
    expect(foreign.json().code).toBe('DATABASE_NOT_NIVARO')
    // P3-32: a Nivaro install is adopted, with a plain warning (never a refusal).
    expect(adopt.json().warning).toBeUndefined()
    appState.set('old_nivaro', 'nivaro')
    const nivaro = await call('POST', '/databases/adopt', asAdmin, {
      engine: 'pg',
      host: 'pg9.example.com',
      database: 'old_nivaro',
      user: 'old',
      password: DBA_PASSWORD
    })
    expect(nivaro.statusCode, nivaro.body).toBe(200)
    expect(nivaro.json().data.status).toBe('ready')
    expect(nivaro.json().warning).toMatch(
      /^old_nivaro already holds a Nivaro install: the app starts on that data/
    )
  })

  it('an owner’s DBA connection makes the database ready and resumes the waiting creation', async () => {
    const out = await created({
      environments: [{ key: 'production', database: { server_id: manualServer } }]
    })
    const envId = out.environments[0].id
    const dbId = Number(
      String((await db('nivaro_hub_environments').where({ id: envId }).first()).db_ref).split(
        ':'
      )[1]
    )
    const row = (await db('nivaro_hub_databases').where({ id: dbId }).first()) as {
      database_name: string
      login_name: string
    }
    // Not yet empty: the check is stored, the creation keeps waiting.
    appState.set(row.database_name, 'foreign')
    const first = await call('PUT', `/databases/${dbId}/connection`, asOwner, {
      host: 'pg2.example.com',
      port: 5432,
      database: row.database_name,
      user: row.login_name,
      password: DBA_PASSWORD
    })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().data.status).toBe('requested')
    expect(first.json().check.state).toBe('foreign')
    expect(first.json().creation).toBeNull()
    expect(m.resume).not.toHaveBeenCalled()

    // Emptied: Check now makes it ready and the creation moves on.
    appState.set(row.database_name, 'empty')
    const check = await call('POST', `/databases/${dbId}/check`, asOwner)
    expect(check.statusCode).toBe(200)
    expect(check.json().data.state).toBe('empty')
    expect(check.json().creation).toEqual({ status: 'running' })
    expect(m.resume).toHaveBeenCalledWith(envId, { id: OWNER }, 'check')
    await R.awaitCreation(envId)
    expect((await store.readCreationRow(envId))?.status).toBe('done')
    expect(activity.map((a) => a.action)).toEqual(
      expect.arrayContaining(['hub-db-connection', 'hub-db-check', 'hub-create-check'])
    )
  })

  it('a connection that is ready at once resumes the creation (PUT)', async () => {
    const out = await created({
      environments: [{ key: 'production', database: { server_id: manualServer } }]
    })
    const envId = out.environments[0].id
    const dbId = Number(
      String((await db('nivaro_hub_environments').where({ id: envId }).first()).db_ref).split(
        ':'
      )[1]
    )
    const row = await db('nivaro_hub_databases').where({ id: dbId }).first()
    const res = await call('PUT', `/databases/${dbId}/connection`, asAdmin, {
      connection: {
        host: 'pg2.example.com',
        database: row.database_name,
        user: row.login_name,
        password: DBA_PASSWORD
      }
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().data).toMatchObject({
      status: 'ready',
      connection: HUB_MASK,
      checklist: null
    })
    expect(res.json().creation).toEqual({ status: 'running' })
    await R.awaitCreation(envId)
    expect((await store.readCreationRow(envId))?.status).toBe('done')
  })
})

// ── creation ─────────────────────────────────────────────────────────────────

describe('creation', () => {
  it('X-4: an app created after the boot repair passes the app link at once (no restart)', async () => {
    _resetLinkTokenForTests()
    // The once-per-process repair runs on the first miss; after it every miss is final.
    expect(await environmentForLinkToken('x'.repeat(48))).toBeNull()
    const out = await created()
    const envId = out.environments[0].id
    const row = await db('nivaro_hub_environments').where({ id: envId }).first()
    const plain = openSecret(row.hub_token) as string
    expect(row.hub_token_lookup).toBeTruthy()
    expect((await environmentForLinkToken(plain))?.environment_id).toBe(envId)
    // and through the app-link route itself
    const link = Fastify()
    link.decorate('redis', {
      get: async () => null,
      incrby: async () => 1,
      expire: async () => 1
    } as never)
    await link.register(hubAppLinkRoutes, { prefix: '/api/hub/app-link' })
    await link.ready()
    try {
      const res = await link.inject({
        method: 'POST',
        url: '/api/hub/app-link/switcher',
        headers: { authorization: `Bearer ${plain}` },
        payload: { email: 'pat@example.com' }
      })
      expect(res.statusCode, res.body).toBe(200)
    } finally {
      await link.close()
    }
  })

  it('/apps/create/plan answers the plan and writes nothing', async () => {
    const before = await counts()
    const res = await call('POST', '/apps/create/plan', asAdmin, createInput())
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().data).toMatchObject({ ok: true, app: { key: 'demo' } })
    expect(res.json().data.environments[0]).toMatchObject({
      key: 'production',
      hostname: 'demo.apps.example.com'
    })
    expect(await counts()).toEqual(before)
    expect(activity).toEqual([])
  })

  it('reused blocker codes carry env and text (Task 12 highlights by them)', async () => {
    const res = await call(
      'POST',
      '/apps/create/plan',
      asAdmin,
      createInput({
        first_admin: { email: 'ada@example.com', first_name: 'x'.repeat(500) },
        environments: [
          { key: 'staging', database: { server_id: autoServer, login_name: 'shared_login' } },
          { key: 'production', database: { server_id: autoServer, login_name: 'shared_login' } }
        ]
      })
    )
    const plan = res.json().data
    expect(plan.ok).toBe(false)
    const name = plan.blockers.find((b: { code: string }) => b.code === 'BAD_EMAIL')
    expect(name).toMatchObject({ code: 'BAD_EMAIL', text: expect.stringMatching(/name/i) })
    expect(name.env).toBeUndefined()
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({
        code: 'DATABASE_RECORDED',
        env: 'production',
        text: expect.any(String)
      })
    )
  })

  it('/apps/create answers 202, then the app, environment and creation exist', async () => {
    const out = await created()
    expect(out.environments.map((e) => e.key)).toEqual(['production'])
    const appRow = await db('nivaro_hub_apps').where({ id: out.app_id }).first()
    expect(appRow.key).toBe('demo')
    const env = await db('nivaro_hub_environments').where({ id: out.environments[0].id }).first()
    expect(env.status).toBe('active')
    expect((await store.readCreationRow(env.id))?.status).toBe('done')
    expect(activity.find((a) => a.action === 'hub-create-start')).toMatchObject({
      collection: 'nivaro_hub_apps',
      item: String(out.app_id)
    })
    const view = await call('GET', `/environments/${env.id}/creation`, asAdmin)
    expect(view.json().data).toMatchObject({
      status: 'done',
      app_key: 'demo',
      env_key: 'production'
    })
    expect(JSON.stringify(view.json())).not.toContain('nonce')
  })

  it('blockers answer 409 with every blocker and write nothing', async () => {
    await created()
    const before = await counts()
    const res = await call('POST', '/apps/create', asAdmin, createInput({ version: 'latest' }))
    expect(res.statusCode).toBe(409)
    const b = res.json()
    expect(b.code).toBe('KEY_TAKEN')
    expect(b.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'KEY_TAKEN', text: expect.any(String) }),
        expect.objectContaining({ code: 'BAD_VERSION', text: expect.any(String) })
      ])
    )
    expect(await counts()).toEqual(before)
  })

  it('app and environment deletes are refused while a leg runs, then remove the creation rows', async () => {
    let release = () => {}
    m.hold = { key: 'repository', until: new Promise<void>((r) => (release = r)) }
    const res = await call('POST', '/apps/create', asAdmin, createInput())
    expect(res.statusCode).toBe(202)
    const { app_id: appId, environments } = res.json().data
    const envId = environments[0].id
    for (let i = 0; i < 100 && (await store.readCreationRow(envId))?.step !== 'repository'; i++)
      await new Promise((r) => setTimeout(r, 5))
    const a = await call('DELETE', `/apps/${appId}`, asAdmin)
    expect(a.statusCode).toBe(409)
    expect(a.json().code).toBe('CREATION_RUNNING')
    const e = await call('DELETE', `/environments/${envId}`, asAdmin)
    expect(e.statusCode).toBe(409)
    expect(e.json().code).toBe('CREATION_RUNNING')
    release()
    await R.awaitCreation(envId)
    expect((await store.readCreationRow(envId))?.status).toBe('done')

    // Quiet now: the app still has its environment; the environment delete takes its creation.
    expect((await call('DELETE', `/apps/${appId}`, asAdmin)).json().code).toBe('HAS_ENVIRONMENTS')
    expect((await call('DELETE', `/environments/${envId}`, asAdmin)).statusCode).toBe(200)
    expect(
      await db('nivaro_hub_creations').where({ environment_id: envId }).first()
    ).toBeUndefined()
    expect((await call('DELETE', `/apps/${appId}`, asAdmin)).statusCode).toBe(200)
    expect(await db('nivaro_hub_creations').where({ app_id: appId }).first()).toBeUndefined()
  })

  it.each([
    ['promotion', 'PROMOTION_RUNNING'],
    ['stack', 'STACK_BUSY'],
    ['creation', 'CREATION_RUNNING']
  ] as const)('X-6b: a %s holding the environment refuses the delete, named (%s)', async (holder, code) => {
    const out = await created()
    const envId = out.environments[0].id
    const token = (await memoryPromoteLock.take(envId, holder)) as string
    try {
      expect((await call('DELETE', `/environments/${envId}`, asAdmin)).json().code).toBe(code)
    } finally {
      await memoryPromoteLock.release(envId, token)
    }
  })

  it('retry, check and cancel: resumable states only, with their codes', async () => {
    m.deploy = async () => {
      throw Object.assign(new Error('the deploy broke'), { code: 'DEPLOY_FAILED' })
    }
    const out = await created()
    const envId = out.environments[0].id
    expect((await store.readCreationRow(envId))?.status).toBe('failed')
    const check = await call('POST', `/environments/${envId}/creation/check`, asAdmin)
    expect(check.statusCode).toBe(409)
    expect(check.json().code).toBe('NOT_RESUMABLE')
    const cancel = await call('POST', `/environments/${envId}/creation/cancel`, asAdmin)
    expect(cancel.statusCode).toBe(409)
    expect(cancel.json().code).toBe('NOT_RUNNING')
    m.deploy = null
    const retry = await call('POST', `/environments/${envId}/creation/retry`, asAdmin)
    expect(retry.statusCode).toBe(202)
    expect(retry.json().data).toEqual({ status: 'running' })
    await R.awaitCreation(envId)
    expect((await store.readCreationRow(envId))?.status).toBe('done')
    expect(activity.map((a) => a.action)).toEqual(expect.arrayContaining(['hub-create-retry']))
  })

  it('an interrupted creation (runner stopped) is retried from the route', async () => {
    let release = () => {}
    m.hold = { key: 'config', until: new Promise<void>((r) => (release = r)) }
    const res = await call('POST', '/apps/create', asAdmin, createInput())
    const envId = res.json().data.environments[0].id
    for (let i = 0; i < 100 && (await store.readCreationRow(envId))?.step !== 'config'; i++)
      await new Promise((r) => setTimeout(r, 5))
    // Another writer closes the row under the leg: the leg ends 'interrupted', env stays provisioning.
    const row = await store.readCreationRow(envId)
    await store.patchCreation(row?.id as number, { status: 'interrupted' }, ['running'])
    release()
    await R.awaitCreation(envId)
    expect((await store.readCreationRow(envId))?.status).toBe('interrupted')
    expect((await db('nivaro_hub_environments').where({ id: envId }).first()).status).toBe(
      'provisioning'
    )
    m.hold = null
    const retry = await call('POST', `/environments/${envId}/creation/retry`, asAdmin)
    expect(retry.statusCode).toBe(202)
    await R.awaitCreation(envId)
    expect((await store.readCreationRow(envId))?.status).toBe('done')
  })

  it('Installed: 409 NOT_WAITING_FOR_OPERATOR unless the deploy waits for it; the owner may press it', async () => {
    let ack = false
    m.deploy = async () =>
      ack
        ? { status: 'done', note: 'deployed' }
        : { status: 'waiting', on: 'operator', note: 'Install the key, then press Installed.' }
    const out = await created()
    const envId = out.environments[0].id
    expect(await store.readCreationRow(envId)).toMatchObject({
      status: 'waiting',
      waiting_for: 'operator'
    })
    ack = true
    const ok = await call('POST', `/environments/${envId}/creation/installed`, asOwner)
    expect(ok.statusCode, ok.body).toBe(202)
    expect(ok.json().data).toEqual({ status: 'running', environments: [envId] })
    expect(m.installed).toHaveBeenCalledWith(envId, { id: OWNER })
    await R.awaitCreation(envId)
    expect((await store.readCreationRow(envId))?.status).toBe('done')
    const again = await call('POST', `/environments/${envId}/creation/installed`, asAdmin)
    expect(again.statusCode).toBe(409)
    expect(again.json().code).toBe('NOT_WAITING_FOR_OPERATOR')
    expect(activity.map((a) => a.action)).toContain('hub-create-installed')
  })

  it('cancel of a waiting creation answers 202 and logs it', async () => {
    const out = await created({
      environments: [{ key: 'production', database: { server_id: manualServer } }]
    })
    const envId = out.environments[0].id
    const res = await call('POST', `/environments/${envId}/creation/cancel`, asAdmin)
    expect(res.statusCode).toBe(202)
    expect((await store.readCreationRow(envId))?.status).toBe('cancelled')
    expect(activity.map((a) => a.action)).toContain('hub-create-cancel')
  })
})

// ── owner limits (ruling P3-24) ──────────────────────────────────────────────

describe('owner limits (P3-24)', () => {
  /** A creation waiting for a DBA database on the manual server (pg2.example.com:5432). */
  async function waitingDatabase() {
    const out = await created({
      environments: [{ key: 'production', database: { server_id: manualServer } }]
    })
    const envId = out.environments[0].id
    const dbId = Number(
      String((await db('nivaro_hub_environments').where({ id: envId }).first()).db_ref).split(
        ':'
      )[1]
    )
    const row = await db('nivaro_hub_databases').where({ id: dbId }).first()
    const conn = (over: Record<string, unknown> = {}) => ({
      host: 'pg2.example.com',
      port: 5432,
      database: row.database_name,
      user: row.login_name,
      password: DBA_PASSWORD,
      ...over
    })
    return { envId, dbId, conn }
  }

  it('an owner cannot point the connection at another host or port; nothing connects', async () => {
    const { dbId, conn } = await waitingDatabase()
    for (const over of [
      { host: 'evil.example.com' },
      { port: 5433 },
      { host: '10.0.0.9', port: 22 },
      { url: `postgres://x:${DBA_PASSWORD}@evil.example.com:5432/x` }
    ]) {
      const res = await call('PUT', `/databases/${dbId}/connection`, asOwner, conn(over))
      expect(res.statusCode, JSON.stringify(over)).toBe(400)
      expect(res.json().code).toBe('HOST_NOT_SERVER')
    }
    expect(connects).toEqual([])
    expect(await db('nivaro_hub_databases').where({ id: dbId }).first()).toMatchObject({
      status: 'requested',
      connection: null
    })
    // The server's own place in another spelling (case, default port) is the server.
    const ok = await call(
      'PUT',
      `/databases/${dbId}/connection`,
      asOwner,
      conn({ host: 'PG2.Example.COM', port: undefined })
    )
    expect(ok.statusCode, ok.body).toBe(200)
    expect(connects).toEqual(['PG2.Example.COM:'])
  })

  it('an owner’s TLS settings are the server’s; what they send is ignored', async () => {
    const { dbId, conn } = await waitingDatabase()
    await db('nivaro_hub_db_servers')
      .where({ id: manualServer })
      .update({ ssl_mode: 'verify-full', trust_server_cert: false })
    const res = await call(
      'PUT',
      `/databases/${dbId}/connection`,
      asOwner,
      conn({ ssl_mode: 'disable', trust_server_cert: true })
    )
    expect(res.statusCode, res.body).toBe(200)
    expect(connectTls).toEqual([{ ssl_mode: 'verify-full', trust_server_cert: false }])
  })

  it('an admin keeps the TLS settings they send', async () => {
    const { dbId, conn } = await waitingDatabase()
    const res = await call(
      'PUT',
      `/databases/${dbId}/connection`,
      asAdmin,
      conn({ ssl_mode: 'disable', trust_server_cert: true })
    )
    expect(res.statusCode, res.body).toBe(200)
    expect(connectTls).toEqual([{ ssl_mode: 'disable', trust_server_cert: true }])
  })

  it('a half-masked provisioning login is refused with LOGIN_HALF_MASKED', async () => {
    for (const admin_secret of [
      { user: '••••••', password: 'new-secret' },
      { user: 'someone', password: '••••••' },
      // P3-26 (a): any mask character left in a half (typed around the mask) is refused too.
      { user: '••••••dba', password: 'new-secret' },
      { user: 'dba', password: 'x••' }
    ]) {
      const res = await call('PATCH', `/db-servers/${autoServer}`, asAdmin, { admin_secret })
      expect(res.statusCode, res.body).toBe(400)
      expect(res.json().code).toBe('LOGIN_HALF_MASKED')
    }
  })

  it('an owner’s Check now refuses a row an admin pointed elsewhere; the admin is free', async () => {
    const { dbId, conn } = await waitingDatabase()
    appState.set(conn().database, 'foreign')
    const admin = await call(
      'PUT',
      `/databases/${dbId}/connection`,
      asAdmin,
      conn({ host: 'pg7.example.com', port: 6543 })
    )
    expect(admin.statusCode, admin.body).toBe(200)
    expect(connects).toEqual(['pg7.example.com:6543'])
    const owner = await call('POST', `/databases/${dbId}/check`, asOwner)
    expect(owner.statusCode).toBe(400)
    expect(owner.json().code).toBe('HOST_NOT_SERVER')
    expect(connects).toHaveLength(1)
    expect((await call('POST', `/databases/${dbId}/check`, asAdmin)).statusCode).toBe(200)
    expect(connects).toHaveLength(2)
  })

  it('an owner gets 10 tries per database per 10 minutes, then 429; an admin is never limited', async () => {
    const { dbId, conn } = await waitingDatabase()
    appState.set(conn().database, 'foreign')
    expect((await call('PUT', `/databases/${dbId}/connection`, asOwner, conn())).statusCode).toBe(
      200
    )
    for (let i = 2; i <= 10; i++)
      expect((await call('POST', `/databases/${dbId}/check`, asOwner)).statusCode, `try ${i}`).toBe(
        200
      )
    for (const res of [
      await call('POST', `/databases/${dbId}/check`, asOwner),
      await call('PUT', `/databases/${dbId}/connection`, asOwner, conn())
    ]) {
      expect(res.statusCode).toBe(429)
      expect(res.json().code).toBe('TOO_MANY_TRIES')
    }
    expect(connects).toHaveLength(10)
    for (let i = 0; i < 12; i++)
      expect((await call('POST', `/databases/${dbId}/check`, asAdmin)).statusCode).toBe(200)
    expect(connects).toHaveLength(22)
  })
})

describe('owner limits — follow-ups', () => {
  it('Check now judges the row’s place with the row’s own engine', async () => {
    const out = await created({
      environments: [{ key: 'production', database: { server_id: manualServer } }]
    })
    const envId = out.environments[0].id
    const dbId = Number(
      String((await db('nivaro_hub_environments').where({ id: envId }).first()).db_ref).split(
        ':'
      )[1]
    )
    // Same host, no port: as mysql2 that is 3306 — not the pg server's 5432.
    await db('nivaro_hub_databases')
      .where({ id: dbId })
      .update({ engine: 'mysql2', host: 'pg2.example.com', port: null })
    const res = await call('POST', `/databases/${dbId}/check`, asOwner)
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('HOST_NOT_SERVER')
    expect(connects).toEqual([])
  })

  it('the try counter sets its window with the key (a failing EXPIRE never locks anyone out)', async () => {
    const store = new Map<string, { n: number; ttl: number | null }>()
    const calls: string[] = []
    const redis = {
      async set(k: string, v: string, ex: string, s: number, nx: string) {
        calls.push(`set ${ex} ${s} ${nx}`)
        if (store.has(k)) return null
        store.set(k, { n: Number(v), ttl: s })
        return 'OK'
      },
      async incr(k: string) {
        calls.push('incr')
        const e = store.get(k) ?? { n: 0, ttl: null }
        e.n++
        store.set(k, e)
        return e.n
      },
      async expire() {
        throw new Error('EXPIRE refused')
      }
    }
    const key = 'nvr:hub:db-tries:-:u1:1'
    const counts: number[] = []
    for (let i = 0; i < 11; i++) counts.push(await countOwnerTry(redis, key))
    expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(store.get(key)?.ttl).toBe(600)
    expect(calls.slice(0, 2)).toEqual(['set EX 600 NX', 'incr'])
    expect(calls).not.toContain('expire')
  })

  it('Redis failing partway counts the try once, in-process', async () => {
    let n = 0
    const redis = {
      async set() {
        return 'OK'
      },
      async incr() {
        n++
        if (n === 3) throw new Error('connection reset')
        return n
      }
    }
    const key = 'nvr:hub:db-tries:-:u2:1'
    expect(await countOwnerTry(redis, key)).toBe(1)
    expect(await countOwnerTry(redis, key)).toBe(2)
    // The failed INCR: counted once, here.
    expect(await countOwnerTry(redis, key)).toBe(1)
    expect(await countOwnerTry(null, key)).toBe(2)
  })
})

describe('closing', () => {
  it('a closing Hub waits for background target syncs', async () => {
    const out = await created()
    await db('nivaro_hub_creations')
      .where({ app_id: out.app_id })
      .update({ made: JSON.stringify({ project_id: 77 }) })
    let release = () => {}
    const slow = new Promise<void>((r) => (release = r))
    let synced = false
    const res = await R.syncTargetApps(targetId, {
      budgetMs: 10,
      syncApp: async () => {
        await slow
        synced = true
      }
    })
    expect(res).toEqual([{ app_id: out.app_id, ok: false, code: 'PENDING', pending: true }])
    const other = Fastify()
    await other.register(hubRoutes, { prefix: '/api/hub' })
    await other.ready()
    let closed = false
    const closing = other.close().then(() => {
      closed = true
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(closed).toBe(false)
    release()
    await closing
    expect(synced).toBe(true)
  })
})

// ── maintenance ──────────────────────────────────────────────────────────────

describe('maintenance freeze', () => {
  it('refuses the writes but lets the plan (a read) through', async () => {
    m.maint.mockResolvedValue({ on: true, message: 'down', until: null })
    for (const [method, p] of [
      ['POST', '/db-servers'],
      ['POST', '/targets'],
      ['POST', '/databases/adopt'],
      ['POST', '/apps/create'],
      ['POST', '/environments/1/creation/retry'],
      ['POST', '/environments/1/creation/installed']
    ] as const) {
      const res = await call(method, p, asAdmin, {})
      expect(res.statusCode, `${method} ${p}`).toBe(503)
      expect(res.json().code).toBe('MAINTENANCE')
    }
    const plan = await call('POST', '/apps/create/plan', asAdmin, createInput())
    expect(plan.statusCode).toBe(200)
    expect(plan.json().data.ok).toBe(true)
  })
})

// Ruling P6-32 (E2E BUG-1): attach / detach a database record on an existing environment —
// the routes are Hub-admin only and answer the service's refusals (the checks themselves are
// tested in hub-move-gather.test.ts, with the move tables).
describe('environment database record (P6-32)', () => {
  it('admin only; 404 for an unknown environment; 400 for a bad database_id', async () => {
    for (const method of ['PUT', 'DELETE'] as const) {
      const owner = await app.inject({
        method,
        url: '/api/hub/environments/1/database',
        headers: asOwner,
        payload: { database_id: 1 }
      })
      expect(owner.statusCode).toBe(403)
      const missing = await app.inject({
        method,
        url: '/api/hub/environments/999999/database',
        headers: asAdmin,
        payload: { database_id: 1 }
      })
      expect(missing.statusCode).toBe(404)
      expect(missing.json().code).toBe('NOT_FOUND')
    }
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/hub/environments/1/database',
      headers: asAdmin,
      payload: { database_id: 'one' }
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('BAD_DATABASE')
    expect(activity.filter((a) => String(a.action).startsWith('hub-env-db'))).toEqual([])
  })
})
