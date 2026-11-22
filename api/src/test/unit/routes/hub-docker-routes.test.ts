import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 4, Task 10: the Hub's Docker routes (agent check, stack read, settings,
// restart, remove, check name) and the environment-delete guard. Real SQLite for apps,
// environments, placements, drivers, deploys and stack settings; the agent client and the name
// look are mocked (their own tests cover them).

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
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))

const m = vi.hoisted(() => ({
  health: vi.fn(),
  stack: vi.fn(),
  restart: vi.fn(),
  remove: vi.fn(),
  look: vi.fn(),
  maint: vi.fn()
}))
vi.mock('../../../services/hub/docker/agent-client.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/hub/docker/agent-client.js')>()),
  agentHealth: m.health,
  agentStack: m.stack,
  agentRestart: m.restart,
  agentRemove: m.remove,
  agentApply: vi.fn(async () => {
    throw new Error('no apply from a route')
  })
}))
vi.mock('../../../services/hub/docker/name-check.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/hub/docker/name-check.js')>()),
  lookName: m.look
}))
vi.mock('../../../services/security.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/security.js')>()),
  maintenanceState: m.maint
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const m542 = await import('../../../db/migrations/542_hub_tables.js')
const m543 = await import('../../../db/migrations/543_hub_promotions.js')
const m546 = await import('../../../db/migrations/546_hub_stack_settings.js')
const { hubRoutes } = await import('../../../routes/hub.js')
const { logActivity } = await import('../../../services/activity.js')
const { maintenanceFreezeHook } = await import('../../../services/maintenance-freeze.js')
const { AgentError } = await import('../../../services/hub/docker/agent-client.js')
const S = await import('../../../services/hub/docker/stack-settings.js')
const { openSecret, sealSecret, HUB_MASK } = await import('../../../services/hub/secrets.js')
const { environmentFromRow } = await import('../../../services/hub/apps.js')
const { memoryPromoteLock } = await import('../../../services/hub/promote-lock.js')
const { dockerEnvironmentDeleteRefusal } = await import(
  '../../../services/hub/docker/stack-guards.js'
)

type AgentHealth = import('../../../services/hub/docker/agent-types.js').AgentHealth
type StackStatus = import('../../../services/hub/docker/agent-types.js').StackStatus
type StackSpec = import('../../../services/hub/docker/agent-types.js').StackSpec
type Env = import('../../../services/hub/promote-types.js').HubEnvironmentRow

const KEY = 'e'.repeat(64)
const OWNER = 'BBBBBBBB-0000-4000-8000-000000000002'
const OTHER = 'CCCCCCCC-0000-4000-8000-000000000003'
const asAdmin = { 'x-user': 'AAAAAAAA-0000-4000-8000-000000000001', 'x-admin': '1' }
const asOwner = { 'x-user': OWNER }
const asOther = { 'x-user': OTHER }

const AGENT_TOKEN = 'agent-Token-Value-0123456789-abcdefghij'
const GITLAB_TOKEN = 'glpat-Gitlab-Token-Value-0123456789'
const DB_PASS = 'pw-Plain-Value-123'
const SMTP_PASS = 'smtp-Plain-Value-456'
const HASH = 'f'.repeat(64)
const IMAGE = `nodeworks/nivaro@sha256:${'a'.repeat(64)}`
const DEPLOYED_IMAGE = `nodeworks/nivaro@sha256:${'b'.repeat(64)}`
const PIN = `nodeworks/efp-ops@sha256:${'2'.repeat(64)}`
const BASE = 'https://acme.apps.example.com'
const ORIGIN = 'https://agent.example.com'
const PG = { DB_CLIENT: 'pg', DB_HOST: 'db.internal', DB_DATABASE: 'acme_db', DB_USER: 'acme' }
const STACK = 'acme-prod'

const automatic = {
  agent_url: ORIGIN,
  dns_mode: 'automatic' as const,
  wildcard_domain: 'apps.example.com',
  edge_target: null
}
const manual = {
  agent_url: ORIGIN,
  dns_mode: 'manual' as const,
  wildcard_domain: null,
  edge_target: 'edge.example.com'
}

// env 2 = docker (placement 5 → driver 3); env 4 = GitLab (placement 6 → driver 7).
const DOCKER = 2
const GITLAB = 4

function health(over: Partial<AgentHealth> = {}): AgentHealth {
  return {
    api: 1,
    agent_version: '0.1.0',
    engine_api: '1.44',
    swarm: { manager: true, node_id: 'n1' },
    images: ['nodeworks/nivaro', 'nodeworks/efp-ops'],
    host_suffixes: ['apps.example.com'],
    edge: 'traefik',
    publish_ports: null,
    extensions_shared: false,
    redis_bundled: true,
    ...over
  }
}

