import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 3, Task 9: the creation runner. Real SQLite holds every Hub row; the real
// GitLab provisioning client runs over the in-memory GitLab (hub-fake-gitlab.ts); the database
// server is a fake provisioner (as in hub-db-service.test.ts); the app side (status, first admin,
// name check) and the clock are injected. Everything the runner wrote anywhere is swept for
// secrets at the end (Review Focus 3).

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

const activity: Array<Record<string, unknown>> = []
vi.mock('../../../services/activity.js', () => ({
  logActivity: async (o: Record<string, unknown>) => {
    activity.push(o)
    return 1
  }
}))

// The fake database server (ownership semantics as the real provisioners).
const fake = {
  databases: new Set<string>(),
  logins: new Map<string, string>(),
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  failOwnerOnce: false,
  leakInErrors: '',
  appState: new Map<string, string>(),
  reset() {
    this.databases = new Set()
    this.logins = new Map()
    this.calls = []
    this.failOwnerOnce = false
    this.leakInErrors = ''
    this.appState = new Map()
  }
}

vi.mock('../../../services/hub/db/provisioner.js', async (orig) => {
  const real = (await orig()) as typeof import('../../../services/hub/db/provisioner.js')
  const { ProvisionError } = real
  let lastApp = ''
  const prov = {
    engine: 'pg',
    async probe() {
      return { ok: true, version: '16.0', can_create: true, missing: [], text: 'ok' }
    },
    async databaseExists(_a: unknown, name: string) {
      return fake.databases.has(name)
    },
    async loginExists(_a: unknown, login: string) {
      return fake.logins.has(login)
    },
    async ensureLogin(_a: unknown, login: string, password: string, o: { ownedLogin?: boolean }) {
      fake.calls.push({ fn: 'ensureLogin', args: { login, password, ...o } })
      if (fake.logins.has(login)) {
        if (!o.ownedLogin) throw new ProvisionError('LOGIN_EXISTS', 'The login exists')
        fake.logins.set(login, password)
        return 'updated'
      }
      fake.logins.set(login, password)
      return 'created'
    },
    async ensureDatabase(_a: unknown, name: string, o: { ownedDatabase?: boolean }) {
      fake.calls.push({ fn: 'ensureDatabase', args: { name } })
      if (fake.databases.has(name)) {
        if (!o.ownedDatabase) throw new ProvisionError('DATABASE_EXISTS', 'exists')
        return 'existed'
      }
      fake.databases.add(name)
      return 'created'
    },
    async ensureOwner(_a: unknown, name: string, login: string, o: { ownedDatabase?: boolean }) {
      fake.calls.push({ fn: 'ensureOwner', args: { name, login } })
      if (!o.ownedDatabase) throw new ProvisionError('NOT_OWNED', 'not owned')
      if (fake.failOwnerOnce) {
        fake.failOwnerOnce = false
        throw new ProvisionError('DB_ERROR', `permission denied ${fake.leakInErrors}`)
      }
    },
    async drop() {},
    async checkApp() {
      const state = fake.appState.get(lastApp) ?? 'empty'
      return {
        state,
        ok: state === 'empty' || state === 'nivaro',
        version: '16.0',
        migrations: null,
        last_migration: null,
        text: `Checked: ${state} ${fake.leakInErrors}`,
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
      conn: { database: string; password: string },
      fn: (k: unknown) => Promise<unknown>
    ) => {
      lastApp = conn.database
      return fn({ raw: async () => [{ s: 'pg-main', p: 5432, d: conn.database }] })
    }
  }
})

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const m542 = await import('../../../db/migrations/542_hub_tables.js')
const m543 = await import('../../../db/migrations/543_hub_promotions.js')
const m544 = await import('../../../db/migrations/544_hub_databases.js')
const m545 = await import('../../../db/migrations/545_hub_creations.js')
const R = await import('../../../services/hub/create/run.js')
const store = await import('../../../services/hub/create/store.js')
const D = await import('../../../services/hub/db/databases.js')
const { listComponents } = await import('../../../services/hub/components.js')
const { redisPromoteLock, hubPromoteLockKey } = await import(
  '../../../services/hub/promote-lock.js'
)
const { openSecret, sealSecret } = await import('../../../services/hub/secrets.js')
const { pinText } = await import('../../../services/hub/registry.js')
const { stackName } = await import('../../../services/hub/create/app-config.js')
const { FakeGitLab } = await import('./hub-fake-gitlab.js')
const { connectionUrl } = await import('../../../services/hub/db/connection.js')
const { ciConfigVerifier } = await import('../../../services/hub/create/promote-ci-check.js')

import type { CreationDeps } from '../../../services/hub/create/run.js'
import type { HubTargetConfig } from '../../../services/hub/create/targets.js'
import type { CreateAppInput } from '../../../services/hub/create/types.js'
import type { JobRunHandle } from '../../../services/job-runs.js'

const KEY = 'e'.repeat(64)
const OWNER = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
const USER = { id: OWNER }
const DIGEST = `sha256:${'a'.repeat(64)}`
const SLIM = `sha256:${'b'.repeat(64)}`
const ADMIN = { user: 'hubprovisioner', password: 'Adm1nPassw0rd-very-secret' }
const OIDC_SECRET = 'oidc-Secr3t-value-xyz-0123'
const DBA_PASSWORD = 'DbaGiv3nPassw0rd-secret'
const TEMPLATE = 'apps/nivaro-template'
const PROJECT = 'apps/demo-deploy'
const ENV = { HUB_URL: 'https://hub.example.com' } as unknown as NodeJS.ProcessEnv

const targetConfig: HubTargetConfig = {
  api: 'https://gitlab.example.com',
  namespace: 'apps',
  template_project: TEMPLATE,
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

// ── fakes ────────────────────────────────────────────────────────────────────

let gl: InstanceType<typeof FakeGitLab>
let targetId: number
let manualTargetId: number
let autoServer: number
let manualServer: number

/** Every text the runner wrote anywhere it shows or keeps. */
const written: string[] = []
/** Every secret value seen in any test (swept at the end). */
const secretsSeen = new Set<string>([ADMIN.password, OIDC_SECRET, DBA_PASSWORD])

function fakeRun(): JobRunHandle & { lines: string[] } {
  const lines: string[] = []
  return {
    id: null,
    lines,
    progress() {},
    log(line) {
      lines.push(line)
      written.push(line)
    },
    async complete(outcome) {
      written.push(outcome ?? '')
    },
    async fail(err) {
      written.push(err instanceof Error ? err.message : String(err))
    }
  }
}

function fakeRedis() {
  const store = new Map<string, string>()
  return {
    store,
    async set(key: string, value: string, ...args: Array<string | number>) {
      if (args.includes('NX') && store.has(key)) return null
      store.set(key, value)
      return 'OK'
    },
    async get(key: string) {
      return store.get(key) ?? null
    },
    async del(...keys: string[]) {
      let n = 0
      for (const k of keys) if (store.delete(k)) n++
      return n
    },
    async exists(key: string) {
      return store.has(key) ? 1 : 0
    },
    async eval(script: string, _n: number, ...args: Array<string | number>) {
      const [key, token] = args.map(String)
      if (store.get(key) !== token) return 0
      if (script.includes("'del'")) store.delete(key)
      return 1
    }
  }
}

type NameAnswer = { resolves: boolean; serves: boolean; version: string | null; text: string }
let nameAnswer: (host: string, version: string) => NameAnswer
let statusAnswers: Array<{ state: string; error?: string }>
let adminAnswers: Array<{ result: string; code?: string }>
let adminCalls: number
let digestLooks: number
let runs: Array<{ label: string; run: ReturnType<typeof fakeRun> }>
let lock: ReturnType<typeof redisPromoteLock>
let redis: ReturnType<typeof fakeRedis>
let flags: ReturnType<typeof store.redisCreationFlags>
let repoLock: ReturnType<typeof store.memoryKeyedLock>
let startLock: ReturnType<typeof store.memoryKeyedLock>
const clock = { t: 1_000_000, slept: 0 }

const serving = (host: string, version: string): NameAnswer => ({
  resolves: true,
  serves: true,
  version,
  text: `${host} resolves and serves version ${version}.`
})

function deps(over: Partial<CreationDeps> = {}): CreationDeps {
  return {
    lock,
    repoLock,
    startLock,
    flags,
    link: {
      requestFirstAdmin: async () => {
        adminCalls++
        const a = adminAnswers.length > 1 ? adminAnswers.shift() : adminAnswers[0]
        return (a ?? { result: 'created' }) as never
      }
    },
    checkName: async (host, _base, version) => nameAnswer(host, version),
    status: async () => {
      const s = (statusAnswers.length > 1 ? statusAnswers.shift() : statusAnswers[0]) ?? {
        state: 'ok'
      }
      return {
        version: '1.2.3',
        preflight: 'ok',
        checked_at: new Date().toISOString(),
        source: 'hub-link',
        ...s
      } as never
    },
    startJobRun: async (label) => {
      const run = fakeRun()
      runs.push({ label, run })
      return run
    },
    sleep: async (ms) => {
      clock.t += ms
      clock.slept += ms
    },
    now: () => clock.t,
    gather: {
      env: ENV,
      imageDigest: async (_image: string, tag: string) => {
        digestLooks++
        return tag.endsWith('-slim') ? SLIM : DIGEST
      },
      encryptionKey: () => true,
      timeoutMs: 500
    },
    ...over
  }
}

function input(over: Partial<CreateAppInput> = {}): CreateAppInput {
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
    environments: [
      { key: 'staging', database: { server_id: autoServer } },
      { key: 'production', database: { server_id: autoServer } }
    ],
    ...over
  }
}

const insertId = async (table: string, row: Record<string, unknown>) => {
  await db(table).insert(row)
  return Number((await db(table).max('id as id').first())?.id)
}

async function creation(envId: number) {
  return (await store.readCreationRow(envId)) as NonNullable<
    Awaited<ReturnType<typeof store.readCreationRow>>
  >
}

const stepOf = async (envId: number, key: string) =>
  (await creation(envId)).steps.find((s) => s.key === key)

async function remember(envIds: number[]) {
  for (const id of envIds) {
    const view = await R.readCreation(id)
    written.push(JSON.stringify(view))
    const env = (await db('nivaro_hub_environments').where({ id }).first('hub_token')) as {
      hub_token: string | null
    }
    const token = openSecret(env?.hub_token ?? null)
    if (token) secretsSeen.add(token)
  }
}

/**
 * Waits for the legs; every creation that stops at the operator step (P3-22) is confirmed
 * "Installed" (once per app) and waited for again, as the operator would.
 */
async function settle(envIds: number[], d: CreationDeps = deps()) {
  for (let round = 0; round < 4; round++) {
    for (const id of envIds) await R.awaitCreation(id)
    const waiting = []
    for (const id of envIds) {
      const c = await store.readCreationRow(id)
      if (c?.status === 'waiting' && c.waiting_for === 'operator') waiting.push(id)
    }
    if (!waiting.length) return
    await R.confirmOperatorInstalled(waiting[0], USER, d)
  }
}

async function startAndWait(
  i: CreateAppInput = input(),
  d: CreationDeps = deps(),
  o: { stopAtOperator?: boolean } = {}
) {
  const out = await R.startCreation(i, USER, d)
  const ids = out.environments.map((e) => e.id)
  if (o.stopAtOperator) for (const id of ids) await R.awaitCreation(id)
  else await settle(ids, d)
  await remember(ids)
  return out
}

let prevKey: string | undefined
beforeAll(async () => {
  prevKey = process.env.ENCRYPTION_KEY
  process.env.ENCRYPTION_KEY = KEY
  await m542.up(db)
  await m543.up(db)
  await m544.up(db)
  await m545.up(db)
  if (!(await db.schema.hasTable('nivaro_users')))
    await db.schema.createTable('nivaro_users', (t) => t.uuid('id').primary())
  await db('nivaro_users').insert({ id: OWNER })
})

afterAll(async () => {
  collectSecrets()
  // Review Focus 3: no secret in any log line, note, error, activity row or readCreation answer.
  const rows = (await db('nivaro_hub_creations').select('*')) as unknown[]
  const all = [...written, JSON.stringify(rows), JSON.stringify(activity)].join('\n')
  const forms = new Set<string>()
  for (const s of secretsSeen) {
    if (!s) continue
    forms.add(s)
    forms.add(Buffer.from(s).toString('base64'))
    forms.add(encodeURIComponent(s))
  }
  expect(forms.size).toBeGreaterThan(20)
  for (const s of forms) expect(all.includes(s), `secret leaked (${s.length} chars)`).toBe(false)
  if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = prevKey
  await db.destroy()
})

/** Secrets of the test that just ran: generated passwords and masked CI variable values. */
function collectSecrets() {
  for (const v of fake.logins.values()) secretsSeen.add(v)
  if (gl)
    for (const name of gl.projects.keys())
      for (const v of gl.variablesOf(name)) {
        // Masked values only (DEPLOY_HOST / HUB_HOST_SUFFIX are settings, not secrets);
        // DEPLOY_KNOWN_HOSTS is masked but public (the manager's host key).
        if (!v.masked || v.key === 'DEPLOY_KNOWN_HOSTS') continue
        secretsSeen.add(v.value)
        secretsSeen.add(Buffer.from(v.value, 'base64').toString('utf8'))
      }
  if (gl) secretsSeen.add(gl.token)
}

beforeEach(async () => {
  collectSecrets()
  fake.reset()
  for (const t of [
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
  ])
    await db(t).del()

  gl = new FakeGitLab()
  gl.project(TEMPLATE, (ref) =>
    ref === 'main' ? [] : [{ name: 'deploy', statuses: ['running', 'success'] }]
  )
  gl.commit(TEMPLATE, 'main', 'template v1', {
    '.gitlab-ci.yml': 'check: {}\n',
    'ci/deploy.yml': 'deploy: {}\n',
    '.hub/README.md': 'settings\n'
  })
  gl.namespace('apps')
  vi.stubGlobal('fetch', gl.fetch)

  targetId = await insertId('nivaro_hub_targets', {
    kind: 'gitlab',
    name: 'apps',
    config: JSON.stringify(targetConfig),
    secret: sealSecret(gl.token)
  })
  manualTargetId = await insertId('nivaro_hub_targets', {
    kind: 'gitlab',
    name: 'corp',
    config: JSON.stringify({
      ...targetConfig,
      dns_mode: 'manual',
      wildcard_domain: null,
      edge_address: 'edge.corp.example.com'
    }),
    secret: sealSecret(gl.token)
  })
  autoServer = await insertId('nivaro_hub_db_servers', {
    name: 'pg-auto',
    engine: 'pg',
    host: 'pg1.example.com',
    port: 5432,
    provision_mode: 'automatic',
    admin_secret: sealSecret(JSON.stringify(ADMIN))
  })
  manualServer = await insertId('nivaro_hub_db_servers', {
    name: 'dba-pg',
    engine: 'pg',
    host: 'pg2.example.com',
    port: 5432,
    provision_mode: 'manual'
  })

  redis = fakeRedis()
  lock = redisPromoteLock(redis)
  flags = store.redisCreationFlags(redis)
  repoLock = store.memoryKeyedLock()
  startLock = store.memoryKeyedLock()
  nameAnswer = serving
  statusAnswers = [{ state: 'ok' }]
  adminAnswers = [{ result: 'created' }]
  adminCalls = 0
  digestLooks = 0
  runs = []
  activity.length = 0
})

const forkCalls = () => gl.calls.filter((c) => c.method === 'POST' && c.path === '/fork')

// ── the happy path ───────────────────────────────────────────────────────────

describe('startCreation — a full automatic run of two environments', () => {
  it('creates the app end to end: both done, one fork, driver, placements, components', async () => {
    const out = await startAndWait()
    const [staging, production] = out.environments
    expect(out.environments.map((e) => e.key)).toEqual(['staging', 'production'])
    for (const e of out.environments) {
      expect((await creation(e.id)).status).toBe('done')
      expect((await creation(e.id)).steps.every((s) => s.status === 'done')).toBe(true)
      const env = await db('nivaro_hub_environments').where({ id: e.id }).first()
      expect(env.status).toBe('active')
      expect(Boolean(env.hub_managed)).toBe(true)
    }

    // One fork (the two legs raced for the repository), fork relation removed, marked ours.
    expect(forkCalls()).toHaveLength(1)
    expect(gl.forkedFromOf(PROJECT)).toBeNull()
    const proj = gl.projects.get(PROJECT)
    expect(proj?.description).toMatch(/^nivaro-hub creation \d+ [A-Za-z0-9_-]{24}$/)
    expect(proj?.restrict_user_defined_variables).toBe(true)
    expect(proj?.ci_config_path).toBe(`ci/deploy.yml@${TEMPLATE}:v1.0.0`)
    expect(proj?.ci_pipeline_variables_minimum_override_role).toBe('no_one_allowed')
    const app = await db('nivaro_hub_apps').where({ id: out.app_id }).first()
    expect(app.deploy_project).toBe(PROJECT)
    expect(Number(app.target_id)).toBe(targetId)
    expect(openSecret(app.oidc_secret)).toBe(OIDC_SECRET)
    expect(JSON.parse(app.oidc)).toEqual({
      issuer: 'https://login.microsoftonline.com/tenant/v2.0',
      client_id: 'client-123'
    })

    // Phase-2 shape: one driver, a placement + api component per environment.
    expect(await db('nivaro_hub_drivers').count('* as n').first()).toMatchObject({ n: 1 })
    expect(await db('nivaro_hub_placements').count('* as n').first()).toMatchObject({ n: 2 })
    expect(await db('nivaro_hub_components').count('* as n').first()).toMatchObject({ n: 2 })
    const prodEnv = await db('nivaro_hub_environments').where({ id: production.id }).first()
    const stgEnv = await db('nivaro_hub_environments').where({ id: staging.id }).first()
    const [prodC] = await listComponents(Number(prodEnv.placement_id))
    const [stgC] = await listComponents(Number(stgEnv.placement_id))
    expect(prodC).toMatchObject({
      source_branch: 'staging',
      target_branch: 'production',
      verify_url: 'https://demo.apps.example.com/api/version'
    })
    expect(stgC).toMatchObject({ source_branch: 'staging', target_branch: 'staging' })
    const driver = await db('nivaro_hub_drivers').first()
    expect(JSON.parse(driver.config)).toMatchObject({ project: PROJECT, branch: 'main' })

    // Variables: project-wide ones at '*', the five secrets scoped per environment.
    const vars = gl.variablesOf(PROJECT)
    expect(vars.find((v) => v.key === 'DEPLOY_HOST')).toMatchObject({
      environment_scope: '*',
      masked: false,
      value: 'deploy@swarm1.example.com'
    })
    expect(vars.find((v) => v.key === 'DEPLOY_SSH_KEY')).toMatchObject({
      environment_scope: '*',
      masked: true,
      protected: true
    })
    const sshKey = Buffer.from(
      vars.find((v) => v.key === 'DEPLOY_SSH_KEY')?.value ?? '',
      'base64'
    ).toString()
    expect(sshKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----/)
    expect(vars.filter((v) => v.key === 'DEPLOY_SSH_KEY')).toHaveLength(1)
    for (const scope of ['staging', 'production'])
      for (const key of [
        'NIVARO_DB_URL_B64',
        'NIVARO_HUB_TOKEN_B64',
        'NIVARO_SESSION_SECRET_B64',
        'NIVARO_ENCRYPTION_KEY_B64',
        'NIVARO_OIDC_CLIENT_SECRET_B64'
      ])
        expect(
          vars.find((v) => v.key === key && v.environment_scope === scope),
          `${key}@${scope}`
        ).toMatchObject({ masked: true, protected: true, raw: true })
    const oidcVar = vars.find(
      (v) => v.key === 'NIVARO_OIDC_CLIENT_SECRET_B64' && v.environment_scope === 'production'
    )
    expect(Buffer.from(oidcVar?.value ?? '', 'base64').toString()).toBe(OIDC_SECRET)

    // Pin + settings committed on each env branch; ENV_KEY is the branch.
    expect(gl.file(PROJECT, 'production', '.hub/nivaro-version')).toBe(
      pinText('1.2.3', DIGEST, SLIM)
    )
    expect(gl.file(PROJECT, 'production', '.hub/app.env')).toContain('ENV_KEY=production\n')
    expect(gl.file(PROJECT, 'staging', '.hub/app.env')).toContain('ENV_KEY=staging\n')
    expect(gl.file(PROJECT, 'staging', '.hub/app.env')).toContain(
      'HUB_URL=https://hub.example.com\n'
    )
    expect(gl.file(PROJECT, 'production', '.gitlab-ci.yml')).toContain("ref: 'v1.0.0'")
    const head = gl.projects.get(PROJECT)?.branches.get('production') as string
    expect(gl.projects.get(PROJECT)?.commits.get(head)?.title).toMatch(
      /^nivaro 1\.2\.3 \(hub: create demo\/production\)$/
    )
    expect(gl.protectedOf(PROJECT).sort()).toEqual(['production', 'staging'])

    // Databases made and ready, attached; the first admin asked once per environment.
    const dbs = await db('nivaro_hub_databases').orderBy('id')
    expect(dbs.map((d: { database_name: string }) => d.database_name)).toEqual([
      'nivaro_demo_staging',
      'nivaro_demo_production'
    ])
    expect(dbs.every((d: { status: string }) => d.status === 'ready')).toBe(true)
    expect(adminCalls).toBe(2)
    expect(activity.filter((a) => a.action === 'hub-create-done')).toHaveLength(2)

    // Job-run lines name each step.
    const lines = runs.flatMap((r) => r.run.lines)
    for (const key of ['database', 'repository', 'variables', 'config', 'deploy', 'name', 'link'])
      expect(lines.some((l) => l.startsWith(`${key} → done`))).toBe(true)
    expect([...new Set(runs.map((r) => r.label))].sort()).toEqual([
      'Create demo/production',
      'Create demo/staging'
    ])

    // The operator's manager lines for this app's key.
    const view = await R.readCreation(production.id)
    expect(view?.deploy_key?.key_conf).toBe(
      [
        `stack=${stackName('demo', 'staging')}`,
        `stack=${stackName('demo', 'production')}`,
        'host=demo--staging.apps.example.com',
        'host=demo.apps.example.com',
        'network=proxy',
        'image=nodeworks/nivaro',
        ''
      ].join('\n')
    )
    expect(view?.deploy_key?.authorized_keys).toContain(
      `nivaro-hub-deploy demo keyid=${view?.deploy_key?.keyid}`
    )
    expect(view?.made.project_path).toBe(PROJECT)
    expect(view?.redirect_uri).toBe('https://demo.apps.example.com/api/auth/callback')
    expect(JSON.stringify(view)).not.toContain('PRIVATE KEY')
  })

  it('plan blockers answer 409 and write nothing', async () => {
    await db('nivaro_hub_apps').insert({ key: 'demo', name: 'Taken' })
    const err = await R.startCreation(input(), USER, deps()).catch((e) => e)
    expect(err).toBeInstanceOf(R.CreationError)
    expect(err).toMatchObject({ status: 409, code: 'KEY_TAKEN' })
    expect(err.blockers.map((b: { code: string }) => b.code)).toContain('KEY_TAKEN')
    expect(await db('nivaro_hub_apps').count('* as n').first()).toMatchObject({ n: 1 })
    for (const t of ['nivaro_hub_environments', 'nivaro_hub_creations', 'nivaro_hub_databases'])
      expect(await db(t).count('* as n').first()).toMatchObject({ n: 0 })
    expect(forkCalls()).toHaveLength(0)
  })

  it('two creations at once never take the same key or hostname (planned under one lock)', async () => {
    const one = input({
      target_id: manualTargetId,
      environments: [
        {
          key: 'production',
          hostname: 'shop.corp.example.com',
          database: { server_id: autoServer }
        }
      ]
    })
    const two = { ...one, key: 'shop' }
    nameAnswer = (host) => ({ resolves: false, serves: false, version: null, text: `${host} no` })
    const settled = await Promise.allSettled([
      R.startCreation(one, USER, deps()),
      R.startCreation(two, USER, deps())
    ])
    const ok = settled.filter((s) => s.status === 'fulfilled')
    const bad = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[]
    expect(ok).toHaveLength(1)
    expect(bad).toHaveLength(1)
    expect(bad[0].reason).toMatchObject({ status: 409, code: 'HOSTNAME_TAKEN' })
    for (const s of ok)
      for (const e of (s as PromiseFulfilledResult<{ environments: Array<{ id: number }> }>).value
        .environments)
        await settle([e.id])
    const again = await R.startCreation(one, USER, deps()).catch((e) => e)
    expect(again).toMatchObject({ status: 409 })
  })
})

// ── waits ────────────────────────────────────────────────────────────────────

describe('waits', () => {
  it('a manual database waits; the DBA connection + Check now finishes it', async () => {
    const out = await startAndWait(
      input({
        environments: [{ key: 'production', database: { server_id: manualServer } }]
      })
    )
    const envId = out.environments[0].id
    let c = await creation(envId)
    expect(c).toMatchObject({ status: 'waiting', waiting_for: 'database' })
    expect(await stepOf(envId, 'database')).toMatchObject({ status: 'waiting' })
    expect(forkCalls()).toHaveLength(0)
    const view = await R.readCreation(envId)
    expect(view?.checklist?.length).toBeGreaterThan(0)
    expect(view?.database?.status).toBe('requested')

    // Check while nothing changed: still waiting.
    expect(await R.resumeCreation(envId, USER, 'check', deps())).toEqual({ status: 'waiting' })

    const dbId = c.made.database_id as number
    await D.setConnection(dbId, {
      engine: 'pg',
      host: 'pg2.example.com',
      port: 5432,
      database: 'nivaro_demo_production',
      user: 'demo_production',
      password: DBA_PASSWORD
    })
    expect(await R.resumeCreation(envId, USER, 'check', deps())).toEqual({ status: 'running' })
    await settle([envId])
    await remember([envId])
    c = await creation(envId)
    expect(c.status).toBe('done')
    const url = gl
      .variablesOf(PROJECT)
      .find((v) => v.key === 'NIVARO_DB_URL_B64' && v.environment_scope === 'production')
    expect(Buffer.from(url?.value ?? '', 'base64').toString()).toContain('pg2.example.com')
  })

  it('a manual name waits (waiting_for_name), stays waiting while unresolved, then done', async () => {
    let live = false
    nameAnswer = (host, version) =>
      live
        ? serving(host, version)
        : { resolves: false, serves: false, version: null, text: `${host} does not resolve yet.` }
    const out = await startAndWait(
      input({
        target_id: manualTargetId,
        environments: [
          {
            key: 'production',
            hostname: 'demo.corp.example.com',
            database: { server_id: autoServer }
          }
        ]
      })
    )
    const envId = out.environments[0].id
    const statusOf = async () =>
      (await db('nivaro_hub_environments').where({ id: envId }).first('status')).status
    expect(await creation(envId)).toMatchObject({ status: 'waiting', waiting_for: 'name' })
    expect(await statusOf()).toBe('waiting_for_name')
    expect((await R.readCreation(envId))?.ticket).toContain('edge.corp.example.com')

    // Review Focus 5: no timeout; Check now says which half is missing.
    nameAnswer = (host) => ({
      resolves: true,
      serves: false,
      version: '1.1.0',
      text: `${host} resolves but serves version 1.1.0, not 1.2.3.`
    })
    expect(await R.resumeCreation(envId, USER, 'check', deps())).toEqual({ status: 'waiting' })
    expect((await stepOf(envId, 'name'))?.note).toContain('serves version 1.1.0, not 1.2.3')
    expect(await R.checkWaitingCreations(deps())).toBe(0)
    expect(await statusOf()).toBe('waiting_for_name')

    live = true
    nameAnswer = (host, version) => serving(host, version)
    expect(await R.resumeCreation(envId, USER, 'check', deps())).toEqual({ status: 'running' })
    await settle([envId])
    expect((await creation(envId)).status).toBe('done')
    expect(await statusOf()).toBe('active')
  })

  it('the cron moves a waiting creation on, and checks a waiting name no creation walks', async () => {
    const out = await startAndWait(
      input({
        target_id: manualTargetId,
        environments: [
          {
            key: 'production',
            hostname: 'demo.corp.example.com',
            database: { server_id: autoServer }
          }
        ]
      }),
      deps({
        checkName: async (host) => ({
          resolves: false,
          serves: false,
          version: null,
          text: `${host} does not resolve yet.`
        })
      })
    )
    const envId = out.environments[0].id
    expect((await creation(envId)).status).toBe('waiting')
    expect(await R.checkWaitingCreations(deps())).toBe(1)
    await settle([envId])
    expect((await creation(envId)).status).toBe('done')
  })

  it('first admin: MAINTENANCE / TIMEOUT / early HUB_LINK_MISSING wait and ask again (P3-4)', async () => {
    adminAnswers = [
      { result: 'refused', code: 'MAINTENANCE' },
      { result: 'refused', code: 'HUB_LINK_MISSING' },
      { result: 'refused', code: 'TIMEOUT' },
      { result: 'refused', code: 'UNREACHABLE' },
      { result: 'existed' }
    ]
    const out = await startAndWait(
      input({ environments: [{ key: 'production', database: { server_id: autoServer } }] })
    )
    expect((await creation(out.environments[0].id)).status).toBe('done')
    expect(adminCalls).toBe(5)
  })

  it('first admin: a refusal fails with its code; HUB_LINK_MISSING past the start fails', async () => {
    adminAnswers = [{ result: 'refused', code: 'NO_ADMIN_ROLE' }]
    const one = await startAndWait(
      input({ environments: [{ key: 'production', database: { server_id: autoServer } }] })
    )
    const c = await creation(one.environments[0].id)
    expect(c.status).toBe('failed')
    expect(c.error).toMatch(/^NO_ADMIN_ROLE/)
    expect((await stepOf(one.environments[0].id, 'admin'))?.status).toBe('failed')

    adminAnswers = [{ result: 'refused', code: 'HUB_LINK_MISSING' }]
    adminCalls = 0
    await R.resumeCreation(one.environments[0].id, USER, 'retry', deps())
    await settle([one.environments[0].id])
    expect((await creation(one.environments[0].id)).error).toMatch(/^HUB_LINK_MISSING/)
    expect(adminCalls).toBe(5)
  })

  it('link: refused fails LINK_REFUSED; unreachable is asked again', async () => {
    statusAnswers = [{ state: 'unreachable', error: 'TIMEOUT' }, { state: 'ok' }]
    const ok = await startAndWait(
      input({ environments: [{ key: 'production', database: { server_id: autoServer } }] })
    )
    expect((await creation(ok.environments[0].id)).status).toBe('done')

    statusAnswers = [{ state: 'link_refused', error: 'HUB_LINK_REFUSED' }]
    const bad = await startAndWait(
      input({
        key: 'shop',
        environments: [{ key: 'production', database: { server_id: autoServer } }]
      })
    )
    expect((await creation(bad.environments[0].id)).error).toMatch(/^LINK_REFUSED/)
  })
})

// ── failure, retry, recovery ─────────────────────────────────────────────────

describe('retry and recovery', () => {
  it('provisioning fails at ensureOwner → failed; Retry finishes with the same password', async () => {
    fake.failOwnerOnce = true
    fake.leakInErrors = ADMIN.password
    const out = await startAndWait(
      input({ environments: [{ key: 'production', database: { server_id: autoServer } }] })
    )
    const envId = out.environments[0].id
    let c = await creation(envId)
    expect(c.status).toBe('failed')
    expect(c.error).toMatch(/^DB_ERROR/)
    expect(c.error).not.toContain(ADMIN.password)
    expect((await stepOf(envId, 'database'))?.status).toBe('failed')
    expect(forkCalls()).toHaveLength(0)

    const looked = digestLooks
    expect(await R.resumeCreation(envId, USER, 'retry', deps())).toEqual({ status: 'running' })
    await settle([envId])
    await remember([envId])
    c = await creation(envId)
    expect(c.status).toBe('done')
    // Retry never re-plans (its own app key, env rows and stack would read as taken).
    expect(digestLooks).toBe(looked)
    const passwords = new Set(
      fake.calls.filter((x) => x.fn === 'ensureLogin').map((x) => String(x.args.password))
    )
    expect(passwords.size).toBe(1)
    expect(fake.calls.filter((x) => x.fn === 'ensureLogin')).toHaveLength(2)
  })

  it('a retry after the variables step ran keeps SESSION_SECRET / ENCRYPTION_KEY (kept)', async () => {
    let refused = false
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : null
      if (
        !refused &&
        init.method === 'POST' &&
        String(url).endsWith('/variables') &&
        body?.key === 'NIVARO_OIDC_CLIENT_SECRET_B64'
      ) {
        refused = true
        return new Response(JSON.stringify({ message: 'boom' }), { status: 500 })
      }
      return gl.fetch(url, init)
    })
    const out = await startAndWait(
      input({ environments: [{ key: 'production', database: { server_id: autoServer } }] })
    )
    const envId = out.environments[0].id
    expect((await creation(envId)).status).toBe('failed')
    expect((await stepOf(envId, 'variables'))?.status).toBe('failed')
    const varValue = (key: string) =>
      gl.variablesOf(PROJECT).find((v) => v.key === key && v.environment_scope === 'production')
        ?.value
    const session = varValue('NIVARO_SESSION_SECRET_B64')
    const encryption = varValue('NIVARO_ENCRYPTION_KEY_B64')
    expect(session).toBeTruthy()

    await R.resumeCreation(envId, USER, 'retry', deps())
    await settle([envId])
    const c = await creation(envId)
    expect(c.status).toBe('done')
    expect(varValue('NIVARO_SESSION_SECRET_B64')).toBe(session)
    expect(varValue('NIVARO_ENCRYPTION_KEY_B64')).toBe(encryption)
    expect(c.made.variables).toMatchObject({
      NIVARO_SESSION_SECRET_B64: 'kept',
      NIVARO_ENCRYPTION_KEY_B64: 'kept',
      NIVARO_DB_URL_B64: 'updated',
      NIVARO_OIDC_CLIENT_SECRET_B64: 'created'
    })
    vi.stubGlobal('fetch', gl.fetch)
  })

  it('a lock held by a promotion: the leg answers busy and leaves the creation alone', async () => {
    const refusing = { ...lock, take: async () => null }
    const out = await R.startCreation(
      input({ environments: [{ key: 'production', database: { server_id: autoServer } }] }),
      USER,
      deps({ lock: refusing })
    )
    const envId = out.environments[0].id
    await settle([envId])
    expect((await creation(envId)).status).toBe('queued')

    const token = await lock.take(envId) // a promotion
    expect(await R.runCreationLeg(envId, USER, deps())).toBe('busy')
    expect((await creation(envId)).status).toBe('queued')
    expect(runs).toHaveLength(0)
    await lock.release(envId, token as string)
    expect(await R.runCreationLeg(envId, USER, deps())).toBe('waiting')
    expect((await creation(envId)).waiting_for).toBe('operator')
    await settle([envId])
    expect((await creation(envId)).status).toBe('done')
    expect(await lock.held(envId)).toBe(false)
  })

  it('a leg that found its environment busy at the start is started by the cron', async () => {
    const refusing = { ...lock, take: async () => null }
    const out = await R.startCreation(
      input({ environments: [{ key: 'production', database: { server_id: autoServer } }] }),
      USER,
      deps({ lock: refusing })
    )
    const envId = out.environments[0].id
    await settle([envId])
    expect((await creation(envId)).status).toBe('queued')
    const token = await lock.take(envId)
    expect(await R.checkWaitingCreations(deps())).toBe(0) // still held: left alone
    await lock.release(envId, token as string)
    expect(await R.checkWaitingCreations(deps())).toBe(1)
    await settle([envId])
    expect((await creation(envId)).status).toBe('done')
    expect(runs[0].label).toBe('Create demo/production')
  })

  it('restart: running → interrupted (lock gone); Retry resumes at that step', async () => {
    let serve = false
    nameAnswer = (host, version) =>
      serve
        ? serving(host, version)
        : { resolves: true, serves: false, version: null, text: `${host} resolves but no` }
    const out = await startAndWait(
      input({ environments: [{ key: 'production', database: { server_id: autoServer } }] })
    )
    const envId = out.environments[0].id
    const failed = await creation(envId)
    expect(failed.error).toMatch(/^NAME_NOT_SERVING/)
    // As if a process died in the middle of the name step:
    const steps = failed.steps.map((s) =>
      s.key === 'name' ? { ...s, status: 'running' as const } : s
    )
    await store.patchCreation(failed.id, { status: 'running', step: 'name', steps, error: null })

    expect(await R.recoverInterruptedCreations({ lock })).toBe(1)
    const c = await creation(envId)
    expect(c.status).toBe('interrupted')
    expect(c.steps.find((s) => s.key === 'name')).toMatchObject({ status: 'failed' })
    expect(await lock.held(envId)).toBe(false)

    const pipelines = gl.pipelinesOf(PROJECT).length
    serve = true
    await R.resumeCreation(envId, USER, 'retry', deps())
    await settle([envId])
    expect((await creation(envId)).status).toBe('done')
    expect(forkCalls()).toHaveLength(1)
    expect(gl.pipelinesOf(PROJECT).length).toBe(pipelines) // no new commit, no new deploy
  })

  it('a running row whose lock is still held is left alone by recovery', async () => {
    const out = await startAndWait(
      input({ environments: [{ key: 'production', database: { server_id: autoServer } }] })
    )
    const envId = out.environments[0].id
    const c = await creation(envId)
    await store.patchCreation(c.id, { status: 'running' })
    const token = await lock.take(envId)
    expect(await R.recoverInterruptedCreations({ lock })).toBe(0)
    expect((await creation(envId)).status).toBe('running')
    await lock.release(envId, token as string)
  })

  it('cancel between steps → cancelled; Retry finishes', async () => {
    const envIdOf = async () =>
      Number((await db('nivaro_hub_environments').where({ key: 'production' }).first('id')).id)
    const out = await startAndWait(
      input({ environments: [{ key: 'production', database: { server_id: autoServer } }] }),
      deps({
        // A cancel lands while the name step runs: the leg stops at the next boundary.
        checkName: async (host, _b, version) => {
          expect(await R.cancelCreation(await envIdOf(), USER, { flags })).toEqual({ ok: true })
          return serving(host, version)
        }
      })
    )
    const envId = out.environments[0].id
    expect((await creation(envId)).status).toBe('cancelled')
    expect((await stepOf(envId, 'name'))?.status).toBe('done')
    expect((await stepOf(envId, 'link'))?.status).toBe('pending')
    expect(adminCalls).toBe(0)
    await R.resumeCreation(envId, USER, 'retry', deps())
    await settle([envId])
    expect((await creation(envId)).status).toBe('done')
    expect(adminCalls).toBe(1)
  })

  it('cancel of a waiting creation ends it at once; retry and check refuse the wrong states', async () => {
    const out = await startAndWait(
      input({ environments: [{ key: 'production', database: { server_id: manualServer } }] })
    )
    const envId = out.environments[0].id
    await expect(R.resumeCreation(envId, USER, 'retry', deps())).rejects.toMatchObject({
      code: 'NOT_RESUMABLE',
      status: 409
    })
    expect(await R.cancelCreation(envId, USER, { flags })).toEqual({ ok: true })
    expect((await creation(envId)).status).toBe('cancelled')
    expect(await R.cancelCreation(envId, USER, { flags })).toEqual({
      ok: false,
      code: 'NOT_RUNNING'
    })
    await expect(R.resumeCreation(envId, USER, 'check', deps())).rejects.toMatchObject({
      code: 'NOT_RESUMABLE'
    })
    expect(await R.cancelCreation(999_999, USER, { flags })).toEqual({
      ok: false,
      code: 'NOT_FOUND'
    })
  })
})

