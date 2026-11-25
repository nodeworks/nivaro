import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Gap `create` (0.3.215): creating an app straight onto a Docker driver (the Hub agent deploys
// the stack) and straight onto a shared deployment (place-shared as a creation step). Real
// SQLite holds every Hub row; the database server is a fake provisioner; the agent deploy, the
// placement run, the app side (name, link, first admin) and the clock are injected. Every text
// the runner wrote is swept for secrets at the end.

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

const fake = { databases: new Set<string>(), logins: new Map<string, string>() }

vi.mock('../../../services/hub/db/provisioner.js', async (orig) => {
  const real = (await orig()) as typeof import('../../../services/hub/db/provisioner.js')
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
    async ensureLogin(_a: unknown, login: string, password: string) {
      fake.logins.set(login, password)
      return 'created'
    },
    async ensureDatabase(_a: unknown, name: string) {
      fake.databases.add(name)
      return 'created'
    },
    async ensureOwner() {},
    async drop() {},
    async checkApp() {
      return {
        state: 'empty',
        ok: true,
        version: '16.0',
        migrations: null,
        last_migration: null,
        text: 'Checked: empty',
        at: new Date().toISOString()
      }
    }
  }
  return {
    ...real,
    provisionerFor: () => prov,
    withServerKnex: async (_s: unknown, _a: unknown, fn: (k: unknown) => Promise<unknown>) =>
      fn({ admin: true }),
    withAppKnex: async (conn: { database: string }, fn: (k: unknown) => Promise<unknown>) =>
      fn({ raw: async () => [{ s: 'pg-main', p: 5432, d: conn.database }] })
  }
})

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const migrations = await Promise.all([
  import('../../../db/migrations/542_hub_tables.js'),
  import('../../../db/migrations/543_hub_promotions.js'),
  import('../../../db/migrations/544_hub_databases.js'),
  import('../../../db/migrations/545_hub_creations.js'),
  import('../../../db/migrations/546_hub_stack_settings.js'),
  import('../../../db/migrations/551_hub_signins.js'),
  import('../../../db/migrations/552_hub_shared_deployments.js'),
  import('../../../db/migrations/553_hub_moves.js'),
  // Hub enhancement 24: the Docker creation's last step reads its template install row.
  import('../../../db/migrations/571_hub_app_templates.js')
])
const R = await import('../../../services/hub/create/run.js')
const store = await import('../../../services/hub/create/store.js')
const { redisPromoteLock } = await import('../../../services/hub/promote-lock.js')
const { openSecret, sealSecret } = await import('../../../services/hub/secrets.js')
const { openStackSecrets, readStackSettings } = await import(
  '../../../services/hub/docker/stack-settings.js'
)
const { deployedStack } = await import('../../../services/hub/docker/stack-guards.js')
const { listComponents } = await import('../../../services/hub/components.js')

import type { CreationDeps } from '../../../services/hub/create/run.js'
import type { CreateAppInput } from '../../../services/hub/create/types.js'
import type { AgentHealth } from '../../../services/hub/docker/agent-types.js'
import type { DockerStepOps } from '../../../services/hub/docker/run-step.js'
import type { PromotionStep } from '../../../services/hub/promote-types.js'
import type { JobRunHandle } from '../../../services/job-runs.js'

const KEY = 'e'.repeat(64)
const OWNER = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
const USER = { id: OWNER }
const DIGEST = `sha256:${'a'.repeat(64)}`
const ADMIN = { user: 'hubprovisioner', password: 'Adm1nPassw0rd-very-secret' }
const OIDC_SECRET = 'oidc-Secr3t-value-xyz-0123'
const REDIS_SECRET = 'redis://:Redis-Secr3t-9876@redis.example.com:6379'
const AGENT_TOKEN = 'agent-token-0123456789abcdef-0123456789'
const PIN = `nodeworks/efp-ops@sha256:${'c'.repeat(64)}`
const ENV = { HUB_URL: 'https://hub.example.com' } as unknown as NodeJS.ProcessEnv