function stackStatus(): StackStatus {
  return {
    name: STACK,
    owner: { app: 'acme' },
    environment: 'production',
    spec_hash: HASH,
    image: DEPLOYED_IMAGE,
    state: 'converged',
    published_port: null,
    services: [
      {
        name: `${STACK}_web`,
        role: 'web',
        image: DEPLOYED_IMAGE,
        replicas: { desired: 2, running: 2 },
        update: 'completed',
        message: null
      }
    ]
  }
}

let app: FastifyInstance
let prevHub: string | undefined
let prevKey: string | undefined

beforeAll(async () => {
  prevHub = process.env.HUB
  prevKey = process.env.ENCRYPTION_KEY
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = KEY
  await m542.up(db)
  await m543.up(db)
  await m546.up(db)
  await db.schema.createTable('nivaro_users', (t) => {
    t.string('id').primary()
    t.string('first_name')
    t.string('last_name')
    t.string('email')
  })
  app = Fastify()
  app.addHook('preHandler', maintenanceFreezeHook)
  await app.register(hubRoutes, { prefix: '/api/hub' })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await db.destroy()
  if (prevHub === undefined) delete process.env.HUB
  else process.env.HUB = prevHub
  if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = prevKey
})

async function useDriver(config: typeof automatic | typeof manual) {
  await db('nivaro_hub_drivers')
    .where({ id: 3 })
    .update({ config: JSON.stringify(config) })
}

beforeEach(async () => {
  vi.resetAllMocks()
  process.env.ENCRYPTION_KEY = KEY
  for (const t of [
    'nivaro_hub_apps',
    'nivaro_hub_app_owners',
    'nivaro_hub_environments',
    'nivaro_hub_placements',
    'nivaro_hub_drivers',
    'nivaro_hub_components',
    'nivaro_hub_deploys',
    'nivaro_hub_stack_settings'
  ])
    await db(t).del()
  await db('nivaro_hub_apps').insert({
    id: 1,
    key: 'acme',
    name: 'Acme',
    extensions: JSON.stringify(['efp-ops'])
  })
  await db('nivaro_hub_app_owners').insert({ app_id: 1, user_id: OWNER })
  await db('nivaro_hub_drivers').insert([
    {
      id: 3,
      kind: 'docker',
      name: 'swarm',
      config: JSON.stringify(automatic),
      secret: sealSecret(AGENT_TOKEN)
    },
    {
      id: 7,
      kind: 'gitlab',
      name: 'gitlab',
      config: JSON.stringify({
        api: 'https://gitlab.example.com/api/v4',
        project: 'ops/deploy',
        branch: 'main',
        pin_file: 'pins/{env}.txt',
        deploy_job: 'deploy'
      }),
      secret: sealSecret(GITLAB_TOKEN)
    }
  ])
  await db('nivaro_hub_placements').insert([
    { id: 5, kind: 'dedicated', driver_id: 3, target: JSON.stringify({ stack: STACK }) },
    { id: 6, kind: 'dedicated', driver_id: 7, target: JSON.stringify({ branch: 'acme-stg' }) }
  ])
  await db('nivaro_hub_environments').insert([
    {
      id: DOCKER,
      app_id: 1,
      key: 'production',
      position: 2,
      base_url: BASE,
      placement_id: 5,
      status: 'active',
      hub_managed: true,
      version_pin: '0.3.9',
      extension_pins: JSON.stringify({ 'efp-ops': PIN })
    },
    {
      id: GITLAB,
      app_id: 1,
      key: 'staging',
      position: 1,
      base_url: 'https://acme-stg.example.com',
      placement_id: 6,
      status: 'active',
      hub_managed: false
    }
  ])
  const env = environmentFromRow(
    await db('nivaro_hub_environments').where({ id: DOCKER }).first()
  ) as Env
  const v = await S.validateStackSettings(
    {
      size: 'medium',
      settings: { ...PG, MAIL_FROM: 'ops@acme.example' },
      secrets: { DB_PASSWORD: DB_PASS, SMTP_PASS }
    },
    null,
    { driver: automatic, env }
  )
  if (!v.ok) throw new Error(`${v.code}: ${v.message}`)
  await S.saveStackSettings(DOCKER, v.row.fields, v.row.extension_pins)
  // The deploy that put the stack where it is: its stored plan records what swarm runs.
  await db('nivaro_hub_deploys').insert({
    app_id: 1,
    environment_id: DOCKER,
    kind: 'promote',
    version: '0.3.9',
    status: 'success',
    plan: JSON.stringify({
      ok: true,
      steps: [
        {
          position: 1,
          component: 'stack',
          kind: 'stack',
          driver: 'docker',
          driverId: 3,
          stack: { name: STACK, image: IMAGE, size: 'medium', extensions: { 'efp-ops': PIN } },
          deployedImage: DEPLOYED_IMAGE,
          deployedSpecHash: HASH
        }
      ]
    })
  })
  m.maint.mockResolvedValue({ on: false })
  m.health.mockResolvedValue(health())
  m.stack.mockResolvedValue(stackStatus())
  m.restart.mockResolvedValue({ services: [`${STACK}_web`, `${STACK}_worker`] })
  m.remove.mockResolvedValue({
    removed: { services: [`${STACK}_web`], secrets: [], networks: [], volumes: [] }
  })
  m.look.mockResolvedValue('serving')
})