// ── fix round 1: secrets on resume, made writes, orphans ─────────────────────

describe('fix round 1: runner secrets, made writes and orphans', () => {
  const one = () =>
    input({ environments: [{ key: 'production', database: { server_id: autoServer } }] })

  it('a retry that resumes at deploy scrubs the hub token, OIDC secret and GitLab token', async () => {
    let refusePipelines = true
    let plant = ''
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      if (String(url).includes('/pipelines?')) {
        if (refusePipelines) {
          refusePipelines = false
          return new Response(JSON.stringify({ message: 'down' }), { status: 500 })
        }
        // A job line that (wrongly) echoes secrets back.
        const res = await gl.fetch(url, init)
        const list = (await res.json()) as Array<{ id: number; web_url: string }>
        return new Response(
          JSON.stringify(list.map((x) => ({ ...x, web_url: `${x.web_url}?leak=${plant}` }))),
          { status: 200 }
        )
      }
      return gl.fetch(url, init)
    })
    const out = await startAndWait(one())
    const envId = out.environments[0].id
    expect((await stepOf(envId, 'deploy'))?.status).toBe('failed')
    const env = await db('nivaro_hub_environments').where({ id: envId }).first('hub_token')
    const hubToken = openSecret(env.hub_token) as string
    plant = `${hubToken}-${OIDC_SECRET}-${gl.token}`
    runs = []
    await R.resumeCreation(envId, USER, 'retry', deps())
    await settle([envId])
    expect((await creation(envId)).status).toBe('done')
    const lines = runs.flatMap((r) => r.run.lines).join('\n')
    expect(lines).toContain('?leak=')
    for (const s of [hubToken, OIDC_SECRET, gl.token]) expect(lines).not.toContain(s)
    vi.stubGlobal('fetch', gl.fetch)
  })

  it('a retry that resumes at deploy scrubs the database password and URL too', async () => {
    let refusePipelines = true
    let plant = ''
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      if (String(url).includes('/pipelines?')) {
        if (refusePipelines) {
          refusePipelines = false
          return new Response(JSON.stringify({ message: 'down' }), { status: 500 })
        }
        const res = await gl.fetch(url, init)
        const list = (await res.json()) as Array<{ id: number; web_url: string }>
        return new Response(
          JSON.stringify(list.map((x) => ({ ...x, web_url: `${x.web_url}?leak=${plant}` }))),
          { status: 200 }
        )
      }
      return gl.fetch(url, init)
    })
    const out = await startAndWait(one())
    const envId = out.environments[0].id
    expect((await stepOf(envId, 'deploy'))?.status).toBe('failed')
    const conn = await D.openDatabaseConnection(Number((await creation(envId)).made.database_id))
    const urlB64 = Buffer.from(connectionUrl(conn)).toString('base64')
    plant = `${conn.password}-${urlB64}`
    runs = []
    await R.resumeCreation(envId, USER, 'retry', deps())
    await settle([envId])
    expect((await creation(envId)).status).toBe('done')
    const lines = runs.flatMap((r) => r.run.lines).join('\n')
    expect(lines).toContain('?leak=')
    expect(lines).not.toContain(conn.password)
    expect(lines).not.toContain(urlB64)
    vi.stubGlobal('fetch', gl.fetch)
  })

  it('a row closed elsewhere during the admin step: the leg answers interrupted, env stays provisioning', async () => {
    const out = await startAndWait(one(), deps(), { stopAtOperator: true })
    const envId = out.environments[0].id
    const c = await creation(envId)
    await store.saveAppMade(c.app_id, { operator_ack: { at: new Date().toISOString(), by: OWNER } })
    activity.length = 0
    const res = await R.runCreationLeg(
      envId,
      USER,
      deps({
        link: {
          requestFirstAdmin: async () => {
            // Another writer (a restart's recovery, a delete) closes the row under the leg.
            await store.patchCreation(c.id, { status: 'interrupted' }, ['running'])
            return { result: 'created' } as never
          }
        }
      })
    )
    expect(res).toBe('interrupted')
    expect((await creation(envId)).status).toBe('interrupted')
    const env = await db('nivaro_hub_environments').where({ id: envId }).first('status')
    expect(env.status).toBe('provisioning')
    expect(activity.map((a) => a.action)).not.toContain('hub-create-done')
  })

  it('app-level and own made writes interleave without losing either', async () => {
    const out = await R.startCreation(
      input(),
      USER,
      deps({ lock: { ...lock, take: async () => null } })
    )
    for (const e of out.environments) await settle([e.id])
    const [a, b] = await Promise.all(out.environments.map((e) => creation(e.id)))
    for (let i = 1; i <= 20; i++) {
      // A's repository step (app keys) against B's config step (B's own placement/component).
      const staleB = { ...(await creation(b.environment_id)).made, driver_id: 1000 + i - 1 }
      await Promise.all([
        store.saveAppMade(a.app_id, { driver_id: 1000 + i, project_id: 2000 + i }),
        store.writeOwnMade(b.id, { ...staleB, placement_id: 3000 + i, component_id: 4000 + i })
      ])
      const mb = (await creation(b.environment_id)).made
      const ma = (await creation(a.environment_id)).made
      expect(mb).toMatchObject({ placement_id: 3000 + i, component_id: 4000 + i })
      expect(mb.driver_id).toBe(1000 + i)
      expect(ma).toMatchObject({ driver_id: 1000 + i, project_id: 2000 + i })
      expect(mb.planned?.nonce).toBeTruthy()
    }
  })

  it('a driver made before the crash is found again, never a second one', async () => {
    const out = await startAndWait(one())
    const envId = out.environments[0].id
    const c = await creation(envId)
    const driverId = c.made.driver_id
    const { driver_id: _d, ...rest } = c.made
    const steps = c.steps.map((x) =>
      x.key === 'database' ? x : { ...x, status: 'pending' as const, at: null, note: null }
    )
    await store.patchCreation(c.id, { made: rest, steps, status: 'failed' })
    await R.resumeCreation(envId, USER, 'retry', deps())
    await settle([envId])
    expect((await creation(envId)).status).toBe('done')
    expect(await db('nivaro_hub_drivers').count('* as n').first()).toMatchObject({ n: 1 })
    expect((await creation(envId)).made.driver_id).toBe(driverId)
  })

  it('a placement made before the crash is found again, never a second one', async () => {
    const out = await startAndWait(one())
    const envId = out.environments[0].id
    const c = await creation(envId)
    const placementId = c.made.placement_id
    const { placement_id: _p, component_id: _c, ...rest } = c.made
    const steps = c.steps.map((x) =>
      ['database', 'repository', 'variables'].includes(x.key)
        ? x
        : { ...x, status: 'pending' as const, at: null, note: null }
    )
    await store.patchCreation(c.id, { made: rest, steps, status: 'failed' })
    await db('nivaro_hub_environments').where({ id: envId }).update({ placement_id: null })
    await R.resumeCreation(envId, USER, 'retry', deps())
    await settle([envId])
    expect((await creation(envId)).status).toBe('done')
    expect(await db('nivaro_hub_placements').count('* as n').first()).toMatchObject({ n: 1 })
    expect(await db('nivaro_hub_components').count('* as n').first()).toMatchObject({ n: 1 })
    expect((await creation(envId)).made.placement_id).toBe(placementId)
    expect(
      (await db('nivaro_hub_environments').where({ id: envId }).first('placement_id')).placement_id
    ).toBe(placementId)
  })

  it('the branch is protected before it is created', async () => {
    await startAndWait(one())
    const at = (method: string, path: string) =>
      gl.calls.findIndex(
        (c) => c.method === method && c.path === path && /\/projects\/\d+/.test(c.url)
      )
    const protect = at('POST', '/protected_branches')
    const create = at('POST', '/repository/branches')
    expect(protect).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(protect)
  })

  it('runCreationLeg runs only queued or waiting creations; Retry is the way for the rest', async () => {
    adminAnswers = [{ result: 'refused', code: 'NO_ADMIN_ROLE' }]
    const out = await startAndWait(one())
    const envId = out.environments[0].id
    expect((await creation(envId)).status).toBe('failed')
    await expect(R.runCreationLeg(envId, USER, deps())).rejects.toMatchObject({
      code: 'NOT_RESUMABLE'
    })
  })

  it('withEnvironmentsQuiet interrupts a stale running row and goes on', async () => {
    const out = await startAndWait(one())
    const envId = out.environments[0].id
    const c = await creation(envId)
    await store.patchCreation(c.id, { status: 'running', step: 'deploy' })
    const done = await R.withEnvironmentsQuiet([envId], async () => 'deleted', { lock })
    expect(done).toBe('deleted')
    expect((await creation(envId)).status).toBe('interrupted')
  })
})