const health = (over: Partial<AgentHealth> = {}): AgentHealth => ({
  api: 1,
  agent_version: '0.2.2',
  engine_api: '1.45',
  swarm: { manager: true, node_id: 'n1', nodes: 1 },
  images: ['nodeworks/nivaro', 'nodeworks/efp-ops'],
  host_suffixes: ['.apps.example.com'],
  edge: 'traefik',
  publish_ports: null,
  extensions_shared: false,
  redis_bundled: true,
  env_prefixes: ['EFP_'],
  ...over
})

const written: string[] = []
const secretsSeen = new Set<string>([ADMIN.password, OIDC_SECRET, REDIS_SECRET, AGENT_TOKEN])

function fakeRun(): JobRunHandle {
  return {
    id: null,
    progress() {},
    log(line) {
      written.push(line)
    },
    async complete(o) {
      written.push(o ?? '')
    },
    async fail(err) {
      written.push(err instanceof Error ? err.message : String(err))
    }
  }
}

function fakeRedis() {
  const m = new Map<string, string>()
  return {
    async set(key: string, value: string, ...args: Array<string | number>) {
      if (args.includes('NX') && m.has(key)) return null
      m.set(key, value)
      return 'OK'
    },
    async get(key: string) {
      return m.get(key) ?? null
    },
    async del(...keys: string[]) {
      let n = 0
      for (const k of keys) if (m.delete(k)) n++
      return n
    },
    async exists(key: string) {
      return m.has(key) ? 1 : 0
    },
    async eval(script: string, _n: number, ...args: Array<string | number>) {
      const [key, token] = args.map(String)
      if (m.get(key) !== token) return 0
      if (script.includes("'del'")) m.delete(key)
      return 1
    }
  }
}

let driverId: number
let sharedId: number
let autoServer: number
let applied: Array<{ step: PromotionStep; envId: number; secrets: Record<string, string> }>
let deployFails: string | null
let verifyFails: string | null
let verified: Array<{ envId: number; want: string }>
let beforeApplyHook: ((envId: number) => Promise<void>) | null
let agentHealthNow: AgentHealth
let adminCalls: Array<{ base: string; email: string }>
let placeCalls: Array<{ envId: number; input: Record<string, unknown>; token: string }>
let placeFails: string | null
const clock = { t: 1_000_000 }

/** The agent deploy, faked: it records what it would send, as the real step writes the pins. */
const dockerOps: DockerStepOps = {
  async deploy(step, ctx, log, hooks) {
    const envId = Number(ctx.envId)
    await beforeApplyHook?.(envId)
    // The real step's last chance to stop (run-step.ts): nothing is applied after it.
    if (await hooks?.beforeApply?.()) return null
    // What the real renderer would open, inside the call that sends the spec.
    applied.push({ step, envId, secrets: openStackSecrets(await readStackSettings(envId)) })
    await log(`stack ${step.stack?.name}: applied (1 services changed)`)
    if (deployFails)
      throw Object.assign(new Error(`swarm rolled it back (REDIS_URL=${REDIS_SECRET})`), {
        code: deployFails
      })
    await db('nivaro_hub_environments')
      .where({ id: envId })
      .update({ version_pin: ctx.version, extension_pins: JSON.stringify(step.stack?.extensions) })
    return {
      specHash: 'f'.repeat(64),
      image: step.stack?.image ?? '',
      extensions: { ...(step.stack?.extensions ?? {}) }
    }
  },
  async verify(step, ctx) {
    verified.push({ envId: Number(ctx.envId), want: step.want })
    if (verifyFails)
      throw Object.assign(new Error('never answered version twice'), { code: verifyFails })
  }
}

