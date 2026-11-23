import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6, final review moves I-2 (ruling P6-37): the routes an open move refuses
// 409 MOVE_OPEN — environment PATCH of its placement, stack or names, promote plan and start
// (owners as well as admins), Docker Apply now and Restart. An interrupted move holds no lock,
// so only this check stops them. Same harness as hub-shared-guards.test.ts: real SQLite with the
// hub tables, mounted through hubRoutes; the agent and outbound HTTP are mocked.

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
const { sealSecret } = await import('../../../services/hub/secrets.js')

const asAdmin = { 'x-user': 'AAAAAAAA-0000-4000-8000-000000000001', 'x-admin': '1' }
const OWNER = 'BBBBBBBB-0000-4000-8000-000000000002'
const asOwner = { 'x-user': OWNER }
const saved = { HUB: process.env.HUB, KEY: process.env.ENCRYPTION_KEY }
const ENV = 21
let app: FastifyInstance

const inject = (
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload: unknown,
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
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  for (const mig of migrations) await mig.up(db)
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
    'nivaro_hub_app_owners',
    'nivaro_hub_environments',
    'nivaro_hub_placements',
    'nivaro_hub_drivers',
    'nivaro_hub_moves'
  ])
    await db(t).del()
  await db('nivaro_hub_apps').insert({ id: 1, key: 'acme', name: 'Acme', extensions: '[]' })
  await db('nivaro_hub_app_owners').insert({ app_id: 1, user_id: OWNER })
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
    secret: sealSecret('agent-Token-Value-0123456789-abcdefghij')
  })
  await db('nivaro_hub_placements').insert([
    { id: 11, kind: 'dedicated', driver_id: 3, target: JSON.stringify({ stack: 'acme-dev' }) },
    { id: 12, kind: 'dedicated', driver_id: 3, target: JSON.stringify({ stack: 'acme-new' }) }
  ])
  await db('nivaro_hub_environments').insert({
    id: ENV,
    app_id: 1,
    key: 'dev',
    position: 0,
    status: 'active',
    base_url: 'https://acme-dev.apps.example.com',
    hostnames: '[]',
    placement_id: 11,
    version_pin: '0.3.210',
    hub_managed: true
  })
  await db('nivaro_hub_moves').insert({
    id: 7,
    app_id: 1,
    environment_id: ENV,
    from_placement_id: 11,
    to_placement_id: 12,
    kind: 'to_dedicated',
    routing: 'manual',
    status: 'interrupted',
    steps: '[]'
  })
})

const MOVE_TEXT = 'The move of acme/dev (move 7) is interrupted: resume it or roll it back first.'

describe('an open move refuses 409 MOVE_OPEN', () => {
  it('environment PATCH of placement, key, names, version pin or hub token', async () => {
    for (const payload of [
      { placement_id: 12 },
      { key: 'dev2' },
      { hostnames: ['dev.acme.example.com'] },
      { base_url: 'https://dev.acme.example.com' },
      { version_pin: '0.3.211' },
      { hub_token: 'hub-link-Token-Value-0123456789-abcdefghij' }
    ]) {
      const res = await inject('PATCH', `/environments/${ENV}`, payload)
      expect(res.statusCode, JSON.stringify(payload)).toBe(409)
      expect(res.json()).toMatchObject({ code: 'MOVE_OPEN', error: MOVE_TEXT })
    }
    const env = await db('nivaro_hub_environments').where({ id: ENV }).first()
    expect(env).toMatchObject({ key: 'dev', placement_id: 11, version_pin: '0.3.210' })
    // A field the move does not rely on still saves.
    const ok = await inject('PATCH', `/environments/${ENV}`, { position: 3 })
    expect(ok.statusCode).toBe(200)
  })

  it('promote plan and start — for an owner as well as an admin', async () => {
    for (const headers of [asAdmin, asOwner]) {
      const plan = await inject(
        'POST',
        `/environments/${ENV}/promote/plan`,
        { kind: 'promote', version: '0.3.211' },
        headers
      )
      expect(plan.statusCode).toBe(409)
      expect(plan.json()).toMatchObject({ code: 'MOVE_OPEN', error: MOVE_TEXT })
      const start = await inject(
        'POST',
        `/environments/${ENV}/promote`,
        { kind: 'promote', version: '0.3.211', confirm: 'dev', plan_hash: 'x' },
        headers
      )
      expect(start.statusCode).toBe(409)
      expect(start.json()).toMatchObject({ code: 'MOVE_OPEN', error: MOVE_TEXT })
    }
  })

  it('Docker Apply now and Restart; nothing reaches the agent', async () => {
    for (const url of [`/environments/${ENV}/stack/apply`, `/environments/${ENV}/stack/restart`]) {
      const res = await inject('POST', url, { confirm: 'dev' })
      expect(res.statusCode, url).toBe(409)
      expect(res.json(), url).toMatchObject({ code: 'MOVE_OPEN', error: MOVE_TEXT })
    }
    expect(m.agentStack).not.toHaveBeenCalled()
  })

  it('once the move has ended the same requests are judged as before', async () => {
    await db('nivaro_hub_moves').where({ id: 7 }).update({ status: 'rolled_back' })
    const res = await inject('PATCH', `/environments/${ENV}`, {
      hostnames: ['dev.acme.example.com']
    })
    expect(res.json().code).not.toBe('MOVE_OPEN')
    const restart = await inject('POST', `/environments/${ENV}/stack/restart`, { confirm: 'dev' })
    expect(restart.json().code).not.toBe('MOVE_OPEN')
  })
})

describe('re-review FW1-M-1 / FW1-M-2', () => {
  it('M-1: stack remove with its volumes → 409 MOVE_OPEN; a plain remove still reaches the agent', async () => {
    const res = await inject('POST', `/environments/${ENV}/stack/remove`, {
      confirm: 'acme-dev',
      remove_volumes: true,
      confirm_volumes: 'delete acme-dev data'
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'MOVE_OPEN', error: MOVE_TEXT })
    expect(m.agentStack).not.toHaveBeenCalled()
    expect(m.agentLeftovers).not.toHaveBeenCalled()
    const plain = await inject('POST', `/environments/${ENV}/stack/remove`, { confirm: 'acme-dev' })
    expect(plain.json().code).not.toBe('MOVE_OPEN')
    expect(m.agentStack).toHaveBeenCalled()
  })
})
