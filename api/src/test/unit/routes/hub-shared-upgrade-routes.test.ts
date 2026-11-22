import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6, Task 5: the shared upgrade routes (routes/hub-shared-upgrade.ts). Real
// SQLite with the hub tables; the agent, the registry, the deployment link, the sightings and the
// public names are mocked at their modules. Every route is for a Hub administrator; the answers
// keep the plan's shapes (T17 builds on them).

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
vi.mock('../../../services/job-runs.js', async (orig) => {
  const real = await orig<typeof import('../../../services/job-runs.js')>()
  return {
    ...real,
    startJobRun: vi.fn(async () => ({
      id: 5,
      progress: () => undefined,
      log: () => undefined,
      complete: async () => undefined,
      fail: async () => undefined
    })),
    readJobLog: vi.fn(async () => [])
  }
})
vi.mock('../../../services/hub/registry.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/hub/registry.js')>()),
  imageDigest: vi.fn(async () => `sha256:${'a'.repeat(64)}`)
}))
vi.mock('../../../services/hub/docker/agent-client.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/hub/docker/agent-client.js')>()),
  agentHealth: vi.fn(async () => ({
    api: 1,
    agent_version: '0.2.0',
    engine_api: '1.44',
    swarm: { manager: true, node_id: 'n1', nodes: 1 },
    images: ['nodeworks/nivaro'],
    host_suffixes: ['.example.com'],
    edge: 'traefik',
    publish_ports: null,
    extensions_shared: false,
    redis_bundled: true
  })),
  agentApply: vi.fn(async () => ({ spec_hash: 'f'.repeat(64), changed: [], unchanged: [] })),
  agentStack: vi.fn(async () => ({ state: 'converged', services: [] }))
}))
vi.mock('../../../services/hub/shared/sightings.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/hub/shared/sightings.js')>()),
  liveSightings: vi.fn(async () => [
    { instance: 'i1', version: '0.3.210', etag: null, at: new Date().toISOString() }
  ])
}))
vi.mock('../../../services/hub/shared/deployment-client.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/hub/shared/deployment-client.js')>()),
  deploymentClient: vi.fn(() => ({
    appStatus: async () => ({ preflight: { status: 'ok', failing: [] } }),
    status: async () => ({ version: '0.3.210', apps: [] })
  }))
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
const { hubSharedUpgradeRoutes } = await import('../../../routes/hub-shared-upgrade.js')
const Store = await import('../../../services/hub/shared/store.js')
const Run = await import('../../../services/hub/shared/upgrade-run.js')
const { sealSecret } = await import('../../../services/hub/secrets.js')

const asAdmin = { 'x-user': 'AAAAAAAA-0000-4000-8000-000000000001', 'x-admin': '1' }
const asUser = { 'x-user': 'BBBBBBBB-0000-4000-8000-000000000002' }
const prev: Record<string, string | undefined> = {}
let app: FastifyInstance
let sharedId = 0
let key = ''