// ── liveness beside the lock (ruling P3-31) ─────────────────────────────────

describe('a live leg proves it is alive (heartbeat)', () => {
  const one = () =>
    input({ environments: [{ key: 'production', database: { server_id: autoServer } }] })
  const lockKey = (envId: number) => hubPromoteLockKey(envId)

  /** Starts one environment, Installed, and parks its leg inside the deploy wait. */
  async function parkedInDeploy(renewMs?: number) {
    const gate: { release: () => void; parked: boolean } = { release: () => {}, parked: false }
    const held = new Promise<void>((r) => {
      gate.release = r
    })
    const d = deps({
      ...(renewMs ? { renewMs } : {}),
      sleep: async (ms: number, signal?: AbortSignal) => {
        clock.t += ms
        if (gate.parked) return
        const deploying = await db('nivaro_hub_creations')
          .where({ status: 'running', step: 'deploy' })
          .first('id')
        if (!deploying) return
        gate.parked = true
        await Promise.race([
          held,
          new Promise<void>((r) => signal?.addEventListener('abort', () => r(), { once: true }))
        ])
      }
    })
    const out = await startAndWait(one(), d, { stopAtOperator: true })
    const envId = out.environments[0].id
    await R.confirmOperatorInstalled(envId, USER, d)
    for (let i = 0; i < 500 && !gate.parked; i++) await new Promise((r) => setTimeout(r, 2))
    expect(gate.parked).toBe(true)
    return { envId, d, gate }
  }

  it('Redis loses the lock mid-deploy: cron, Retry and delete all leave the live leg alone', async () => {
    const { envId, d, gate } = await parkedInDeploy()
    const row = await creation(envId)
    expect(row.status).toBe('running')
    expect(row.heartbeat_at).not.toBeNull()
    redis.store.delete(lockKey(envId))
    expect(await lock.held(envId)).toBe(false)

    expect(await R.recoverInterruptedCreations({ lock })).toBe(0)
    await R.checkWaitingCreations(d)
    await expect(R.resumeCreation(envId, USER, 'retry', d)).rejects.toMatchObject({
      code: 'NOT_RESUMABLE'
    })
    await expect(
      R.withEnvironmentsQuiet([envId], async () => 'deleted', { lock })
    ).rejects.toMatchObject({ code: 'CREATION_RUNNING' })
    expect(await R.runCreationLeg(envId, USER, d)).toBe('busy')
    expect((await creation(envId)).status).toBe('running')
    expect(await lock.held(envId)).toBe(false) // the delete gate let go of what it took

    gate.release()
    await settle([envId], d)
    expect((await creation(envId)).status).toBe('done')
  })

  it('a running row another Hub vouches for (fresh heartbeat, no lock) is never taken over', async () => {
    const out = await startAndWait(one())
    const envId = out.environments[0].id
    const c = await creation(envId)
    await store.patchCreation(c.id, { status: 'running', step: 'deploy', heartbeat_at: new Date() })
    expect(await lock.held(envId)).toBe(false)

    expect(await R.recoverInterruptedCreations({ lock })).toBe(0)
    await expect(R.resumeCreation(envId, USER, 'retry', deps())).rejects.toMatchObject({
      code: 'NOT_RESUMABLE'
    })
    await expect(
      R.withEnvironmentsQuiet([envId], async () => 'deleted', { lock })
    ).rejects.toMatchObject({ code: 'CREATION_RUNNING' })
    await store.patchCreation(c.id, { status: 'waiting' })
    await store.patchCreation(c.id, { status: 'running' })
    expect((await creation(envId)).status).toBe('running')

    // The heartbeat goes stale (its Hub died): healed to interrupted, Retry works again.
    await store.patchCreation(c.id, { heartbeat_at: new Date(Date.now() - 3 * 60_000) })
    expect(await R.recoverInterruptedCreations({ lock })).toBe(1)
    expect((await creation(envId)).status).toBe('interrupted')
    expect((await creation(envId)).heartbeat_at).toBeNull()
  })

  it('a renewal that finds the lock gone stops the leg in its wait (interrupted, Retry resumes)', async () => {
    const { envId, d } = await parkedInDeploy(20)
    redis.store.delete(lockKey(envId))
    await R.awaitCreation(envId)
    const c = await creation(envId)
    expect(c.status).toBe('interrupted')
    expect(c.error).toMatch(/^INTERRUPTED: The environment lock was lost/)
    expect(c.steps.find((s) => s.key === 'deploy')).toMatchObject({ status: 'failed' })
    expect(c.heartbeat_at).toBeNull()

    await R.resumeCreation(envId, USER, 'retry', deps())
    await settle([envId])
    expect((await creation(envId)).status).toBe('done')
    void d
  })
})

