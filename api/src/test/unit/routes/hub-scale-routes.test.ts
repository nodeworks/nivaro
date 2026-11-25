import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub scaling routes (/api/hub/scale*): admin only, input checked, every write logged,
// a run bound to its plan. Real SQLite with the hub tables; the agent answers from a mock and is
// never reached.

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
const m = vi.hoisted(() => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: m.logActivity }))
vi.mock('../../../services/hub/docker/agent-client.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/hub/docker/agent-client.js')>()),
  agentHealth: vi.fn(async () => ({
    api: 1,
    agent_version: '0.2.4',
    engine_api: '1.45',
    swarm: { manager: true, node_id: 'n1', nodes: 1 },
    images: ['nodeworks/nivaro'],
    host_suffixes: ['.apps.corp'],
    edge: 'traefik',
    publish_ports: null,
    extensions_shared: false,
    redis_bundled: true
  })),
  agentStack: vi.fn(async () => null)
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const migrations = [
  await import('../../../db/migrations/542_hub_tables.js'),
  await import('../../../db/migrations/543_hub_promotions.js'),
  await import('../../../db/migrations/544_hub_databases.js'),
  await import('../../../db/migrations/546_hub_stack_settings.js'),
  await import('../../../db/migrations/552_hub_shared_deployments.js'),
  await import('../../../db/migrations/553_hub_moves.js'),
  await import('../../../db/migrations/565_hub_release_ops.js'),
  await import('../../../db/migrations/570_hub_people_owner_policy.js'),
  await import('../../../db/migrations/581_hub_scale.js')
]
const { hubScaleRoutes } = await import('../../../routes/hub-scale.js')

const admin = { 'x-user': 'aaaaaaaa-0000-4000-8000-000000000001', 'x-admin': '1' }
const person = { 'x-user': 'aaaaaaaa-0000-4000-8000-000000000002' }
let app: FastifyInstance