const url = (p: string) => `/api/hub${p}`
const call = (
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  p: string,
  headers: Record<string, string>,
  payload?: unknown
) => app.inject({ method, url: url(p), headers, payload: payload as never })

/** Every plaintext secret of the fixture: stack secrets (generated too), hub and agent token. */
async function secretValues(): Promise<string[]> {
  const opened = S.openStackSecrets(await S.readStackSettings(DOCKER))
  const hub = openSecret(
    (await db('nivaro_hub_environments').where({ id: DOCKER }).first()).hub_token
  )
  const all = [...Object.values(opened), DB_PASS, SMTP_PASS, AGENT_TOKEN, GITLAB_TOKEN, String(hub)]
  expect(all.length).toBeGreaterThanOrEqual(7)
  return all
}

async function expectNoSecret(text: string) {
  for (const s of await secretValues()) expect(text).not.toContain(s)
}

/** What the routes asked activity to store (the request object is not stored — only ip/agent). */
const activityCalls = () =>
  vi.mocked(logActivity).mock.calls.map((c) => {
    const { req: _req, ...rest } = c[0] as Record<string, unknown>
    return rest
  })

const ENV_ROUTES = (envId: number) =>
  [
    ['GET', `/environments/${envId}/stack`],
    ['GET', `/environments/${envId}/stack/settings`],
    ['PUT', `/environments/${envId}/stack/settings`],
    ['POST', `/environments/${envId}/stack/restart`],
    ['POST', `/environments/${envId}/stack/remove`],
    ['POST', `/environments/${envId}/stack/check-name`]
  ] as const

describe('access', () => {
  it('a non-owner gets 404 on every environment route and no agent call is made', async () => {
    for (const [method, p] of ENV_ROUTES(DOCKER)) {
      const res = await call(method, p, asOther, { confirm: 'production' })
      expect([method, p, res.statusCode]).toEqual([method, p, 404])
    }
    for (const [method, p] of ENV_ROUTES(99999))
      expect((await call(method, p, asAdmin, {})).statusCode).toBe(404)
    for (const f of [m.health, m.stack, m.restart, m.remove, m.look])
      expect(f).not.toHaveBeenCalled()
  }, 20000)

  it('an owner gets 403 on settings GET/PUT, remove and the agent check', async () => {
    const refused = [
      ['GET', `/environments/${DOCKER}/stack/settings`],
      ['PUT', `/environments/${DOCKER}/stack/settings`],
      ['POST', `/environments/${DOCKER}/stack/remove`],
      ['GET', '/drivers/3/agent']
    ] as const
    for (const [method, p] of refused) {
      const res = await call(method, p, asOwner, { confirm: STACK, size: 'small' })
      expect([method, p, res.statusCode]).toEqual([method, p, 403])
    }
    // Anyone who is not a Hub admin: the driver check has no app to own.
    expect((await call('GET', '/drivers/3/agent', asOther)).statusCode).toBe(403)
    expect(m.remove).not.toHaveBeenCalled()
    expect(m.health).not.toHaveBeenCalled()
    expect(await S.readStackSettings(DOCKER)).toMatchObject({ size: 'medium' })
  })

  it('an owner may read the stack, restart it and check its name', async () => {
    expect((await call('GET', `/environments/${DOCKER}/stack`, asOwner)).statusCode).toBe(200)
    const r = await call('POST', `/environments/${DOCKER}/stack/restart`, asOwner, {
      confirm: 'production'
    })
    expect(r.statusCode).toBe(202)
    const c = await call('POST', `/environments/${DOCKER}/stack/check-name`, asOwner)
    expect(c.statusCode).toBe(200)
  })

  it('a non-docker environment answers 409 NOT_DOCKER on every /stack route', async () => {
    for (const [method, p] of ENV_ROUTES(GITLAB)) {
      const res = await call(method, p, asAdmin, { confirm: 'staging' })
      expect([method, p, res.statusCode, res.json().code]).toEqual([method, p, 409, 'NOT_DOCKER'])
    }
    // An environment with no placement is not a docker one either.
    await db('nivaro_hub_environments').where({ id: GITLAB }).update({ placement_id: null })
    const res = await call('GET', `/environments/${GITLAB}/stack`, asAdmin)
    expect(res.json().code).toBe('NOT_DOCKER')
    for (const f of [m.health, m.stack, m.restart, m.remove]) expect(f).not.toHaveBeenCalled()
  })

  it('the maintenance freeze refuses PUT and POST before the route runs', async () => {
    m.maint.mockResolvedValue({ on: true, message: 'down', until: null })
    const writes = [
      ['PUT', `/environments/${DOCKER}/stack/settings`, { size: 'small' }],
      ['POST', `/environments/${DOCKER}/stack/restart`, { confirm: 'production' }],
      ['POST', `/environments/${DOCKER}/stack/remove`, { confirm: STACK }],
      ['POST', `/environments/${DOCKER}/stack/check-name`, {}]
    ] as const
    for (const [method, p, b] of writes) {
      const res = await call(method, p, asAdmin, b)
      expect([p, res.statusCode, res.json().code]).toEqual([p, 503, 'MAINTENANCE'])
    }
    expect(m.restart).not.toHaveBeenCalled()
    expect(m.remove).not.toHaveBeenCalled()
    expect(await S.readStackSettings(DOCKER)).toMatchObject({ size: 'medium' })
  })
})