// ── the operator step (ruling P3-22) ─────────────────────────────────────────

describe('operator step', () => {
  const one = () =>
    input({ environments: [{ key: 'production', database: { server_id: autoServer } }] })
  const MARKED = [
    '\u001b[0Ksection_start:1719907544:step_script\r\u001b[0K\u001b[32;1mExecuting "step_script"\u001b[0;m',
    'deploy: stack demo--production, image nodeworks/nivaro@sha256:aaa, hosts demo.apps.example.com',
    '2024-07-02T08:05:44.123456Z 01E nivaro-hub-deploy: stack demo--production is bound to another deploy key',
    '2024-07-02T08:05:44.123499Z 01E NIVARO_HUB_KEY_NOT_INSTALLED',
    '\u001b[31;1mERROR: Job failed: exit code 77\u001b[0;m',
    ''
  ].join('\r\n')
  /** Every deploy job of new pipelines: fails (and fails again when retried) with `trace`. */
  function deployFails(trace: string) {
    const t = gl.projects.get(TEMPLATE)
    if (t)
      t.jobs = (ref) =>
        ref === 'main'
          ? []
          : [
              {
                name: 'deploy',
                statuses: ['running', 'failed'],
                onRetry: ['running', 'failed'],
                trace
              }
            ]
  }
  /** From now on a retried deploy job succeeds. */
  function deployWorks() {
    for (const pl of gl.pipelinesOf(PROJECT))
      for (const j of pl.jobs) {
        j.onRetry = ['running', 'success']
        j.trace = ''
      }
  }

  it('waits right after the config step, showing the manager lines; nothing moves it but Installed', async () => {
    const out = await startAndWait(input(), deps(), { stopAtOperator: true })
    for (const e of out.environments) {
      const c = await creation(e.id)
      expect(c).toMatchObject({ status: 'waiting', waiting_for: 'operator' })
      expect((await stepOf(e.id, 'config'))?.status).toBe('done')
      expect(await stepOf(e.id, 'deploy')).toMatchObject({
        status: 'waiting',
        note: expect.stringContaining('press Installed')
      })
      const view = await R.readCreation(e.id)
      expect(view?.waiting_for).toBe('operator')
      expect(view?.operator_installed_at).toBeNull()
      expect(view?.deploy_key?.authorized_keys).toContain('nivaro-hub-deploy demo keyid=SHA256:')
      expect(view?.deploy_key?.key_conf).toContain('stack=demo--production')
      expect(JSON.stringify(view)).not.toContain('PRIVATE KEY')
    }
    const id = out.environments[0].id
    expect(await R.resumeCreation(id, USER, 'check', deps())).toEqual({ status: 'waiting' })
    expect(await R.checkWaitingCreations(deps())).toBe(0)
    expect((await creation(id)).status).toBe('waiting')
    expect(gl.retries).toHaveLength(0)
    await expect(R.confirmOperatorInstalled(999_999, USER, deps())).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
  })

  it('Installed: every environment of the app waiting for it deploys once, then done', async () => {
    const out = await startAndWait(input(), deps(), { stopAtOperator: true })
    const ids = out.environments.map((e) => e.id)
    const r = await R.confirmOperatorInstalled(ids[1], USER, deps())
    expect(r).toEqual({ status: 'running', environments: ids })
    for (const id of ids) await R.awaitCreation(id)
    for (const id of ids) expect((await creation(id)).status).toBe('done')
    expect((await R.readCreation(ids[0]))?.operator_installed_at).toBeTruthy()
    await expect(R.confirmOperatorInstalled(ids[0], USER, deps())).rejects.toMatchObject({
      code: 'NOT_WAITING_FOR_OPERATOR',
      status: 409
    })
  })

  it('a deploy refused with the key marker goes back to the operator wait; Installed again finishes', async () => {
    deployFails(MARKED)
    const out = await startAndWait(one(), deps(), { stopAtOperator: true })
    const envId = out.environments[0].id
    await R.confirmOperatorInstalled(envId, USER, deps())
    await R.awaitCreation(envId)
    let c = await creation(envId)
    expect(c).toMatchObject({ status: 'waiting', waiting_for: 'operator' })
    expect((await stepOf(envId, 'deploy'))?.note).toContain('refused this app’s deploy key')
    expect((await R.readCreation(envId))?.operator_installed_at).toBeNull()
    // The push's own deploy job was waited for: no retry, and no automatic second try.
    expect(gl.retries).toHaveLength(0)
    expect(await R.checkWaitingCreations(deps())).toBe(0)
    expect(gl.retries).toHaveLength(0)

    deployWorks()
    await R.confirmOperatorInstalled(envId, USER, deps())
    await R.awaitCreation(envId)
    c = await creation(envId)
    expect(c.status).toBe('done')
    expect(gl.retries).toHaveLength(1) // the failed job ran again once
  })

  it('a deploy failure without the marker is an ordinary failure; Retry runs it again', async () => {
    deployFails(
      'deploy: the manager did not deploy demo--production\nERROR: Job failed: exit code 1\n'
    )
    const out = await startAndWait(one())
    const envId = out.environments[0].id
    const c = await creation(envId)
    expect(c.status).toBe('failed')
    expect(c.error).toMatch(/^DEPLOY_FAILED/)
    expect((await stepOf(envId, 'deploy'))?.status).toBe('failed')
    deployWorks()
    await R.resumeCreation(envId, USER, 'retry', deps())
    await settle([envId])
    expect((await creation(envId)).status).toBe('done')
  })

  it('Installed while a promotion holds the environment: the leg runs once the lock frees', async () => {
    const out = await startAndWait(one(), deps(), { stopAtOperator: true })
    const envId = out.environments[0].id
    const token = (await lock.take(envId)) as string
    expect(await R.confirmOperatorInstalled(envId, USER, deps())).toMatchObject({
      status: 'running'
    })
    await R.awaitCreation(envId)
    // The leg found the environment busy: still waiting, the press is kept (not lost, not stale).
    expect(await creation(envId)).toMatchObject({ status: 'waiting', waiting_for: 'operator' })
    expect((await R.readCreation(envId))?.operator_installed_at).toBeTruthy()
    expect(await R.resumeCreation(envId, USER, 'check', deps())).toEqual({ status: 'waiting' })
    expect((await stepOf(envId, 'deploy'))?.note).toBe(R.QUEUED_NOTE)
    expect(await R.checkWaitingCreations(deps())).toBe(0)
    await lock.release(envId, token)
    // Lock free: the next tick runs exactly that deploy.
    expect(await R.checkWaitingCreations(deps())).toBe(1)
    await R.awaitCreation(envId)
    expect((await creation(envId)).status).toBe('done')
  })

  /** The push's own deploy job, still running when Installed is pressed, started before it. */
  function earlyJob(onRetry: string[], trace = MARKED) {
    const t = gl.projects.get(TEMPLATE)
    if (t)
      t.jobs = (ref) =>
        ref === 'main'
          ? []
          : [
              {
                name: 'deploy',
                statuses: ['running', 'failed'],
                onRetry,
                trace,
                started_at: '2020-01-01T00:00:00.000Z'
              }
            ]
  }

  it('a marked refusal from a job that started before Installed runs that job once more', async () => {
    earlyJob(['running', 'success'])
    const out = await startAndWait(one(), deps(), { stopAtOperator: true })
    const envId = out.environments[0].id
    await R.confirmOperatorInstalled(envId, USER, deps())
    await R.awaitCreation(envId)
    expect((await creation(envId)).status).toBe('done')
    expect(gl.retries).toHaveLength(1)
  })

  it('…and when the job run again still refuses, back to the operator wait (no more tries)', async () => {
    earlyJob(['running', 'failed'])
    const out = await startAndWait(one(), deps(), { stopAtOperator: true })
    const envId = out.environments[0].id
    await R.confirmOperatorInstalled(envId, USER, deps())
    await R.awaitCreation(envId)
    expect(await creation(envId)).toMatchObject({ status: 'waiting', waiting_for: 'operator' })
    expect(gl.retries).toHaveLength(1)
    expect((await R.readCreation(envId))?.operator_installed_at).toBeNull()
    expect(await R.checkWaitingCreations(deps())).toBe(0)
    expect(gl.retries).toHaveLength(1)
  })

  it('a marked refusal from a job that started after Installed goes straight back to waiting', async () => {
    earlyJob(['running', 'success'])
    const t = gl.projects.get(TEMPLATE)
    const base = t?.jobs ?? (() => [])
    if (t)
      t.jobs = (ref) => base(ref).map((j) => ({ ...j, started_at: '2999-01-01T00:00:00.000Z' }))
    const out = await startAndWait(one(), deps(), { stopAtOperator: true })
    const envId = out.environments[0].id
    await R.confirmOperatorInstalled(envId, USER, deps())
    await R.awaitCreation(envId)
    expect(await creation(envId)).toMatchObject({ status: 'waiting', waiting_for: 'operator' })
    expect(gl.retries).toHaveLength(0)
  })

  it('the marker counts only as a line of its own', async () => {
    const { hasKeyNotInstalledLine } = await import('../../../services/hub/create/steps.js')
    expect(hasKeyNotInstalledLine(MARKED)).toBe(true)
    expect(hasKeyNotInstalledLine('NIVARO_HUB_KEY_NOT_INSTALLED')).toBe(true)
    expect(hasKeyNotInstalledLine('a\n\u001b[31mNIVARO_HUB_KEY_NOT_INSTALLED\u001b[0m\nb')).toBe(
      true
    )
    for (const no of [
      'echo NIVARO_HUB_KEY_NOT_INSTALLED',
      'NIVARO_HUB_KEY_NOT_INSTALLED_NOT',
      'deploy: NIVARO_HUB_KEY_NOT_INSTALLED here',
      'exit code 77',
      ''
    ])
      expect(hasKeyNotInstalledLine(no), no).toBe(false)
  })
})

