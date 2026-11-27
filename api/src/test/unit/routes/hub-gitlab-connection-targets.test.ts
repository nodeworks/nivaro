import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Gap G-A: a Hub GitLab target that uses a `gitlab` provider connection, seen from the
// connection routes (routes/hub-providers.ts) on a real in-memory SQLite with migrations 542,
// 544, 582 and 583 and the real gitlab adapter. The created apps' sync (syncTargetApps, the
// target token rotation path) is watched; its own behaviour is hub-create-run.test.ts's.

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
  const sign = async (req: FastifyRequest) => {
    const h = req.headers as Record<string, string | undefined>
    const id = h['x-user']
    if (!id) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id, status: 'active' } as never
    req.isAdmin = h['x-admin'] === '1'
    req.authMethod = 'session' as never
  }
  const admin = async (req: FastifyRequest) => {
    await sign(req)
    if (!req.isAdmin)
      throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'ADMIN_ONLY' })
  }
  return { requireAuth: vi.fn(sign), requireAdmin: vi.fn(admin), authenticate: vi.fn(sign) }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))

const sync = vi.hoisted(() => ({
  calls: [] as Array<{ targetId: number; opts: Record<string, unknown> }>
}))
vi.mock('../../../services/hub/create/steps.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncTargetApps: vi.fn(async (targetId: number, opts: Record<string, unknown>) => {
    sync.calls.push({ targetId, opts })
    return [{ app_id: 1, ok: true, driver_token: 'updated' }]
  })
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const migrations = [
  await import('../../../db/migrations/542_hub_tables.js'),
  await import('../../../db/migrations/544_hub_databases.js'),
  await import('../../../db/migrations/582_hub_providers.js'),
  await import('../../../db/migrations/583_hub_provider_hooks.js')
]
const { hubProviderRoutes } = await import('../../../routes/hub-providers.js')
const { installHubCredentialGate } = await import('../../../services/hub/api/gate.js')
const registry = await import('../../../services/hub/providers/registry.js')
const { gitlabAdapter } = await import('../../../services/hub/providers/gitlab/index.js')
const store = await import('../../../services/hub/providers/store.js')
const { openSecret } = await import('../../../services/hub/secrets.js')
const T = await import('../../../services/hub/create/targets.js')

const ADMIN = 'AAAAAAAA-0000-4000-8000-000000000001'
const admin = { 'x-user': ADMIN, 'x-admin': '1' }
const TOKEN = 'test-secret-gitlab-token-0001'
const TOKEN2 = 'test-secret-gitlab-token-0002'