function deps(over: Partial<CreationDeps> = {}): CreationDeps {
  const redis = fakeRedis()
  return {
    lock: redisPromoteLock(redis),
    repoLock: store.memoryKeyedLock(),
    startLock: store.memoryKeyedLock(),
    flags: store.redisCreationFlags(redis),
    link: {
      requestFirstAdmin: async (base, _token, person) => {
        adminCalls.push({ base, email: person.email })
        return { result: 'created' } as never
      }
    },
    checkName: async (host, _base, version) => ({
      resolves: true,
      serves: true,
      version,
      text: `${host} resolves and serves version ${version}.`
    }),
    status: async () =>
      ({
        state: 'ok',
        version: '0.3.215',
        preflight: 'ok',
        checked_at: new Date().toISOString(),
        source: 'hub-link'
      }) as never,
    startJobRun: async () => fakeRun(),
    sleep: async (ms) => {
      clock.t += ms
    },
    now: () => clock.t,
    gather: {
      env: ENV,
      imageDigest: async () => DIGEST,
      encryptionKey: () => true,
      timeoutMs: 500,
      agentHealth: async () => agentHealthNow,
      agentStack: async () => null
    },
    dest: {
      docker: dockerOps,
      place: async (envId, input, _by, o) => {
        placeCalls.push({ envId, input: input as never, token: o.token })
        o.log('3. every replica holds the new list (1)')
        if (placeFails) {
          const { PlaceSharedError } = await import('../../../services/hub/shared/place.js')
          throw new PlaceSharedError(placeFails, 'The shared deployment did not take it.')
        }
        await db('nivaro_hub_environments')
          .where({ id: envId })
          .update({ status: 'active', version_pin: '0.3.215' })
        return { already: false }
      }
    },
    ...over
  }
}