// ── the deploy repository (P3-7, P3-9, P3-16) ────────────────────────────────

describe('deploy repository', () => {
  it('a fork GitLab made before failing is resumed by id on retry (no second fork)', async () => {
    gl.forkImport = [...Array(45).fill('started'), 'finished']
    const out = await startAndWait(
      input({ environments: [{ key: 'production', database: { server_id: autoServer } }] })
    )
    const envId = out.environments[0].id
    const c = await creation(envId)
    expect(c.error).toMatch(/^IMPORT_TIMEOUT/)
    expect(c.made.project_id).toBeTruthy()
    await R.resumeCreation(envId, USER, 'retry', deps())
    await settle([envId])
    expect((await creation(envId)).status).toBe('done')
    expect(forkCalls()).toHaveLength(1)
  })

  /**
   * A fork GitLab made before the Hub could record it (import timeout), then the record lost —
   * only GitLab says whose it is. `plant` rewrites the project as an attacker might.
   */
  async function lostFork(
    plant: (p: { description?: string; creator_id?: number }, mark: string) => void
  ) {
    gl.forkImport = [...Array(45).fill('started'), 'finished']
    const out = await startAndWait(
      input({ environments: [{ key: 'production', database: { server_id: autoServer } }] })
    )
    const envId = out.environments[0].id
    const c = await creation(envId)
    expect(c.error).toMatch(/^IMPORT_TIMEOUT/)
    const { project_id: _drop, project_path: _path, ...rest } = c.made
    await store.patchCreation(c.id, { made: rest })
    const mark = `nivaro-hub creation ${c.id} ${c.made.planned?.nonce}`
    const p = gl.projects.get(PROJECT)
    expect(p?.description).toBe(mark)
    if (p) plant(p, mark)
    await R.resumeCreation(envId, USER, 'retry', deps())
    await settle([envId])
    return await creation(envId)
  }

  it('a project at the path is adopted with this creation’s exact mark made by the Hub user', async () => {
    const c = await lostFork(() => {})
    expect(c.status).toBe('done')
    expect(forkCalls()).toHaveLength(1)
    // The nonce never leaves the creation row.
    expect(JSON.stringify(await R.readCreation(c.environment_id))).not.toContain(
      String(c.made.planned?.nonce)
    )
  })

  it('P3-23: many marks in the description are not ours', async () => {
    const c = await lostFork((p, mark) => {
      p.description = Array.from({ length: 50 }, (_, i) => `nivaro-hub creation ${i} x`)
        .concat(mark)
        .join('\n')
    })
    expect(c.error).toMatch(/^PROJECT_EXISTS/)
    expect(gl.variablesOf(PROJECT)).toHaveLength(0)
  })

  it('P3-23: the right mark but another creator is not ours', async () => {
    const c = await lostFork((p) => {
      p.creator_id = 4242
    })
    expect(c.error).toMatch(/^PROJECT_EXISTS/)
    expect(gl.variablesOf(PROJECT)).toHaveLength(0)
  })

  it('P3-23: the right mark with extra text is not ours', async () => {
    const c = await lostFork((p, mark) => {
      p.description = `${mark} (planted)`
    })
    expect(c.error).toMatch(/^PROJECT_EXISTS/)
  })

  it('P3-23: a guessed creation id without the nonce is not ours', async () => {
    const c = await lostFork((p, mark) => {
      p.description = mark.split(' ').slice(0, 3).join(' ')
    })
    expect(c.error).toMatch(/^PROJECT_EXISTS/)
  })

  it('GitLab refusing the CI configuration path fails closed: nothing else is pushed', async () => {
    gl.forkImport = ['finished']
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      if (init.method === 'PUT' && /\/projects\/\d+$/.test(String(url)))
        return new Response(JSON.stringify({ message: 'no' }), { status: 403 })
      return gl.fetch(url, init)
    })
    const out = await startAndWait(
      input({ environments: [{ key: 'production', database: { server_id: autoServer } }] })
    )
    const c = await creation(out.environments[0].id)
    expect(c.status).toBe('failed')
    expect(c.error).toMatch(/^CI_CONFIG_REFUSED/)
    expect(gl.variablesOf(PROJECT)).toHaveLength(0)
    expect(gl.pipelinesOf(PROJECT)).toHaveLength(0)
    vi.stubGlobal('fetch', gl.fetch)
  })

  it('a moved template_ref reaches every app of the target (syncTargetApps)', async () => {
    await startAndWait(
      input({ environments: [{ key: 'production', database: { server_id: autoServer } }] })
    )
    await db('nivaro_hub_targets')
      .where({ id: targetId })
      .update({ config: JSON.stringify({ ...targetConfig, template_ref: 'v1.1.0' }) })
    const out = await R.syncTargetApps(targetId)
    expect(out).toEqual([{ app_id: expect.any(Number), ok: true }])
    expect(gl.projects.get(PROJECT)?.ci_config_path).toBe(`ci/deploy.yml@${TEMPLATE}:v1.1.0`)
  })

  it('a rotated target token reaches the driver the creation made (P3-32)', async () => {
    const out = await startAndWait(
      input({ environments: [{ key: 'production', database: { server_id: autoServer } }] })
    )
    const made = await store.appMade((await creation(out.environments[0].id)).app_id)
    const driverId = made.driver_id as number
    const previous = (await db('nivaro_hub_targets').where({ id: targetId }).first()).secret
    // An unrelated driver keeps its own token.
    const otherId = await insertId('nivaro_hub_drivers', {
      kind: 'gitlab',
      name: 'other',
      config: JSON.stringify({ api: 'https://gitlab.example.com', project: 'x/y' }),
      secret: sealSecret('glpat-other-token-value-00000')
    })
    const rotated = 'glpat-ROTATED-hub-token-9876543210'
    secretsSeen.add(rotated)
    gl.token = rotated
    await db('nivaro_hub_targets')
      .where({ id: targetId })
      .update({ secret: sealSecret(rotated) })
    const res = await R.syncTargetApps(targetId, { previousSecret: previous })
    expect(res).toEqual([{ app_id: expect.any(Number), ok: true, driver_token: 'updated' }])
    const driver = await db('nivaro_hub_drivers').where({ id: driverId }).first()
    expect(openSecret(driver.secret)).toBe(rotated)
    const other = await db('nivaro_hub_drivers').where({ id: otherId }).first()
    expect(openSecret(other.secret)).toBe('glpat-other-token-value-00000')
    // A save that did not change the token touches no driver.
    const again = await R.syncTargetApps(targetId)
    expect(again[0]).not.toHaveProperty('driver_token')
  })

  it('a promotion of a created app re-checks the CI settings (verify only, fail closed)', async () => {
    const out = await startAndWait(
      input({ environments: [{ key: 'production', database: { server_id: autoServer } }] })
    )
    const envId = out.environments[0].id
    const made = await store.appMade((await creation(envId)).app_id)
    const step = { driverId: made.driver_id as number, component: 'api' } as never
    const ctx = gl.ctx(PROJECT)
    // As the Hub set it: passes, and nothing is written.
    const before = gl.calls.length
    await ciConfigVerifier(envId)(step, ctx)
    expect(gl.calls.slice(before).every((c) => c.method === 'GET')).toBe(true)
    // Someone points the project at its own CI: refused, and the Hub does not put it back here.
    const proj = gl.projects.get(PROJECT)
    if (proj) proj.ci_config_path = '.gitlab-ci.yml'
    await expect(ciConfigVerifier(envId)(step, ctx)).rejects.toMatchObject({
      code: 'CI_CONFIG_REFUSED'
    })
    expect(gl.projects.get(PROJECT)?.ci_config_path).toBe('.gitlab-ci.yml')
    // A step in another repository (a portal added later) is not checked.
    await ciConfigVerifier(envId)({ driverId: 99_999, component: 'frontend' } as never, {
      ...ctx,
      project: 'apps/portal'
    })
    // An app the Hub did not create is never checked.
    await db('nivaro_hub_apps').update({ target_id: null })
    await ciConfigVerifier(envId)(step, ctx)
  })
})