describe('GET /drivers/:id/agent', () => {
  it('answers the agent health', async () => {
    const res = await call('GET', '/drivers/3/agent', asAdmin)
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual(health())
    expect(m.health.mock.calls[0][0]).toMatchObject({ id: 3, kind: 'docker' })
  })

  it('refused token → 409 AGENT_REFUSED, unreachable → 502; no token in the answer', async () => {
    m.health.mockRejectedValueOnce(
      new AgentError('AGENT_REFUSED', 401, `the Hub agent at ${ORIGIN} refused the Hub's token`)
    )
    const a = await call('GET', '/drivers/3/agent', asAdmin)
    expect([a.statusCode, a.json().code]).toEqual([409, 'AGENT_REFUSED'])
    m.health.mockRejectedValueOnce(
      new AgentError('AGENT_UNREACHABLE', 0, `the Hub agent at ${ORIGIN} could not be reached`)
    )
    const b = await call('GET', '/drivers/3/agent', asAdmin)
    expect([b.statusCode, b.json().code]).toEqual([502, 'AGENT_UNREACHABLE'])
    await expectNoSecret(a.body + b.body)
  })

  it('a GitLab driver → 409 NOT_DOCKER; no driver → 404', async () => {
    const g = await call('GET', '/drivers/7/agent', asAdmin)
    expect([g.statusCode, g.json().code]).toEqual([409, 'NOT_DOCKER'])
    expect((await call('GET', '/drivers/999/agent', asAdmin)).statusCode).toBe(404)
    expect(m.health).not.toHaveBeenCalled()
  })
})

describe('GET /environments/:envId/stack', () => {
  it('answers the stack name, dns mode and status asked with the deployed spec hash', async () => {
    const res = await call('GET', `/environments/${DOCKER}/stack`, asOwner)
    expect(res.json().data).toEqual({
      stack_name: STACK,
      dns_mode: 'automatic',
      name_request: null,
      status: stackStatus(),
      agent: 'ok'
    })
    expect(m.stack.mock.calls[0].slice(1)).toEqual([STACK, HASH])
    await expectNoSecret(res.body)
  })

  it('manual DNS: the name request copy; an agent error: its code and no status', async () => {
    await useDriver(manual)
    m.stack.mockRejectedValueOnce(new AgentError('AGENT_UNREACHABLE', 0, 'could not be reached'))
    const res = await call('GET', `/environments/${DOCKER}/stack`, asAdmin)
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.status).toBeNull()
    expect(d.agent).toBe('AGENT_UNREACHABLE')
    expect(d.dns_mode).toBe('manual')
    expect(d.name_request).toEqual([
      'Ask for DNS name acme.apps.example.com pointing at edge.example.com',
      'and a TLS certificate for acme.apps.example.com'
    ])
  })

  it('no stack on the swarm yet: status null, agent ok', async () => {
    m.stack.mockResolvedValueOnce(null)
    const d = (await call('GET', `/environments/${DOCKER}/stack`, asAdmin)).json().data
    expect([d.status, d.agent]).toEqual([null, 'ok'])
  })
})