function dockerInput(over: Partial<CreateAppInput> = {}): CreateAppInput {
  return {
    key: 'demo',
    name: 'Demo',
    owners: [OWNER],
    first_admin: { email: 'ada@example.com' },
    target: {
      kind: 'docker',
      driver_id: driverId,
      stack: {
        size: 'small',
        redis: 'external',
        settings: { MAIL_FROM: 'demo@example.com' },
        secrets: { REDIS_URL: REDIS_SECRET },
        extension_pins: { 'efp-ops': PIN }
      }
    },
    version: '0.3.215',
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

async function startAndWait(i: CreateAppInput, d = deps()) {
  const out = await R.startCreation(i, USER, d)
  for (const e of out.environments) await R.awaitCreation(e.id)
  for (const e of out.environments) written.push(JSON.stringify(await R.readCreation(e.id)))
  return out
}

let prevKey: string | undefined
beforeAll(async () => {
  prevKey = process.env.ENCRYPTION_KEY
  process.env.ENCRYPTION_KEY = KEY
  for (const m of migrations) await m.up(db)
  if (!(await db.schema.hasTable('nivaro_users')))
    await db.schema.createTable('nivaro_users', (t) => t.uuid('id').primary())
  await db('nivaro_users').insert({ id: OWNER })
})

afterAll(async () => {
  const rows = [
    ...((await db('nivaro_hub_creations').select('*')) as unknown[]),
    ...((await db('nivaro_hub_deploys').select('*')) as unknown[]),
    ...((await db('nivaro_hub_apps').select('id', 'key', 'oidc', 'extensions')) as unknown[])
  ]
  const all = [...written, JSON.stringify(rows), JSON.stringify(activity)].join('\n')
  for (const v of fake.logins.values()) secretsSeen.add(v)
  for (const s of secretsSeen) {
    expect(all.includes(s), `secret leaked (${s.length} chars)`).toBe(false)
    expect(all.includes(Buffer.from(s).toString('base64'))).toBe(false)
  }
  if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = prevKey
  await db.destroy()
})

beforeEach(async () => {
  for (const t of [
    'nivaro_hub_creations',
    'nivaro_hub_deploys',
    'nivaro_hub_stack_settings',
    'nivaro_hub_databases',
    'nivaro_hub_db_servers',
    'nivaro_hub_components',
    'nivaro_hub_placements',
    'nivaro_hub_drivers',
    'nivaro_hub_shared_deployments',
    'nivaro_hub_environments',
    'nivaro_hub_app_owners',
    'nivaro_hub_apps'
  ])
    await db(t).del()
  fake.databases = new Set()
  fake.logins = new Map()
  applied = []
  deployFails = null
  verifyFails = null
  verified = []
  beforeApplyHook = null
  placeFails = null
  adminCalls = []
  placeCalls = []
  agentHealthNow = health()
  driverId = await insertId('nivaro_hub_drivers', {
    kind: 'docker',
    name: 'swarm-a',
    config: JSON.stringify({
      agent_url: 'https://agent.example.com',
      dns_mode: 'automatic',
      wildcard_domain: 'apps.example.com',
      edge_target: null
    }),
    secret: sealSecret(AGENT_TOKEN)
  })
  autoServer = await insertId('nivaro_hub_db_servers', {
    name: 'pg-auto',
    engine: 'pg',
    host: 'pg1.example.com',
    port: 5432,
    provision_mode: 'automatic',
    admin_secret: sealSecret(JSON.stringify(ADMIN))
  })
  sharedId = await insertId('nivaro_hub_shared_deployments', {
    key: 'pool-a',
    name: 'Pool A',
    mode: 'docker',
    driver_id: driverId,
    stack: 'pool-a',
    version_pin: '0.3.215',
    extensions: JSON.stringify(['efp-ops']),
    extension_pins: JSON.stringify({}),
    host_pattern: '*.shared.example.com',
    link_url: 'https://pool-a.example.com',
    pool_budget: 40,
    status: 'active',
    settings: JSON.stringify({})
  })
})

describe('create on a Docker driver', () => {
  it('walks database → stack → deploy → name → link → admin and leaves an ordinary stack env', async () => {
    const out = await startAndWait(dockerInput())
    expect(out.environments.map((e) => e.key)).toEqual(['staging', 'production'])
    for (const e of out.environments) {
      const c = await store.readCreationRow(e.id)
      expect(c?.status, c?.error ?? '').toBe('done')
      expect(c?.steps.map((s) => [s.key, s.status])).toEqual([
        ['database', 'done'],
        ['stack', 'done'],
        ['deploy', 'done'],
        ['name', 'done'],
        ['link', 'done'],
        ['admin', 'done'],
        // Hub enhancement 24: no template picked → done at once.
        ['template', 'done']
      ])
      const env = await db('nivaro_hub_environments').where({ id: e.id }).first()
      expect(env.status).toBe('active')
      expect(env.version_pin).toBe('0.3.215')
      expect(JSON.parse(env.extension_pins)).toEqual({ 'efp-ops': PIN })
      // An ordinary phase-4 environment: dedicated placement + one stack component.
      const placement = await db('nivaro_hub_placements').where({ id: env.placement_id }).first()
      expect(placement.kind).toBe('dedicated')
      expect(Number(placement.driver_id)).toBe(driverId)
      expect(JSON.parse(placement.target).stack).toBe(`demo--${e.key}`)
      const comps = await listComponents(Number(env.placement_id))
      expect(comps.map((x) => [x.kind, x.driver_id])).toEqual([['stack', driverId]])
      // Restart / Apply now know what runs.
      const ran = await deployedStack(e.id, `demo--${e.key}`)
      expect(ran).toMatchObject({
        state: 'ok',
        version: '0.3.215',
        image: `nodeworks/nivaro@${DIGEST}`
      })
      // The view: kind and the driver's name, the stack steps in order.
      const view = await R.readCreation(e.id)
      expect(view?.target).toEqual({ kind: 'docker', name: 'swarm-a' })
    }
    const app = await db('nivaro_hub_apps').where({ key: 'demo' }).first()
    expect(app.target_id).toBeNull()
    expect(JSON.parse(app.extensions)).toEqual(['efp-ops'])
    expect(adminCalls.map((a) => a.base)).toEqual([
      'https://demo--staging.apps.example.com',
      'https://demo.apps.example.com'
    ])
  })

  it('saves the stack settings: sign-in, the given secrets and generated keys, all sealed', async () => {
    const out = await startAndWait(dockerInput())
    const envId = out.environments[0].id
    const row = await readStackSettings(envId)
    expect(row?.redis).toBe('external')
    expect(row?.settings).toMatchObject({
      MAIL_FROM: 'demo@example.com',
      OIDC_ISSUER: 'https://login.microsoftonline.com/tenant/v2.0',
      OIDC_CLIENT_ID: 'client-123',
      OIDC_REDIRECT_URI: 'https://demo--staging.apps.example.com/api/auth/callback'
    })
    // Sealed in the column: nothing readable.
    expect(row?.secrets).not.toContain(REDIS_SECRET)
    const open = openStackSecrets(row)
    expect(open.REDIS_URL).toBe(REDIS_SECRET)
    expect(open.OIDC_CLIENT_SECRET).toBe(OIDC_SECRET)
    expect(open.SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/)
    expect(open.ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/)
    for (const v of [open.SESSION_SECRET, open.ENCRYPTION_KEY]) secretsSeen.add(v)
    // Each environment has its own keys; the deploy saw exactly them.
    const other = openStackSecrets(await readStackSettings(out.environments[1].id))
    secretsSeen.add(other.SESSION_SECRET)
    secretsSeen.add(other.ENCRYPTION_KEY)
    expect(other.ENCRYPTION_KEY).not.toBe(open.ENCRYPTION_KEY)
    expect(applied.find((a) => a.envId === envId)?.secrets.ENCRYPTION_KEY).toBe(open.ENCRYPTION_KEY)
    const env = await db('nivaro_hub_environments').where({ id: envId }).first('hub_token')
    secretsSeen.add(openSecret(env.hub_token) as string)
  })

  it('refuses at plan time what the agent does not allow, writing nothing', async () => {
    agentHealthNow = health({ images: ['nodeworks/nivaro'], host_suffixes: ['.other.com'] })
    await expect(R.startCreation(dockerInput(), USER, deps())).rejects.toMatchObject({
      status: 409,
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: 'EXTENSION_NOT_ALLOWED' }),
        expect.objectContaining({ code: 'HOSTNAME_NOT_ALLOWED' })
      ])
    })
    expect(await db('nivaro_hub_apps').count('id as n').first()).toMatchObject({ n: 0 })
    // A key outside the env allow-list (no agent prefix covers it).
    const bad = dockerInput()
    if (bad.target?.kind === 'docker') bad.target.stack = { settings: { ACME_FLAG: '1' } }
    await expect(R.startCreation(bad, USER, deps())).rejects.toMatchObject({
      code: 'SETTING_INVALID'
    })
  })

  it('a failed deploy fails the step; Retry deploys again and finishes', async () => {
    deployFails = 'SWARM_ROLLED_BACK'
    const out = await startAndWait(
      dockerInput({ environments: [{ key: 'staging', database: { server_id: autoServer } }] })
    )
    const envId = out.environments[0].id
    let c = await store.readCreationRow(envId)
    expect(c?.status).toBe('failed')
    expect(c?.error).toMatch(/^SWARM_ROLLED_BACK:/)
    expect(c?.steps.find((s) => s.key === 'deploy')?.status).toBe('failed')
    const failedRow = await db('nivaro_hub_deploys').where({ environment_id: envId }).first()
    expect(failedRow.status).toBe('failed')

    deployFails = null
    const d = deps()
    await R.resumeCreation(envId, USER, 'retry', d)
    await R.awaitCreation(envId)
    c = await store.readCreationRow(envId)
    expect(c?.status).toBe('done')
    // The stack step was not run again: one placement, one settings row, the same keys.
    expect(await db('nivaro_hub_placements').count('id as n').first()).toMatchObject({ n: 1 })
    expect(applied).toHaveLength(2)
    expect(applied[0].secrets.ENCRYPTION_KEY).toBe(applied[1].secrets.ENCRYPTION_KEY)
    for (const a of applied) {
      secretsSeen.add(a.secrets.ENCRYPTION_KEY)
      secretsSeen.add(a.secrets.SESSION_SECRET)
    }
  })

  it('cancel stops a queued creation before its stack exists', async () => {
    const d = deps()
    const out = await R.startCreation(
      dockerInput({ environments: [{ key: 'staging', database: { server_id: autoServer } }] }),
      USER,
      d
    )
    const envId = out.environments[0].id
    await R.cancelCreation(envId, USER, d)
    await R.awaitCreation(envId)
    const c = await store.readCreationRow(envId)
    expect(['cancelled', 'done']).toContain(c?.status)
    if (c?.status === 'cancelled') {
      const s = await readStackSettings(envId)
      if (s) for (const v of Object.values(openStackSecrets(s))) secretsSeen.add(v)
    } else {
      for (const v of Object.values(openStackSecrets(await readStackSettings(envId))))
        secretsSeen.add(v)
    }
  })
})