describe('syncTargetApps (bounded)', () => {
  /** Apps on the target whose creation row recorded a project id (null: none recorded). */
  async function recordedApps(projects: Array<number | null>) {
    const ids: number[] = []
    for (const [i, p] of projects.entries()) {
      const id = await insertId('nivaro_hub_apps', {
        key: `bare${i}`,
        name: `Bare ${i}`,
        signin_mode: 'direct',
        extensions: '[]',
        target_id: targetId
      })
      ids.push(id)
      if (p !== null)
        await db('nivaro_hub_creations').insert({
          app_id: id,
          environment_id: 900_000 + i,
          status: 'done',
          steps: '[]',
          made: JSON.stringify({ project_id: p }),
          version: '1.2.3',
          first_admin: '{"email":"a@example.com"}'
        })
    }
    return ids
  }

  it('runs at most 3 apps at once and reports each app', async () => {
    const ids = await recordedApps([101, 102, null, 103, 104, 105])
    let inFlight = 0
    let most = 0
    const seen: string[] = []
    const out = await R.syncTargetApps(targetId, {
      syncApp: async (_t, project) => {
        inFlight++
        most = Math.max(most, inFlight)
        seen.push(project)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        if (project === '104') throw Object.assign(new Error('x'), { code: 'GITLAB_FORBIDDEN' })
      }
    })
    expect(most).toBe(3)
    expect(seen.sort()).toEqual(['101', '102', '103', '104', '105'])
    // The app with no project is left out; one app's failure is its own entry.
    expect(out).toEqual([
      { app_id: ids[0], ok: true },
      { app_id: ids[1], ok: true },
      { app_id: ids[3], ok: true },
      { app_id: ids[4], ok: false, code: 'GITLAB_FORBIDDEN' },
      { app_id: ids[5], ok: true }
    ])
  })

  it('answers what is not done within the budget as pending and finishes it in the background', async () => {
    const ids = await recordedApps([201, 202])
    let release = () => {}
    const slow = new Promise<void>((r) => (release = r))
    const done: string[] = []
    const out = await R.syncTargetApps(targetId, {
      budgetMs: 30,
      syncApp: async (_t, project) => {
        if (project === '202') await slow
        done.push(project)
      }
    })
    expect(out).toEqual([
      { app_id: ids[0], ok: true },
      { app_id: ids[1], ok: false, code: 'PENDING', pending: true }
    ])
    expect(done).toEqual(['201'])
    // A bounded wait gives up on it; an unbounded one sees it finish.
    await R.awaitTargetSyncs(20)
    expect(done).toEqual(['201'])
    release()
    await R.awaitTargetSyncs()
    expect(done).toEqual(['201', '202'])
  })

  /** A created app whose creation rows lost the recorded project id (the deploy_project stays). */
  async function createdWithoutProjectId() {
    const out = await startAndWait(
      input({ environments: [{ key: 'production', database: { server_id: autoServer } }] })
    )
    for (const c of await store.creationsOfApp(out.app_id)) {
      const made = { ...c.made }
      delete made.project_id
      await db('nivaro_hub_creations')
        .where({ id: c.id })
        .update({ made: JSON.stringify(made) })
    }
    await db('nivaro_hub_targets')
      .where({ id: targetId })
      .update({ config: JSON.stringify({ ...targetConfig, template_ref: 'v1.2.0' }) })
    return out
  }

  it('deploy_project fallback: ours by the creation mark and the Hub’s own user', async () => {
    const out = await createdWithoutProjectId()
    expect(await R.syncTargetApps(targetId)).toEqual([{ app_id: out.app_id, ok: true }])
    expect(gl.projects.get(PROJECT)?.ci_config_path).toBe(`ci/deploy.yml@${TEMPLATE}:v1.2.0`)
  })

  it('deploy_project fallback: another description, or no creation row left → PROJECT_NOT_OURS', async () => {
    const out = await createdWithoutProjectId()
    const proj = gl.projects.get(PROJECT)
    const mark = proj?.description
    if (proj) proj.description = 'planted by someone'
    expect(await R.syncTargetApps(targetId)).toEqual([
      { app_id: out.app_id, ok: false, code: 'PROJECT_NOT_OURS' }
    ])
    if (proj) proj.description = mark
    await db('nivaro_hub_creations').where({ app_id: out.app_id }).del()
    expect(await R.syncTargetApps(targetId)).toEqual([
      { app_id: out.app_id, ok: false, code: 'PROJECT_NOT_OURS' }
    ])
    // Nothing was configured on a project that is not ours.
    expect(gl.projects.get(PROJECT)?.ci_config_path).toBe(`ci/deploy.yml@${TEMPLATE}:v1.0.0`)
  })
})