describe('stack settings', () => {
  it('GET masks every secret: no plaintext value anywhere in the body', async () => {
    const res = await call('GET', `/environments/${DOCKER}/stack/settings`, asAdmin)
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.size).toBe('medium')
    expect(d.settings).toEqual({ ...PG, MAIL_FROM: 'ops@acme.example' })
    expect(d.secrets).toEqual({
      DB_PASSWORD: HUB_MASK,
      ENCRYPTION_KEY: HUB_MASK,
      SESSION_SECRET: HUB_MASK,
      SMTP_PASS: HUB_MASK
    })
    expect(d.extension_pins).toEqual({ 'efp-ops': PIN })
    expect(res.body).not.toContain('hub_token')
    await expectNoSecret(res.body)
  })

  it('GET before the first save answers the defaults, nothing saved', async () => {
    await db('nivaro_hub_stack_settings').del()
    const d = (await call('GET', `/environments/${DOCKER}/stack/settings`, asAdmin)).json().data
    expect(d).toMatchObject({ saved: false, size: 'small', redis: 'bundled', secrets: {} })
  })

  it('PUT saves; the mask keeps a stored secret; activity names keys, never values', async () => {
    const before = S.openStackSecrets(await S.readStackSettings(DOCKER))
    const res = await call('PUT', `/environments/${DOCKER}/stack/settings`, asAdmin, {
      size: 'large',
      settings: { ...PG, MAIL_FROM: 'new@acme.example', APP_NAME: 'Acme' },
      secrets: {
        DB_PASSWORD: HUB_MASK,
        SESSION_SECRET: HUB_MASK,
        ENCRYPTION_KEY: HUB_MASK,
        SMTP_PASS: 'smtp-Changed-Value-789'
      },
      extension_pins: { 'efp-ops': PIN }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.size).toBe('large')
    const after = S.openStackSecrets(await S.readStackSettings(DOCKER))
    expect(after.DB_PASSWORD).toBe(DB_PASS)
    expect(after.SESSION_SECRET).toBe(before.SESSION_SECRET)
    expect(after.ENCRYPTION_KEY).toBe(before.ENCRYPTION_KEY)
    expect(after.SMTP_PASS).toBe('smtp-Changed-Value-789')
    const act = activityCalls()
    expect(act).toHaveLength(1)
    expect(act[0]).toMatchObject({
      action: 'update',
      collection: 'nivaro_hub_stack_settings',
      item: String(DOCKER)
    })
    expect([...(act[0].changed_fields as string[])].sort()).toEqual(
      ['size', 'settings.MAIL_FROM', 'settings.APP_NAME', 'secrets.SMTP_PASS'].sort()
    )
    const logged = JSON.stringify(act)
    expect(logged).not.toContain('new@acme.example')
    expect(logged).not.toContain('smtp-Changed-Value-789')
    await expectNoSecret(res.body + logged)
  })

  it('PUT with only masks writes nothing secret-side and logs no secret key', async () => {
    const sealedBefore = (await S.readStackSettings(DOCKER))?.secrets
    const res = await call('PUT', `/environments/${DOCKER}/stack/settings`, asAdmin, {
      secrets: { DB_PASSWORD: HUB_MASK, SMTP_PASS: HUB_MASK }
    })
    expect(res.statusCode).toBe(200)
    const after = S.openStackSecrets(await S.readStackSettings(DOCKER))
    expect([after.DB_PASSWORD, after.SMTP_PASS]).toEqual([DB_PASS, SMTP_PASS])
    expect(typeof sealedBefore).toBe('string')
    expect(activityCalls()[0].changed_fields).toEqual([])
  })

  it('a first save logs the generated secrets by name only', async () => {
    await db('nivaro_hub_stack_settings').del()
    const res = await call('PUT', `/environments/${DOCKER}/stack/settings`, asAdmin, {
      settings: PG,
      secrets: { DB_PASSWORD: DB_PASS }
    })
    expect(res.statusCode).toBe(200)
    expect([...(activityCalls()[0].changed_fields as string[])].sort()).toEqual(
      [
        'secrets.DB_PASSWORD',
        'secrets.ENCRYPTION_KEY',
        'secrets.SESSION_SECRET',
        'settings.DB_CLIENT',
        'settings.DB_DATABASE',
        'settings.DB_HOST',
        'settings.DB_USER'
      ].sort()
    )
    await expectNoSecret(res.body + JSON.stringify(activityCalls()))
  })

  it('refuses keys the agent forbids, binary paths included, as settings and as secrets', async () => {
    const keys = [
      'FFMPEG_PATH',
      'FFPROBE_PATH',
      'PUPPETEER_EXECUTABLE_PATH',
      'SAMBA_SERVER_PATH',
      'FFMPEG_PATH_FILE',
      'FFREPORT',
      'CHROMIUM_FLAGS',
      'CHROMIUM_USER_FLAGS',
      'PUPPETEER_CACHE_DIR',
      'HELP_VIDEO_WHISPER_CMD',
      'HELP_VIDEO_WHISPER_MODEL',
      'MAIL_FROM_FILE',
      'DB_HOST_FILE',
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'PATH'
    ]
    for (const k of keys) {
      for (const field of ['settings', 'secrets']) {
        const res = await call('PUT', `/environments/${DOCKER}/stack/settings`, asAdmin, {
          [field]: { ...(field === 'settings' ? PG : {}), [k]: '/tmp/evil' }
        })
        expect([k, field, res.statusCode, res.json().code]).toEqual([
          k,
          field,
          400,
          'RESERVED_SETTING'
        ])
        expect(res.body).not.toContain('/tmp/evil')
      }
    }
    expect(activityCalls()).toHaveLength(0)
    expect(await S.readStackSettings(DOCKER)).toMatchObject({ size: 'medium' })
  })

  it('a refused secret never echoes its value', async () => {
    const res = await call('PUT', `/environments/${DOCKER}/stack/settings`, asAdmin, {
      settings: { ...PG, DB_PASSWORD: 'in-Plain-Settings-999' }
    })
    expect([res.statusCode, res.json().code]).toEqual([400, 'SECRET_IN_SETTINGS'])
    expect(res.body).not.toContain('in-Plain-Settings-999')
  })
})