beforeAll(async () => {
  for (const mig of migrations) await mig.up(db)
  await db('nivaro_hub_apps').insert({ id: 1, key: 'acme', name: 'Acme' })
  await db('nivaro_hub_drivers').insert({
    id: 1,
    kind: 'docker',
    name: 'swarm',
    config: JSON.stringify({ agent_url: 'https://agent.corp:8443' })
  })
  await db('nivaro_hub_placements').insert({
    id: 1,
    kind: 'dedicated',
    driver_id: 1,
    target: JSON.stringify({ stack: 'acme-st' })
  })
  await db('nivaro_hub_db_servers').insert({ id: 1, name: 'sql1', engine: 'mssql', host: 'sql1' })
  await db('nivaro_hub_environments').insert([
    {
      id: 1,
      app_id: 1,
      key: 'staging',
      position: 1,
      base_url: 'https://acme-staging.apps.corp',
      placement_id: 1,
      version_pin: '0.3.215'
    },
    { id: 2, app_id: 1, key: 'production', position: 2, base_url: 'https://acme.apps.corp' }
  ])
  await db('nivaro_hub_stack_settings').insert({
    environment_id: 1,
    size: 'medium',
    redis: 'bundled',
    settings: '{}'
  })
  await db('nivaro_hub_deploys').insert({
    app_id: 1,
    environment_id: 1,
    kind: 'promote',
    version: '0.3.215',
    status: 'success',
    started_at: new Date(Date.now() - 60_000),
    plan: JSON.stringify({
      steps: [
        {
          driver: 'docker',
          stack: { name: 'acme-st', extensions: {}, size: 'medium' },
          deployedImage: `nodeworks/nivaro@sha256:${'1'.repeat(64)}`,
          deployedSpecHash: 'a'.repeat(64)
        }
      ]
    })
  })
  app = Fastify()
  await app.register(async (f) => hubScaleRoutes(f), { prefix: '/api/hub' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await db.destroy()
})

beforeEach(() => vi.clearAllMocks())

const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = admin) =>
  app.inject({ method, url: `/api/hub${url}`, headers, payload: payload as never })

describe('/api/hub/scale', () => {
  it('is for administrators only', async () => {
    expect((await call('GET', '/scale', undefined, person)).statusCode).toBe(403)
    expect((await call('GET', '/scale', undefined, {} as never)).statusCode).toBe(401)
  })

  it('lists the stack with its roles; one stack in detail', async () => {
    const r = await call('GET', '/scale')
    expect(r.statusCode).toBe(200)
    const t = r.json().data.targets.find((x: { kind: string }) => x.kind === 'environment')
    expect(
      t.roles.map((x: { role: string; replicas: number }) => `${x.role}×${x.replicas}`)
    ).toEqual(['web×2', 'worker×1'])
    const d = await call('GET', '/scale/targets/environment/1')
    expect(d.statusCode).toBe(200)
    expect(d.json().data.now.agent).toEqual({ version: '0.2.4', ok: true })
    expect((await call('GET', '/scale/targets/nope/1')).statusCode).toBe(404)
    expect((await call('GET', '/scale/targets/environment/99')).statusCode).toBe(404)
  })

  it('plans; a run must carry the plan the person read', async () => {
    expect(
      (await call('POST', '/scale/targets/environment/1/plan', { roles: [] })).statusCode
    ).toBe(400)
    const p = await call('POST', '/scale/targets/environment/1/plan', {
      roles: [{ role: 'web', replicas: 4 }]
    })
    expect(p.statusCode).toBe(200)
    expect(p.json().data).toMatchObject({ blockers: [], changes: [{ role: 'web', replicas: 4 }] })
    const stale = await call('POST', '/scale/targets/environment/1/runs', {
      roles: [{ role: 'web', replicas: 4 }],
      plan_hash: 'x'
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({
      code: 'PLAN_CHANGED',
      plan: { plan_hash: p.json().data.plan_hash }
    })
    const blocked = await call('POST', '/scale/targets/environment/1/runs', {
      roles: [{ role: 'worker', replicas: 2 }],
      plan_hash: 'x'
    })
    expect(blocked.statusCode).toBe(409)
  })

  it('checks and logs rules and pins', async () => {
    const bad = await call('PUT', '/scale/targets/environment/1/roles/web', {
      auto: {
        enabled: true,
        min: 2,
        max: 5,
        metrics: [{ metric: 'cpu_pct', out_above: 30, in_below: 40 }]
      }
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('BAD_RULE')
    expect(
      (
        await call('PUT', '/scale/targets/environment/1/roles/worker', {
          auto: { enabled: true, min: 1, max: 1 }
        })
      ).json().code
    ).toBe('NOT_SCALABLE')
    expect(
      (await call('PUT', '/scale/targets/environment/1/roles/realtime', { pinned: true }))
        .statusCode
    ).toBe(404)
    const ok = await call('PUT', '/scale/targets/environment/1/roles/web', {
      pinned: true,
      auto: {
        enabled: true,
        min: 2,
        max: 5,
        metrics: [{ metric: 'cpu_pct', out_above: 70, in_below: 30 }]
      }
    })
    expect(ok.statusCode).toBe(200)
    const web = ok.json().data.roles.find((r: { role: string }) => r.role === 'web')
    expect(web).toMatchObject({ pinned: true, auto: { enabled: true, min: 2, max: 5 } })
    expect(m.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'nivaro_hub_scale_roles',
        changed_fields: ['pinned', 'auto']
      })
    )
  })

  it('sets a database server’s connection limit', async () => {
    expect((await call('PUT', '/scale/db-servers/1', { max_connections: 0 })).statusCode).toBe(400)
    expect((await call('PUT', '/scale/db-servers/9', { max_connections: 10 })).statusCode).toBe(404)
    expect((await call('PUT', '/scale/db-servers/1', { max_connections: 500 })).statusCode).toBe(
      200
    )
    const list = await call('GET', '/scale/db-servers')
    expect(list.json().data).toEqual([
      expect.objectContaining({ id: 1, name: 'sql1', max_connections: 500 })
    ])
    expect((await call('PUT', '/scale/db-servers/1', { max_connections: null })).statusCode).toBe(
      200
    )
  })

  it('runs: 404 for an unknown one, cancel only while running', async () => {
    expect((await call('GET', '/scale/runs/77')).statusCode).toBe(404)
    expect((await call('POST', '/scale/runs/77/cancel')).statusCode).toBe(404)
    expect((await call('GET', '/scale/runs?kind=environment&id=1')).json().data).toEqual([])
  })
})