describe('create on a Docker driver: review fixes', () => {
  const oneEnv = () =>
    dockerInput({ environments: [{ key: 'staging', database: { server_id: autoServer } }] })

  it('M1: a cancel during the deploy stops it before the apply; Retry deploys once', async () => {
    const d = deps()
    beforeApplyHook = async (envId) => {
      beforeApplyHook = null
      await R.cancelCreation(envId, USER, d)
    }
    const out = await startAndWait(oneEnv(), d)
    const envId = out.environments[0].id
    let c = await store.readCreationRow(envId)
    expect(c?.status).toBe('cancelled')
    expect(c?.steps.find((s) => s.key === 'deploy')?.status).toBe('pending')
    expect(applied).toHaveLength(0)
    const rows = await db('nivaro_hub_deploys').where({ environment_id: envId })
    expect(rows.map((r) => r.status)).toEqual(['cancelled'])

    await R.resumeCreation(envId, USER, 'retry', d)
    await R.awaitCreation(envId)
    c = await store.readCreationRow(envId)
    expect(c?.status).toBe('done')
    expect(applied).toHaveLength(1)
    const after = await db('nivaro_hub_deploys').where({ environment_id: envId }).orderBy('id')
    expect(after.map((r) => r.status)).toEqual(['cancelled', 'success'])
    for (const a of applied) for (const v of Object.values(a.secrets)) secretsSeen.add(v)
  })

  it('L1: the deploy row is success only after verify; a failed verify fails it', async () => {
    verifyFails = 'VERIFY_FAILED'
    const out = await startAndWait(oneEnv())
    const envId = out.environments[0].id
    expect(verified).toEqual([{ envId, want: '0.3.215' }])
    const c = await store.readCreationRow(envId)
    expect(c?.status).toBe('failed')
    expect(c?.error).toMatch(/^VERIFY_FAILED:/)
    const row = await db('nivaro_hub_deploys').where({ environment_id: envId }).first()
    expect(row.status).toBe('failed')
    for (const a of applied) for (const v of Object.values(a.secrets)) secretsSeen.add(v)
  })

  it('L2: a deploy error never stores a stack secret (the row and the creation are scrubbed)', async () => {
    deployFails = 'SWARM_ROLLED_BACK'
    const out = await startAndWait(oneEnv())
    const envId = out.environments[0].id
    const row = await db('nivaro_hub_deploys').where({ environment_id: envId }).first()
    expect(row.error).toMatch(/^SWARM_ROLLED_BACK:/)
    expect(row.error).not.toContain(REDIS_SECRET)
    expect((await store.readCreationRow(envId))?.error).not.toContain(REDIS_SECRET)
    for (const a of applied) for (const v of Object.values(a.secrets)) secretsSeen.add(v)
  })

  it('L4: promotions and Apply now refuse an environment whose creation is open', async () => {
    const out = await startAndWait(oneEnv())
    const envId = out.environments[0].id
    for (const a of applied) for (const v of Object.values(a.secrets)) secretsSeen.add(v)
    await db('nivaro_hub_creations')
      .where({ environment_id: envId })
      .update({ status: 'waiting', waiting_for: 'name' })
    expect(await store.creationOpenRefusal(envId)).toMatchObject({ code: 'CREATION_OPEN' })
    const { startPromotion, startStackApply } = await import('../../../services/hub/promote-run.js')
    const never = () => {
      throw new Error('must not be reached')
    }
    const startDeps = { gather: never, lock: never, startJobRun: never, gitCtx: never } as never
    await expect(
      startPromotion(
        envId,
        {
          kind: 'promote',
          version: '0.3.215',
          confirm: 'staging',
          planHash: 'a'.repeat(64),
          user: USER
        },
        startDeps
      )
    ).rejects.toMatchObject({ code: 'CREATION_OPEN', status: 409 })
    await expect(
      startStackApply(envId, { confirm: 'staging', user: USER }, startDeps)
    ).rejects.toMatchObject({ code: 'CREATION_OPEN' })
    await db('nivaro_hub_creations').where({ environment_id: envId }).update({ status: 'done' })
    expect(await store.creationOpenRefusal(envId)).toBeNull()
  })
})