describe('POST /environments/:envId/stack/restart', () => {
  it('renders the spec from version_pin, extension_pins and the deployed image; 202', async () => {
    const res = await call('POST', `/environments/${DOCKER}/stack/restart`, asOwner, {
      confirm: 'production'
    })
    expect(res.statusCode).toBe(202)
    expect(res.json().data).toEqual({ services: [`${STACK}_web`, `${STACK}_worker`] })
    expect(m.restart).toHaveBeenCalledTimes(1)
    const [driver, name, spec] = m.restart.mock.calls[0] as [{ id: number }, string, StackSpec]
    expect([driver.id, name]).toEqual([3, STACK])
    expect(spec.image).toBe(DEPLOYED_IMAGE)
    expect(spec.extensions).toEqual({ 'efp-ops': PIN })
    expect(spec.env.DB_HOST).toBe('db.internal')
    expect(spec.secrets.DB_PASSWORD).toBe(DB_PASS)
    const act = activityCalls()
    expect(act).toHaveLength(1)
    expect(act[0]).toMatchObject({
      action: 'hub-stack-restart',
      collection: 'nivaro_hub_environments',
      item: String(DOCKER)
    })
    await expectNoSecret(res.body + JSON.stringify(act))
  })

  it('wrong or missing confirm → 400 CONFIRM_REQUIRED, nothing sent', async () => {
    for (const confirm of [undefined, 'staging', STACK, 'Production']) {
      const res = await call('POST', `/environments/${DOCKER}/stack/restart`, asAdmin, {
        confirm
      })
      expect([res.statusCode, res.json().code]).toEqual([400, 'CONFIRM_REQUIRED'])
    }
    expect(m.restart).not.toHaveBeenCalled()
  })

  it('refused while a promotion of the environment runs (409 PROMOTION_RUNNING)', async () => {
    const token = await memoryPromoteLock.take(DOCKER)
    try {
      const res = await call('POST', `/environments/${DOCKER}/stack/restart`, asAdmin, {
        confirm: 'production'
      })
      expect([res.statusCode, res.json().code]).toEqual([409, 'PROMOTION_RUNNING'])
    } finally {
      if (token) await memoryPromoteLock.release(DOCKER, token)
    }
    expect(m.restart).not.toHaveBeenCalled()
    // The route lets go of the lock it took: a promotion can start after a restart.
    await call('POST', `/environments/${DOCKER}/stack/restart`, asAdmin, { confirm: 'production' })
    const again = await memoryPromoteLock.take(DOCKER)
    expect(again).not.toBeNull()
    if (again) await memoryPromoteLock.release(DOCKER, again)
  })

  it('nothing deployed yet → 409 NOT_DEPLOYED; no agent call', async () => {
    await db('nivaro_hub_deploys').del()
    const res = await call('POST', `/environments/${DOCKER}/stack/restart`, asAdmin, {
      confirm: 'production'
    })
    expect([res.statusCode, res.json().code]).toEqual([409, 'NOT_DEPLOYED'])
    expect(m.restart).not.toHaveBeenCalled()
  })

  it('the agent limits no longer fit → the neutral refusal, no restart', async () => {
    m.health.mockResolvedValue(health({ images: ['nodeworks/efp-ops'] }))
    const res = await call('POST', `/environments/${DOCKER}/stack/restart`, asAdmin, {
      confirm: 'production'
    })
    expect([res.statusCode, res.json().code]).toEqual([409, 'IMAGE_NOT_ALLOWED'])
    expect(res.json().error).toContain("The agent's limits no longer allow this stack")
    expect(m.restart).not.toHaveBeenCalled()
  })

  it('an agent refusal answers its code and field names only, never a token', async () => {
    m.restart.mockRejectedValueOnce(
      new AgentError('SPEC_MISMATCH', 409, `the Hub agent at ${ORIGIN} refused restart`)
    )
    const a = await call('POST', `/environments/${DOCKER}/stack/restart`, asAdmin, {
      confirm: 'production'
    })
    expect([a.statusCode, a.json().code]).toEqual([409, 'SPEC_MISMATCH'])
    expect(a.json().error).toBe(
      `${STACK} does not run the spec the Hub sent — deploy it instead of restarting`
    )
    m.restart.mockRejectedValueOnce(
      new AgentError('SPEC_INVALID', 400, 'refused', [{ field: 'env.X', code: 'ENV_FORBIDDEN' }])
    )
    const b = await call('POST', `/environments/${DOCKER}/stack/restart`, asAdmin, {
      confirm: 'production'
    })
    expect([b.statusCode, b.json().code]).toEqual([409, 'SPEC_INVALID'])
    expect(b.json().fields).toEqual([{ field: 'env.X', code: 'ENV_FORBIDDEN' }])
    m.restart.mockRejectedValueOnce(new AgentError('AGENT_UNREACHABLE', 0, 'could not be reached'))
    const c = await call('POST', `/environments/${DOCKER}/stack/restart`, asAdmin, {
      confirm: 'production'
    })
    expect([c.statusCode, c.json().code]).toEqual([502, 'AGENT_UNREACHABLE'])
    expect(activityCalls()).toHaveLength(0)
    await expectNoSecret(a.body + b.body + c.body)
  })
})

