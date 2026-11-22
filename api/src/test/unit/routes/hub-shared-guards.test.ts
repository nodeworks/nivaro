import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6, Task 4: the guards around a shared placement (Decision 17) and the admin
// "forget stack". Real SQLite with the hub tables (542–553), mounted through hubRoutes; the
// deployment link client, the Hub agent and outbound HTTP are mocked.

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
  fetchJson: vi.fn(),
  appStatus: vi.fn(),
  agentStack: vi.fn(),
  agentLeftovers: vi.fn()
}))
vi.mock('../../../services/gitlab-client.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/gitlab-client.js')>()),
  fetchJson: m.fetchJson
}))
vi.mock('../../../services/hub/shared/deployment-client.js', async (orig) => {
  const real = await orig<typeof import('../../../services/hub/shared/deployment-client.js')>()
  return {
    ...real,
    deploymentClient: vi.fn(() => ({
      appStatus: m.appStatus,
      status: vi.fn(),
      refresh: vi.fn(),
      firstAdmin: vi.fn()
    }))
  }
})
vi.mock('../../../services/hub/docker/agent-client.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/hub/docker/agent-client.js')>()),
  agentStack: m.agentStack,
  agentLeftovers: m.agentLeftovers,
  agentHealth: vi.fn(async () => {
    throw new Error('no health read here')
  }),
  agentApply: vi.fn(async () => {
    throw new Error('no apply from a guard test')
  })
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const migrations = [
  await import('../../../db/migrations/542_hub_tables.js'),
  await import('../../../db/migrations/543_hub_promotions.js'),
  await import('../../../db/migrations/544_hub_databases.js'),
  await import('../../../db/migrations/545_hub_creations.js'),
  await import('../../../db/migrations/546_hub_stack_settings.js'),
  await import('../../../db/migrations/550_hub_oidc.js'),
  await import('../../../db/migrations/551_hub_signins.js'),
  await import('../../../db/migrations/552_hub_shared_deployments.js'),
  await import('../../../db/migrations/553_hub_moves.js')
]
const { hubRoutes } = await import('../../../routes/hub.js')
const Store = await import('../../../services/hub/shared/store.js')
const { sealSecret } = await import('../../../services/hub/secrets.js')
const { AgentError } = await import('../../../services/hub/docker/agent-client.js')
const { DeploymentLinkError } = await import('../../../services/hub/shared/deployment-client.js')
const { dockerEnvironmentDeleteRefusal, stackEditRefusal } = await import(
  '../../../services/hub/docker/stack-guards.js'
)
const { resumeCreation, runCreationLeg } = await import('../../../services/hub/create/run.js')
const { memoryPromoteLock } = await import('../../../services/hub/promote-lock.js')
const { cancelPromotion, healBeforeRead, recoverInterruptedPromotions } = await import(
  '../../../services/hub/promote-run.js'
)
const { buildPromotionPlan } = await import('../../../services/hub/promote-plan.js')

const HUB_KEY = 'e'.repeat(64)
const AGENT_TOKEN = 'agent-Token-Value-0123456789-abcdefghij'
const HUB_TOKEN = 'hub-link-Token-Value-0123456789-abcdefghij'
const asAdmin = { 'x-user': 'AAAAAAAA-0000-4000-8000-000000000001', 'x-admin': '1' }
const asUser = { 'x-user': 'BBBBBBBB-0000-4000-8000-000000000002' }
const saved = { HUB: process.env.HUB, KEY: process.env.ENCRYPTION_KEY }

// env 20 = prod on shared placement 10; env 21 = dev on Docker placement 11 (stack acme-old).
const SHARED_ENV = 20
const DOCKER_ENV = 21
let sharedId = 0
let app: FastifyInstance

const OWNED = {
  name: 'acme-old',
  owner: { app: 'acme' },
  environment: 'dev',
  spec_hash: 'f'.repeat(64),
  image: `nodeworks/nivaro@sha256:${'a'.repeat(64)}`,
  state: 'converged',
  published_port: null,
  services: []
}