describe('create on a shared deployment', () => {
  const sharedInput = (): CreateAppInput => ({
    key: 'demo',
    name: 'Demo',
    owners: [OWNER],
    first_admin: { email: 'ada@example.com' },
    target: { kind: 'shared', shared_id: sharedId, pool_max: 4 },
    version: '',
    extensions: ['efp-ops'],
    environments: [{ key: 'production', database: { server_id: autoServer } }]
  })

  it('makes the database, then places the environment under the leg lock', async () => {
    const out = await startAndWait(sharedInput())
    const envId = out.environments[0].id
    const c = await store.readCreationRow(envId)
    expect(c?.status, c?.error ?? '').toBe('done')
    expect(c?.steps.map((s) => [s.key, s.status])).toEqual([
      ['database', 'done'],
      ['place', 'done']
    ])
    expect(placeCalls).toHaveLength(1)
    const dbRow = await db('nivaro_hub_databases').first('id')
    expect(placeCalls[0].input).toEqual({
      shared_id: sharedId,
      database_id: Number(dbRow.id),
      pool_max: 4,
      first_admin: { email: 'ada@example.com' }
    })
    expect(placeCalls[0].token).toBeTruthy()
    const env = await db('nivaro_hub_environments').where({ id: envId }).first()
    // No token at creation: the placement issues one when the app serves (faked here).
    expect(env.hub_token).toBeNull()
    expect(env.base_url).toBe('https://demo.shared.example.com')
    expect(env.status).toBe('active')
    const app = await db('nivaro_hub_apps').where({ key: 'demo' }).first()
    expect(app.oidc).toBeNull()
    expect(JSON.parse(app.extensions)).toEqual(['efp-ops'])
    expect((await R.readCreation(envId))?.target).toEqual({ kind: 'shared', name: 'Pool A' })
    expect(c?.version).toBe('0.3.215')
  })

  it('a refused placement fails the step with its code; Retry places again', async () => {
    placeFails = 'REPLICAS_BEHIND'
    const out = await startAndWait(sharedInput())
    const envId = out.environments[0].id
    let c = await store.readCreationRow(envId)
    expect(c?.status).toBe('failed')
    expect(c?.error).toMatch(/^REPLICAS_BEHIND:/)
    placeFails = null
    const d = deps()
    await R.resumeCreation(envId, USER, 'retry', d)
    await R.awaitCreation(envId)
    c = await store.readCreationRow(envId)
    expect(c?.status).toBe('done')
    expect(placeCalls).toHaveLength(2)
  })
})