beforeAll(async () => {
  for (const k of ['HUB', 'ENCRYPTION_KEY', 'HUB_URL']) prev[k] = process.env[k]
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  process.env.HUB_URL = 'https://hub.example.com'
  for (const mig of migrations) await mig.up(db)
  const [d] = await db('nivaro_hub_drivers')
    .insert({
      kind: 'docker',
      name: 'swarm',
      config: JSON.stringify({
        agent_url: 'https://agent.example.com',
        dns_mode: 'automatic',
        wildcard_domain: 'example.com',
        edge_target: null
      }),
      secret: sealSecret('agent-Token-Value-0123456789-abcdefghij')
    })
    .returning('id')
  const driverId = Number(typeof d === 'object' ? (d as { id: number }).id : d)
  const v = Store.validateSharedInput({
    key: 'shared-r',
    name: 'Shared R',
    link_url: 'https://shared-r.internal.example.com',
    mode: 'docker',
    driver_id: driverId,
    stack: 'shared-r',
    host_pattern: '*.apps.example.com',
    extensions: []
  })
  if (!v.ok) throw new Error(v.code)
  sharedId = (await Store.createShared(v.row, null)).row.id
  key = 'shared-r'
  await db('nivaro_hub_shared_deployments')
    .where({ id: sharedId })
    .update({ version_pin: '0.3.209', status: 'active' })
  app = Fastify()
  await app.register(async (f) => hubSharedUpgradeRoutes(f), { prefix: '/api/hub' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await db.destroy()
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const plan = () =>
  app.inject({
    method: 'POST',
    url: `/api/hub/shared/${sharedId}/upgrade/plan`,
    headers: asAdmin,
    payload: { version: '0.3.210' }
  })

describe('shared upgrade routes', () => {
  it('every route refuses a non-admin', async () => {
    for (const [method, url] of [
      ['POST', `/api/hub/shared/${sharedId}/upgrade/plan`],
      ['POST', `/api/hub/shared/${sharedId}/upgrade`],
      ['GET', `/api/hub/shared/${sharedId}/deploys`],
      ['GET', '/api/hub/shared-deploys/1'],
      ['POST', '/api/hub/shared-deploys/1/cancel']
    ] as const) {
      const r = await app.inject({ method, url, headers: asUser, payload: {} })
      expect(r.statusCode, `${method} ${url}`).toBe(403)
    }
  })

  it('plan → start (202) → read the run → history; cancel after the end is NOT_RUNNING', async () => {
    const p = await plan()
    expect(p.statusCode).toBe(200)
    const data = p.json().data
    expect(data).toMatchObject({
      shared_id: sharedId,
      kind: 'upgrade',
      version: '0.3.210',
      blockers: []
    })
    expect(data.plan_hash).toMatch(/^[0-9a-f]{64}$/)

    const s = await app.inject({
      method: 'POST',
      url: `/api/hub/shared/${sharedId}/upgrade`,
      headers: asAdmin,
      payload: { version: '0.3.210', plan_hash: data.plan_hash, confirm: key }
    })
    expect(s.statusCode).toBe(202)
    const id = s.json().data.shared_deploy_id
    await Run.awaitSharedUpgrade(id)

    const g = await app.inject({
      method: 'GET',
      url: `/api/hub/shared-deploys/${id}`,
      headers: asAdmin
    })
    expect(g.statusCode).toBe(200)
    expect(g.json().data).toMatchObject({
      id,
      shared_deployment_id: sharedId,
      kind: 'upgrade',
      version: '0.3.210',
      status: 'success',
      log: []
    })
    expect(JSON.stringify(g.json())).not.toMatch(/HUB_DEPLOYMENT_TOKEN|SESSION_SECRET/)

    const h = await app.inject({
      method: 'GET',
      url: `/api/hub/shared/${sharedId}/deploys`,
      headers: asAdmin
    })
    expect(h.json().data[0]).toMatchObject({ id, status: 'success' })

    const c = await app.inject({
      method: 'POST',
      url: `/api/hub/shared-deploys/${id}/cancel`,
      headers: asAdmin
    })
    expect(c.statusCode).toBe(409)
    expect(c.json().code).toBe('NOT_RUNNING')
  })

  it('a stale plan_hash → 409 PLAN_CHANGED carrying the new plan; a bad confirm → 400', async () => {
    const data = (await plan()).json().data
    const bad = await app.inject({
      method: 'POST',
      url: `/api/hub/shared/${sharedId}/upgrade`,
      headers: asAdmin,
      payload: { version: '0.3.210', plan_hash: data.plan_hash, confirm: 'wrong' }
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('CONFIRM_MISMATCH')
    const stale = await app.inject({
      method: 'POST',
      url: `/api/hub/shared/${sharedId}/upgrade`,
      headers: asAdmin,
      payload: { version: '0.3.210', plan_hash: '0'.repeat(64), confirm: key }
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({
      code: 'PLAN_CHANGED',
      plan: { plan_hash: data.plan_hash }
    })
  })

  it('unknown ids are 404', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/hub/shared-deploys/9999',
      headers: asAdmin
    })
    expect(r.statusCode).toBe(404)
    const p = await app.inject({
      method: 'POST',
      url: '/api/hub/shared/9999/upgrade/plan',
      headers: asAdmin,
      payload: { version: '0.3.210' }
    })
    expect(p.statusCode).toBe(404)
  })
})