describe('POST /environments/:envId/stack/remove', () => {
  it('confirm = stack name removes the stack; status suspended; activity volumes false', async () => {
    const res = await call('POST', `/environments/${DOCKER}/stack/remove`, asAdmin, {
      confirm: STACK
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.removed.services).toEqual([`${STACK}_web`])
    expect(m.remove.mock.calls[0].slice(1)).toEqual([STACK, { removeVolumes: false }])
    expect((await db('nivaro_hub_environments').where({ id: DOCKER }).first()).status).toBe(
      'suspended'
    )
    const act = activityCalls()
    expect(act).toHaveLength(1)
    expect(act[0]).toMatchObject({ action: 'hub-stack-remove', item: String(DOCKER) })
    expect(JSON.parse(String(act[0].comment))).toEqual({ stack: STACK, volumes: false })
  })

  it('wrong confirm → 400 CONFIRM_REQUIRED', async () => {
    for (const confirm of [undefined, 'production', 'acme-pro']) {
      const res = await call('POST', `/environments/${DOCKER}/stack/remove`, asAdmin, { confirm })
      expect([res.statusCode, res.json().code]).toEqual([400, 'CONFIRM_REQUIRED'])
    }
    expect(m.remove).not.toHaveBeenCalled()
  })

  it('with volumes needs both confirms', async () => {
    const bad = [
      { confirm: STACK, remove_volumes: true },
      { confirm: STACK, remove_volumes: true, confirm_volumes: STACK },
      { confirm: STACK, remove_volumes: true, confirm_volumes: `delete ${STACK}` },
      { confirm: 'x', remove_volumes: true, confirm_volumes: `delete ${STACK} data` }
    ]
    for (const b of bad) {
      const res = await call('POST', `/environments/${DOCKER}/stack/remove`, asAdmin, b)
      expect([res.statusCode, res.json().code]).toEqual([400, 'CONFIRM_REQUIRED'])
    }
    expect(m.remove).not.toHaveBeenCalled()
    const ok = await call('POST', `/environments/${DOCKER}/stack/remove`, asAdmin, {
      confirm: STACK,
      remove_volumes: true,
      confirm_volumes: `delete ${STACK} data`
    })
    expect(ok.statusCode).toBe(200)
    expect(m.remove.mock.calls[0].slice(1)).toEqual([STACK, { removeVolumes: true }])
    expect(JSON.parse(String(activityCalls()[0].comment))).toEqual({ stack: STACK, volumes: true })
  })

  it('refused while a promotion runs; holds the lock so no promotion starts meanwhile', async () => {
    const token = await memoryPromoteLock.take(DOCKER)
    try {
      const res = await call('POST', `/environments/${DOCKER}/stack/remove`, asAdmin, {
        confirm: STACK
      })
      expect([res.statusCode, res.json().code]).toEqual([409, 'PROMOTION_RUNNING'])
    } finally {
      if (token) await memoryPromoteLock.release(DOCKER, token)
    }
    expect(m.remove).not.toHaveBeenCalled()
    let heldDuring: string | null = 'unset'
    m.remove.mockImplementationOnce(async () => {
      heldDuring = await memoryPromoteLock.take(DOCKER)
      return { removed: { services: [], secrets: [], networks: [], volumes: [] } }
    })
    const ok = await call('POST', `/environments/${DOCKER}/stack/remove`, asAdmin, {
      confirm: STACK
    })
    expect(ok.statusCode).toBe(200)
    expect(heldDuring).toBeNull()
    const after = await memoryPromoteLock.take(DOCKER)
    expect(after).not.toBeNull()
    if (after) await memoryPromoteLock.release(DOCKER, after)
  })

  it('an agent failure leaves the status alone and answers the code', async () => {
    m.remove.mockRejectedValueOnce(new AgentError('STACK_NOT_HUB', 409, 'refused'))
    const res = await call('POST', `/environments/${DOCKER}/stack/remove`, asAdmin, {
      confirm: STACK
    })
    expect([res.statusCode, res.json().code]).toEqual([409, 'STACK_NOT_HUB'])
    expect((await db('nivaro_hub_environments').where({ id: DOCKER }).first()).status).toBe(
      'active'
    )
    expect(activityCalls()).toHaveLength(0)
  })
})

describe('POST /environments/:envId/stack/check-name', () => {
  it('flips waiting_for_name to active when the name serves the pinned version', async () => {
    await db('nivaro_hub_environments').where({ id: DOCKER }).update({ status: 'waiting_for_name' })
    const res = await call('POST', `/environments/${DOCKER}/stack/check-name`, asOwner)
    expect(res.json().data).toEqual({ state: 'serving', status: 'active' })
    expect(m.look.mock.calls[0]).toEqual([{ base_url: BASE }, '0.3.9'])
    expect((await db('nivaro_hub_environments').where({ id: DOCKER }).first()).status).toBe(
      'active'
    )
    expect(activityCalls().map((a) => a.action)).toEqual(['hub-name-ready'])
  })

  it('a name not serving yet keeps waiting; an active env is never changed', async () => {
    await db('nivaro_hub_environments').where({ id: DOCKER }).update({ status: 'waiting_for_name' })
    m.look.mockResolvedValueOnce('not_resolving')
    const a = (await call('POST', `/environments/${DOCKER}/stack/check-name`, asAdmin)).json()
    expect(a.data).toEqual({ state: 'not_resolving', status: 'waiting_for_name' })
    await db('nivaro_hub_environments').where({ id: DOCKER }).update({ status: 'suspended' })
    const b = (await call('POST', `/environments/${DOCKER}/stack/check-name`, asAdmin)).json()
    expect(b.data).toEqual({ state: 'serving', status: 'suspended' })
    expect(activityCalls()).toHaveLength(0)
  })
})

describe('DELETE /environments/:envId (docker guard)', () => {
  it('a live stack → 409 STACK_STILL_RUNNING; the environment stays', async () => {
    const res = await call('DELETE', `/environments/${DOCKER}`, asAdmin)
    expect([res.statusCode, res.json().code]).toEqual([409, 'STACK_STILL_RUNNING'])
    expect(await db('nivaro_hub_environments').where({ id: DOCKER }).first()).toBeTruthy()
    expect(m.stack.mock.calls[0].slice(1)).toEqual([STACK])
  })

  it('agent down → 409 AGENT_UNREACHABLE', async () => {
    m.stack.mockRejectedValueOnce(new AgentError('AGENT_UNREACHABLE', 0, 'could not be reached'))
    const res = await call('DELETE', `/environments/${DOCKER}`, asAdmin)
    expect([res.statusCode, res.json().code]).toEqual([409, 'AGENT_UNREACHABLE'])
    m.stack.mockRejectedValueOnce(new AgentError('AGENT_REFUSED', 401, 'refused the token'))
    const b = await call('DELETE', `/environments/${DOCKER}`, asAdmin)
    expect([b.statusCode, b.json().code]).toEqual([409, 'AGENT_UNREACHABLE'])
    expect(await db('nivaro_hub_environments').where({ id: DOCKER }).first()).toBeTruthy()
  })

  it('after remove (agent 404 for the stack) → deleted', async () => {
    await call('POST', `/environments/${DOCKER}/stack/remove`, asAdmin, { confirm: STACK })
    m.stack.mockResolvedValueOnce(null)
    const res = await call('DELETE', `/environments/${DOCKER}`, asAdmin)
    expect(res.statusCode).toBe(200)
    expect(await db('nivaro_hub_environments').where({ id: DOCKER }).first()).toBeUndefined()
  })

  it('a GitLab environment is deleted without asking any agent', async () => {
    const res = await call('DELETE', `/environments/${GITLAB}`, asAdmin)
    expect(res.statusCode).toBe(200)
    expect(m.stack).not.toHaveBeenCalled()
  })
})

describe('dockerEnvironmentDeleteRefusal', () => {
  it('null for a non-docker environment, a missing one and one with no stack name', async () => {
    expect(await dockerEnvironmentDeleteRefusal(GITLAB)).toBeNull()
    expect(await dockerEnvironmentDeleteRefusal(99999)).toBeNull()
    await db('nivaro_hub_placements')
      .where({ id: 5 })
      .update({ target: JSON.stringify({}) })
    expect(await dockerEnvironmentDeleteRefusal(DOCKER)).toBeNull()
    expect(m.stack).not.toHaveBeenCalled()
  })

  it('a stack name another (non-Hub) stack uses is not this environment’s', async () => {
    m.stack.mockRejectedValueOnce(new AgentError('STACK_NOT_HUB', 409, 'refused'))
    expect(await dockerEnvironmentDeleteRefusal(DOCKER)).toBeNull()
  })

  it('an unreadable agent token cannot prove the stack is gone', async () => {
    m.stack.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Stored hub token could not be decrypted'), {
        code: 'HUB_SECRET_UNREADABLE'
      })
    })
    expect((await dockerEnvironmentDeleteRefusal(DOCKER))?.code).toBe('AGENT_UNREACHABLE')
  })
})