const inject = (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = asAdmin
) =>
  app.inject({
    method,
    url: `/api/hub${url}`,
    headers,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {})
  })

beforeAll(async () => {
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = HUB_KEY
  for (const mig of migrations) await mig.up(db)
  const v = Store.validateSharedInput({
    key: 'shared-one',
    name: 'Shared one',
    link_url: 'https://shared-one.internal.example.com'
  })
  if (!v.ok) throw new Error(v.code)
  sharedId = (await Store.createShared(v.row, null)).row.id
  app = Fastify()
  await app.register(hubRoutes, { prefix: '/api/hub' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await db.destroy()
  process.env.HUB = saved.HUB
  process.env.ENCRYPTION_KEY = saved.KEY
})

beforeEach(async () => {
  vi.clearAllMocks()
  for (const t of [
    'nivaro_hub_apps',
    'nivaro_hub_environments',
    'nivaro_hub_placements',
    'nivaro_hub_drivers',
    'nivaro_hub_deploys',
    'nivaro_hub_creations',
    'nivaro_hub_databases'
  ])
    await db(t).del()
  await db('nivaro_hub_shared_deployments')
    .where({ id: sharedId })
    .update({ status: 'active', version_pin: '0.3.210', pool_budget: 60 })
  await db('nivaro_hub_apps').insert({ id: 1, key: 'acme', name: 'Acme', extensions: '[]' })
  await db('nivaro_hub_drivers').insert({
    id: 3,
    kind: 'docker',
    name: 'swarm',
    config: JSON.stringify({
      agent_url: 'https://agent.example.com',
      dns_mode: 'automatic',
      wildcard_domain: 'apps.example.com',
      edge_target: null
    }),
    secret: sealSecret(AGENT_TOKEN)
  })
  await db('nivaro_hub_placements').insert([
    {
      id: 10,
      kind: 'shared',
      shared_deployment_id: sharedId,
      target: JSON.stringify({ pool_max: 4 })
    },
    { id: 11, kind: 'dedicated', driver_id: 3, target: JSON.stringify({ stack: 'acme-old' }) },
    { id: 12, kind: 'dedicated', driver_id: 3, target: JSON.stringify({ stack: 'acme-new' }) },
    { id: 13, kind: 'shared', shared_deployment_id: sharedId, target: '{}' }
  ])
  await db('nivaro_hub_environments').insert([
    {
      id: SHARED_ENV,
      app_id: 1,
      key: 'prod',
      position: 0,
      status: 'active',
      base_url: 'https://acme.apps.example.com',
      hostnames: '[]',
      placement_id: 10,
      version_pin: '0.3.210',
      hub_managed: true,
      // Kept for a later move back (R3), never called while on shared.
      hub_token: sealSecret(HUB_TOKEN)
    },
    {
      id: DOCKER_ENV,
      app_id: 1,
      key: 'dev',
      position: 1,
      status: 'active',
      base_url: 'https://acme-dev.apps.example.com',
      hostnames: '[]',
      placement_id: 11,
      version_pin: '0.3.210',
      hub_managed: true
    }
  ])
  m.fetchJson.mockImplementation(async (url: string) =>
    url.endsWith('/api/version')
      ? { ok: true, status: 200, body: { version: '0.3.210', shared_deployment: 'shared-one' } }
      : { ok: true, status: 200, body: { status: 'ok' } }
  )
  m.appStatus.mockResolvedValue({
    id: 'acme-e20',
    version: '0.3.210',
    preflight: { status: 'ok', failing: [] },
    readiness_score: null,
    busy: { imports: 0, exports: 0, renders: 0 },
    files: { count: 0, bytes: 0, local: 0 },
    key_fp: null,
    maintenance: false
  })
})

describe('promotions on a shared-placed environment', () => {
  it('the plan carries blocker SHARED_PLACEMENT (and no NO_COMPONENTS)', async () => {
    const res = await inject('POST', `/environments/${SHARED_ENV}/promote/plan`, {
      kind: 'promote',
      version: '0.3.211'
    })
    expect(res.statusCode).toBe(200)
    const codes = res.json().data.blockers.map((b: { code: string }) => b.code)
    expect(codes).toContain('SHARED_PLACEMENT')
    expect(codes).not.toContain('NO_COMPONENTS')
    expect(res.json().data.ok).toBe(false)
  })

  it('the pure planner: sharedPlacement → SHARED_PLACEMENT', () => {
    const plan = buildPromotionPlan({
      sharedPlacement: true,
      app: {
        id: 1,
        key: 'acme',
        name: 'Acme',
        signin_mode: 'direct',
        adopted: false,
        extensions: []
      },
      target: {
        id: 20,
        app_id: 1,
        key: 'prod',
        position: 0,
        status: 'active',
        base_url: 'https://acme.apps.example.com',
        hostnames: [],
        placement_id: 10,
        version_pin: '0.3.210',
        hub_token: null,
        hub_managed: true
      },
      previous: null,
      components: [],
      kind: 'promote',
      version: '0.3.211',
      targetVersion: '0.3.210',
      previousVersion: null,
      previousDeployedVersions: [],
      targetDeployedVersions: [],
      sources: {},
      frontendServed: {},
      frontendOnSource: {},
      sourceOnTarget: {},
      digest: null,
      slimDigest: null,
      running: false,
      targetState: 'ok',
      drivers: {}
    })
    expect(plan.ok).toBe(false)
    expect(plan.blockers.map((b) => b.code)).toContain('SHARED_PLACEMENT')
  })
})

describe('status of a shared-placed environment (R3)', () => {
  it('reads the deployment link and the public version; the hub token is never called', async () => {
    const res = await inject('GET', `/environments/${SHARED_ENV}/status`)
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({ state: 'ok', source: 'shared', version: '0.3.210' })
    expect(m.appStatus).toHaveBeenCalledWith('acme-e20')
    const urls = m.fetchJson.mock.calls.map((c) => String(c[0]))
    expect(urls).toEqual(['https://acme.apps.example.com/api/version'])
    expect(JSON.stringify(m.fetchJson.mock.calls)).not.toContain(HUB_TOKEN)
  })

  it('a public name still routed elsewhere is degraded (NOT_ON_SHARED); a refused link link_refused', async () => {
    m.fetchJson.mockResolvedValueOnce({ ok: true, status: 200, body: { version: '0.3.209' } })
    let res = await inject('GET', `/environments/${SHARED_ENV}/status?fresh=1`)
    expect(res.json().data).toMatchObject({ state: 'degraded', error: 'NOT_ON_SHARED' })
    m.appStatus.mockRejectedValueOnce(new DeploymentLinkError('LINK_REFUSED', 401))
    res = await inject('GET', `/environments/${SHARED_ENV}/status?fresh=1`)
    expect(res.json().data).toMatchObject({ state: 'link_refused', error: 'LINK_REFUSED' })
  })
})

describe('stack routes on a shared-placed environment', () => {
  it('apply, read, settings, remove → 409 SHARED_PLACEMENT; a plain env stays NOT_DOCKER', async () => {
    for (const [method, url, payload] of [
      ['POST', `/environments/${SHARED_ENV}/stack/apply`, { confirm: 'prod' }],
      ['GET', `/environments/${SHARED_ENV}/stack`, undefined],
      ['GET', `/environments/${SHARED_ENV}/stack/settings`, undefined],
      ['POST', `/environments/${SHARED_ENV}/stack/remove`, { confirm: 'x' }],
      ['POST', `/environments/${SHARED_ENV}/stack/restart`, { confirm: 'prod' }]
    ] as const) {
      const res = await inject(method, url, payload)
      expect(res.statusCode, url).toBe(409)
      expect(res.json().code, url).toBe('SHARED_PLACEMENT')
    }
    await db('nivaro_hub_environments').where({ id: DOCKER_ENV }).update({ placement_id: null })
    const plain = await inject('GET', `/environments/${DOCKER_ENV}/stack`)
    expect(plain.json().code).toBe('NOT_DOCKER')
    expect(m.agentStack).not.toHaveBeenCalled()
  })
})

describe('environment and placement edits', () => {
  it('PATCH placement shared → dedicated and dedicated → shared: 409 USE_MOVE', async () => {
    let res = await inject('PATCH', `/environments/${SHARED_ENV}`, { placement_id: 12 })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('USE_MOVE')
    res = await inject('PATCH', `/environments/${SHARED_ENV}`, { placement_id: null })
    expect(res.json().code).toBe('USE_MOVE')
    res = await inject('PATCH', `/environments/${DOCKER_ENV}`, { placement_id: 13 })
    expect(res.json().code).toBe('USE_MOVE')
    const env = await db('nivaro_hub_environments').where({ id: SHARED_ENV }).first('placement_id')
    expect(env.placement_id).toBe(10)
    expect(m.agentStack).not.toHaveBeenCalled()
  })

  it('a shared-placed environment keeps the deployment version pin (SHARED_PLACEMENT)', async () => {
    const res = await inject('PATCH', `/environments/${SHARED_ENV}`, { version_pin: '0.3.211' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('SHARED_PLACEMENT')
    // Other fields still edit.
    const ok = await inject('PATCH', `/environments/${SHARED_ENV}`, { position: 3 })
    expect(ok.statusCode).toBe(200)
  })

  it('POST an environment on a shared placement: 409 USE_PLACE_SHARED', async () => {
    const res = await inject('POST', '/apps/1/environments', {
      key: 'stage',
      base_url: 'https://acme-stage.apps.example.com',
      placement_id: 13
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('USE_PLACE_SHARED')
  })

  it('POST /placements kind shared: made; POOL_TOO_SMALL, BAD_TARGET, BAD_SHARED, SHARED_RETIRED', async () => {
    let res = await inject('POST', '/placements', {
      kind: 'shared',
      shared_deployment_id: sharedId,
      target: { pool_max: 6 }
    })
    expect(res.statusCode).toBe(200)
    const row = await db('nivaro_hub_placements').where({ id: res.json().data.id }).first()
    expect(row).toMatchObject({ kind: 'shared', shared_deployment_id: sharedId, driver_id: null })
    expect(JSON.parse(row.target)).toEqual({ pool_max: 6 })

    res = await inject('POST', '/placements', {
      kind: 'shared',
      shared_deployment_id: sharedId,
      target: { pool_max: 1 }
    })
    expect(res.json().code).toBe('POOL_TOO_SMALL')
    res = await inject('POST', '/placements', {
      kind: 'shared',
      shared_deployment_id: sharedId,
      target: { stack: 'acme' }
    })
    expect(res.json().code).toBe('BAD_TARGET')
    res = await inject('POST', '/placements', { kind: 'shared', shared_deployment_id: 999 })
    expect(res.json().code).toBe('BAD_SHARED')
    await db('nivaro_hub_shared_deployments').where({ id: sharedId }).update({ status: 'retired' })
    res = await inject('POST', '/placements', { kind: 'shared', shared_deployment_id: sharedId })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('SHARED_RETIRED')
  })

  it('PATCH /placements: a kind change is a move; pool_max is judged against the budget', async () => {
    let res = await inject('PATCH', '/placements/10', { kind: 'dedicated', driver_id: 3 })
    expect(res.json().code).toBe('USE_MOVE')
    res = await inject('PATCH', '/placements/11', { kind: 'shared' })
    expect(res.json().code).toBe('USE_MOVE')
    await db('nivaro_hub_shared_deployments').where({ id: sharedId }).update({ pool_budget: 6 })
    res = await inject('PATCH', '/placements/10', { target: { pool_max: 7 } })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('POOL_BUDGET')
    res = await inject('PATCH', '/placements/10', { target: { pool_max: 6 } })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.target).toEqual({ pool_max: 6 })
  })
})

describe('creation on a shared-placed environment', () => {
  it('a creation run or retry answers SHARED_PLACEMENT', async () => {
    await db('nivaro_hub_creations').insert({
      app_id: 1,
      environment_id: SHARED_ENV,
      status: 'queued',
      steps: '[]',
      version: '0.3.210',
      first_admin: '{}'
    })
    const lock = memoryPromoteLock
    await expect(runCreationLeg(SHARED_ENV, { id: 'u' }, { lock })).rejects.toMatchObject({
      code: 'SHARED_PLACEMENT',
      status: 409
    })
    await db('nivaro_hub_creations').where({ environment_id: SHARED_ENV }).update({
      status: 'failed'
    })
    await expect(resumeCreation(SHARED_ENV, { id: 'u' }, 'retry', { lock })).rejects.toMatchObject({
      code: 'SHARED_PLACEMENT'
    })
  })
})

describe('forget stack', () => {
  async function dockerDeploy(at: number) {
    await db('nivaro_hub_deploys').insert({
      app_id: 1,
      environment_id: DOCKER_ENV,
      kind: 'promote',
      version: '0.3.210',
      status: 'failed',
      plan: JSON.stringify({ steps: [{ driver: 'docker', stack: { name: 'acme-old' } }] }),
      started_at: new Date(at)
    })
  }

  it('wrong name → 400; the agent reporting the stack → 409 STACK_RUNNING; admin only', async () => {
    let res = await inject('POST', '/placements/11/forget-stack', { confirm: 'acme' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('CONFIRM_REQUIRED')
    m.agentStack.mockResolvedValueOnce(OWNED)
    res = await inject('POST', '/placements/11/forget-stack', { confirm: 'acme-old' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('STACK_RUNNING')
    res = await inject('POST', '/placements/11/forget-stack', { confirm: 'acme-old' }, asUser)
    expect(res.statusCode).toBe(403)
    const target = JSON.parse((await db('nivaro_hub_placements').where({ id: 11 }).first()).target)
    expect(target.forgotten_at).toBeUndefined()
  })

  it('agent unreachable + the right name → 200, forgotten_at set; the guards stop refusing', async () => {
    m.agentStack.mockRejectedValue(new AgentError('AGENT_UNREACHABLE', 0, 'no answer'))
    await dockerDeploy(Date.now() - 60_000)
    // Before: a deploy of the stack is recorded and the agent cannot say → the guards refuse.
    expect(await stackEditRefusal([DOCKER_ENV], 'key')).toMatchObject({ code: 'STACK_RUNNING' })
    expect((await dockerEnvironmentDeleteRefusal(DOCKER_ENV))?.code).toBe('AGENT_UNREACHABLE')

    const res = await inject('POST', '/placements/11/forget-stack', { confirm: 'acme-old' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({ id: 11, stack: 'acme-old', agent: 'unknown' })
    const target = JSON.parse((await db('nivaro_hub_placements').where({ id: 11 }).first()).target)
    expect(target).toMatchObject({ stack: 'acme-old' })
    expect(typeof target.forgotten_at).toBe('string')

    expect(await stackEditRefusal([DOCKER_ENV], 'key')).toBeNull()
    expect(await dockerEnvironmentDeleteRefusal(DOCKER_ENV)).toBeNull()
    const edit = await inject('PATCH', `/environments/${DOCKER_ENV}`, { key: 'develop' })
    expect(edit.statusCode).toBe(200)

    // A PATCH naming the same stack keeps it forgotten.
    await inject('PATCH', '/placements/11', { target: { stack: 'acme-old' } })
    expect(
      JSON.parse((await db('nivaro_hub_placements').where({ id: 11 }).first()).target).forgotten_at
    ).toBe(target.forgotten_at)

    // Deployed again after forgetting: guarded again.
    await dockerDeploy(Date.now() + 60_000)
    expect(await stackEditRefusal([DOCKER_ENV], 'key')).toMatchObject({ code: 'STACK_RUNNING' })
  })

  it('M-6: forgotten, but the agent comes back reporting the stack as ours → delete refused', async () => {
    m.agentStack.mockRejectedValueOnce(new AgentError('AGENT_UNREACHABLE', 0, 'no answer'))
    await dockerDeploy(Date.now() - 60_000)
    const res = await inject('POST', '/placements/11/forget-stack', { confirm: 'acme-old' })
    expect(res.statusCode).toBe(200)
    m.agentStack.mockResolvedValueOnce(OWNED)
    expect((await dockerEnvironmentDeleteRefusal(DOCKER_ENV))?.code).toBe('STACK_STILL_RUNNING')
    m.agentStack.mockResolvedValueOnce(null)
    expect(await dockerEnvironmentDeleteRefusal(DOCKER_ENV)).toBeNull()
  })

  it('a shared placement has no stack to forget', async () => {
    const res = await inject('POST', '/placements/10/forget-stack', { confirm: 'x' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('SHARED_PLACEMENT')
  })
})

describe('place-shared route', () => {
  it('admin only; an environment that has served → 409 USE_MOVE with the refusal shape', async () => {
    const body = {
      shared_id: sharedId,
      database_id: 1,
      first_admin: { email: 'owner@example.com' }
    }
    let res = await inject('POST', `/environments/${DOCKER_ENV}/place-shared`, body, asUser)
    expect(res.statusCode).toBe(403)
    await db('nivaro_hub_deploys').insert({
      app_id: 1,
      environment_id: DOCKER_ENV,
      kind: 'promote',
      version: '0.3.210',
      status: 'success',
      started_at: new Date()
    })
    res = await inject('POST', `/environments/${DOCKER_ENV}/place-shared`, body)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ statusCode: 409, code: 'USE_MOVE' })
    res = await inject('POST', '/environments/999/place-shared', body)
    expect(res.statusCode).toBe(404)
    res = await inject('POST', `/environments/${DOCKER_ENV}/place-shared`, { shared_id: 'x' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('BAD_SHARED')
  })
})

describe('phase-2 heal leaves move / shared mirror rows alone (R8)', () => {
  it('recover, healBeforeRead and cancel act on promote / rollback rows only', async () => {
    const insert = async (kind: string) =>
      Number(
        (
          (await db('nivaro_hub_deploys')
            .insert({
              app_id: 1,
              environment_id: DOCKER_ENV,
              kind,
              version: '0.3.210',
              status: 'running',
              started_at: new Date(Date.now() - 3_600_000)
            })
            .returning('id')) as Array<{ id: number } | number>
        ).map((r) => (typeof r === 'object' ? r.id : r))[0]
      )
    const move = await insert('move')
    const shared = await insert('shared')
    const promote = await insert('promote')
    await healBeforeRead(DOCKER_ENV, { lock: memoryPromoteLock })
    const status = async (id: number) =>
      (await db('nivaro_hub_deploys').where({ id }).first('status')).status
    expect(await status(move)).toBe('running')
    expect(await status(shared)).toBe('running')
    expect(await status(promote)).toBe('interrupted')
    await recoverInterruptedPromotions({ lock: memoryPromoteLock })
    expect(await status(move)).toBe('running')
    expect(await cancelPromotion(move, null, { lock: memoryPromoteLock })).toEqual({
      ok: false,
      code: 'NOT_FOUND'
    })
  })
})