const targetConfig = {
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

function inject(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({ method, url: `/api/hub${url}`, payload: payload as never, headers: admin })
}

async function connectionWithTarget() {
  const res = await inject('POST', '/connections', {
    provider: 'gitlab',
    name: 'GitLab apps',
    config: { baseUrl: 'https://gitlab.example.com', groupPath: 'apps' },
    secrets: { token: TOKEN }
  })
  expect(res.statusCode).toBe(201)
  const conn = res.json().data as { id: number }
  await db('nivaro_hub_targets').insert({
    kind: 'gitlab',
    name: 'Apps on swarm 1',
    config: JSON.stringify(targetConfig),
    secret: null,
    connection_id: conn.id
  })
  const target = (await db('nivaro_hub_targets').max('id as id').first()) as { id: number }
  return { conn, targetId: Number(target.id) }
}

beforeAll(async () => {
  prevHub = process.env.HUB
  prevKey = process.env.ENCRYPTION_KEY
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = 'c'.repeat(64)
  for (const m of migrations) await m.up(db)
  app = Fastify()
  installHubCredentialGate(app)
  await app.register(hubProviderRoutes, { prefix: '/api/hub' })
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
beforeEach(async () => {
  registry.resetProvidersForTest()
  registry.registerProvider(gitlabAdapter)
  for (const t of ['nivaro_hub_targets', 'nivaro_hub_connections']) await db(t).del()
  sync.calls = []
})

describe('a GitLab target that uses a gitlab connection (G-A)', () => {
  it('reads the address and a sealed copy of the token from the connection', async () => {
    const { targetId } = await connectionWithTarget()
    const row = await T.getTargetRow(targetId)
    expect(row?.config.api).toBe('https://gitlab.example.com')
    expect(openSecret(row?.secret ?? null)).toBe(TOKEN)
    // A list never opens the token, and the public shape never carries it.
    const listed = (await T.listTargets()).find((t) => t.id === targetId)
    expect(listed?.secret).toBeNull()
    const pub = T.publicTarget(row as never)
    expect(pub).toMatchObject({ secret: null, connection: { name: 'GitLab apps', problem: null } })
    expect(JSON.stringify(pub)).not.toContain(TOKEN)
  })

  it('a new token on the connection re-syncs the targets that use it', async () => {
    const { conn, targetId } = await connectionWithTarget()
    const res = await inject('PATCH', `/connections/${conn.id}`, { secrets: { token: TOKEN2 } })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain(TOKEN)
    expect(res.body).not.toContain(TOKEN2)
    expect(res.json().target_sync).toEqual([
      { target_id: targetId, sync: [{ app_id: 1, ok: true, driver_token: 'updated' }] }
    ])
    expect(sync.calls).toHaveLength(1)
    const { targetId: called, opts } = sync.calls[0]
    expect(called).toBe(targetId)
    // The shared rotation path gets the PREVIOUS token and address.
    expect(openSecret(opts.previousSecret as string)).toBe(TOKEN)
    expect(opts.previousApi).toBe('https://gitlab.example.com')
    expect(await store.openConnectionSecrets({ id: conn.id })).toEqual({ token: TOKEN2 })
    // A rename touches nothing a target uses: no sync.
    const renamed = await inject('PATCH', `/connections/${conn.id}`, { name: 'Renamed' })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json()).not.toHaveProperty('target_sync')
    expect(sync.calls).toHaveLength(1)
  })

  it('a host change without the token again is refused; with it, the targets follow', async () => {
    const { conn, targetId } = await connectionWithTarget()
    const refused = await inject('PATCH', `/connections/${conn.id}`, {
      config: { baseUrl: 'https://gitlab2.example.com' }
    })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().code).toBe('SECRET_REQUIRED_ON_HOST_CHANGE')
    expect((await store.readConnection(conn.id))?.config.baseUrl).toBe('https://gitlab.example.com')
    expect(sync.calls).toHaveLength(0)
    const ok = await inject('PATCH', `/connections/${conn.id}`, {
      config: { baseUrl: 'https://gitlab2.example.com' },
      secrets: { token: TOKEN }
    })
    expect(ok.statusCode).toBe(200)
    expect(sync.calls.map((c) => c.targetId)).toEqual([targetId])
    expect(sync.calls[0].opts.previousApi).toBe('https://gitlab.example.com')
    expect((await T.getTargetRow(targetId))?.config.api).toBe('https://gitlab2.example.com')
  })

  it('a pinned group that would leave a target outside is refused', async () => {
    const { conn } = await connectionWithTarget()
    const res = await inject('PATCH', `/connections/${conn.id}`, {
      config: { groupPath: 'other' }
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('CONNECTION_IN_USE')
    expect((await store.readConnection(conn.id))?.config.groupPath).toBe('apps')
  })

  it('delete is refused while a target names the connection, then works', async () => {
    const { conn, targetId } = await connectionWithTarget()
    const busy = await inject('DELETE', `/connections/${conn.id}`)
    expect(busy.statusCode).toBe(409)
    expect(busy.json()).toMatchObject({ code: 'CONNECTION_IN_USE', details: { targets: 1 } })
    expect(await store.readConnection(conn.id)).not.toBeNull()
    await db('nivaro_hub_targets').where({ id: targetId }).del()
    expect((await inject('DELETE', `/connections/${conn.id}`)).statusCode).toBe(200)
  })

  it('a target whose connection is gone cannot be used and says why', async () => {
    const { conn, targetId } = await connectionWithTarget()
    await db('nivaro_hub_connections').where({ id: conn.id }).del()
    const row = await T.getTargetRow(targetId)
    expect(row?.secret).toBeNull()
    expect(row?.connection?.problem).toMatch(/gone/)
    const test = await T.testTarget(targetId)
    expect(test.ok).toBe(false)
    expect(test.checks[0]).toMatchObject({ id: 'connection', ok: false })
  })
})