describe('placeOf / samePlace', () => {
  it('a trailing dot and case never make two places of one host, on either side', async () => {
    const { placeOf, samePlace } = await import('../../../services/hub/db/stored-connection.js')
    const a = placeOf({ engine: 'pg', host: 'PG1.Example.com.', port: null })
    expect(a).toEqual({ engine: 'pg', host: 'pg1.example.com', port: 5432 })
    expect(samePlace(a, { engine: 'pg', host: 'pg1.example.com', port: 5432 })).toBe(true)
    // A place stored before the normalisation (with its dot) still compares.
    expect(samePlace({ engine: 'pg', host: 'pg1.example.com.', port: 5432 }, a)).toBe(true)
    expect(samePlace(a, { engine: 'pg', host: 'pg2.example.com', port: 5432 })).toBe(false)
  })
})

// ── deletes (Task 10 helpers) ────────────────────────────────────────────────

describe('withEnvironmentsQuiet', () => {
  it('refuses CREATION_RUNNING while a leg or promotion holds the environment', async () => {
    const out = await startAndWait(
      input({ environments: [{ key: 'production', database: { server_id: manualServer } }] })
    )
    const envId = out.environments[0].id
    const token = await lock.take(envId)
    await expect(
      R.withEnvironmentsQuiet([envId], async () => 'deleted', { lock })
    ).rejects.toMatchObject({ code: 'CREATION_RUNNING', status: 409 })
    await lock.release(envId, token as string)
    const done = await R.withEnvironmentsQuiet(
      [envId],
      async () => {
        await R.deleteCreationRows(db, [envId])
        return 'deleted'
      },
      { lock }
    )
    expect(done).toBe('deleted')
    expect(await store.readCreationRow(envId)).toBeNull()
    expect(await lock.held(envId)).toBe(false)
  })
})

describe('attachDatabase (existing databases)', () => {
  it('only a ready row attaches; a fenced (dropping) one is refused', async () => {
    const id = await insertId('nivaro_hub_databases', {
      server_id: autoServer,
      engine: 'pg',
      host: 'pg1.example.com',
      database_name: 'nivaro_legacy',
      login_name: 'legacy',
      status: 'dropping',
      adopted: true
    })
    const appId = await insertId('nivaro_hub_apps', { key: 'legacy', name: 'Legacy' })
    const envId = await insertId('nivaro_hub_environments', {
      app_id: appId,
      key: 'production',
      base_url: 'https://legacy.example.com'
    })
    await expect(
      D.attachDatabase(id, envId, undefined, { expect: ['ready'] })
    ).rejects.toMatchObject({ code: 'DATABASE_DROPPING' })
    await db('nivaro_hub_databases').where({ id }).update({ status: 'requested' })
    await expect(
      D.attachDatabase(id, envId, undefined, { expect: ['ready'] })
    ).rejects.toMatchObject({ code: 'DATABASE_NOT_READY' })
    await db('nivaro_hub_databases').where({ id }).update({ status: 'ready' })
    await D.attachDatabase(id, envId, undefined, { expect: ['ready'] })
    expect((await db('nivaro_hub_environments').where({ id: envId }).first()).db_ref).toBe(
      `hub-db:${id}`
    )
  })
})

describe('deploy key', () => {
  it('an OpenSSH ed25519 pair whose keyid is the ssh-keygen fingerprint', async () => {
    const { generateDeployKey, managerLines } = await import(
      '../../../services/hub/create/deploy-key.js'
    )
    const { createHash } = await import('node:crypto')
    const k = generateDeployKey('nivaro-hub-demo')
    expect(k.privateKey).toMatch(
      /^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END OPENSSH PRIVATE KEY-----\n$/
    )
    expect(k.publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI\S+ nivaro-hub-demo$/)
    const blob = Buffer.from(k.publicKey.split(' ')[1], 'base64')
    expect(k.keyid).toBe(
      `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
    )
    expect(generateDeployKey('nivaro-hub-demo').keyid).not.toBe(k.keyid)
    const lines = managerLines({
      appKey: 'demo',
      publicKey: k.publicKey,
      keyid: k.keyid,
      stacks: ['demo--staging'],
      hosts: ['demo--staging.apps.example.com'],
      network: 'proxy',
      image: 'nodeworks/nivaro'
    })
    expect(lines.authorized_keys).toBe(
      `command="/usr/local/bin/nivaro-hub-deploy demo keyid=${k.keyid}",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,restrict ${k.publicKey}`
    )
    expect(lines.key_conf_path).toBe('/etc/nivaro-hub-deploy/keys/demo.conf')
    expect(() => generateDeployKey('bad comment')).toThrow()
    expect(() =>
      managerLines({
        ...{ appKey: 'demo', keyid: 'x', publicKey: 'y' },
        stacks: [],
        hosts: [],
        network: 'p',
        image: 'i'
      })
    ).toThrow()
  })
})
