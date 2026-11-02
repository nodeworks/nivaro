import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// POST /admin/push-relay: cloud provisioning stores a tenant's push relay key + url in that
// tenant's database. The key is never echoed or logged; a stored url beats the env default;
// cloud mode never sends with the env key.

const h = vi.hoisted(() => ({
  /** The tenant database's nivaro_settings_overrides.data (one instance row). */
  tenantData: null as string | null,
  connections: [] as Array<{ client: string; connection: string }>,
  destroyed: 0
}))

/** A tenant database: one overrides row, read and written like the store does. */
const tenantDb = () => {
  const conn = ((table: string) => {
    const b: Record<string, unknown> = {
      where: () => b,
      first: async () =>
        table === 'nivaro_settings_overrides' && h.tenantData
          ? { id: 1, data: h.tenantData }
          : undefined,
      update: async (v: { data: string }) => {
        h.tenantData = v.data
        return 1
      },
      insert: async (v: { data: string }) => {
        h.tenantData = v.data
        return [1]
      }
    }
    return b
  }) as unknown as Record<string, unknown>
  conn.destroy = async () => {
    h.destroyed++
  }
  return conn
}

vi.mock('knex', () => ({
  default: vi.fn((cfg: { client: string; connection: string }) => {
    h.connections.push({ client: cfg.client, connection: cfg.connection })
    return tenantDb()
  })
}))
// The request's own database is that same tenant here (as it is on the tenant's next request).
vi.mock('../../db/index.js', () => ({ db: tenantDb(), migrationSource: {} }))
vi.mock('../../lib/ssrf.js', () => ({ safeFetch: vi.fn() }))

const { adminProvisionRoutes } = await import('./provision.js')
const { pushRelayConfig } = await import('../../services/push-relay.js')
const { maskLoggedBody } = await import('../../plugins/api-logger.js')

const SECRET = 'provision-secret-for-tests-0123456789'
const KEY = 'rk_live_tenant_secret_value_abcdef'
const logs: string[] = []
let app: FastifyInstance

beforeAll(async () => {
  process.env.PROVISION_SECRET = SECRET
  app = Fastify({
    logger: { level: 'trace', stream: { write: (line: string) => logs.push(line) } }
  })
  await app.register(adminProvisionRoutes)
  await app.ready()
})
afterAll(async () => {
  await app.close()
  delete process.env.PROVISION_SECRET
})
beforeEach(() => {
  h.tenantData = JSON.stringify({ chaos: { a: 1 } })
  h.connections = []
  h.destroyed = 0
  logs.length = 0
  delete process.env.MOBILE_PUSH_RELAY_KEY
  delete process.env.MOBILE_PUSH_RELAY_URL
  delete process.env.CLOUD_META_DB_URL
})

const body = (over: Record<string, unknown> = {}) => ({
  connectionString: 'postgres://tenant-db',
  dbClient: 'pg',
  slug: 'acme',
  relay_key: KEY,
  relay_url: 'https://relay.cloud.example/',
  ...over
})
const call = (payload: Record<string, unknown>, secret: string | null = SECRET) =>
  app.inject({
    method: 'POST',
    url: '/admin/push-relay',
    headers: secret ? { 'x-provision-secret': secret } : {},
    payload
  })

describe('POST /admin/push-relay', () => {
  it('a wrong or missing secret → 401, nothing opened or stored', async () => {
    expect((await call(body(), 'wrong')).statusCode).toBe(401)
    expect((await call(body(), null)).statusCode).toBe(401)
    expect(h.connections).toEqual([])
    expect(h.tenantData).toBe(JSON.stringify({ chaos: { a: 1 } }))
  })

  it('stores the key and url in the tenant database; the key is never echoed or logged', async () => {
    const res = await call(body())
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, relay_url: 'https://relay.cloud.example' })
    expect(res.body).not.toContain(KEY)
    expect(h.connections).toEqual([{ client: 'pg', connection: 'postgres://tenant-db' }])
    expect(h.destroyed).toBe(1)
    expect(JSON.parse(String(h.tenantData))).toEqual({
      chaos: { a: 1 },
      mobile_push: { relay_key: KEY, relay_url: 'https://relay.cloud.example' }
    })
    expect(logs.join('\n')).not.toContain(KEY)
    // A request log that kept the body would mask it too.
    expect(maskLoggedBody(JSON.stringify(body()))).not.toContain(KEY)
  })

  it('the stored url wins over the env url', async () => {
    process.env.MOBILE_PUSH_RELAY_URL = 'https://relay.env.example'
    await call(body())
    expect(await pushRelayConfig()).toMatchObject({
      url: 'https://relay.cloud.example',
      key: KEY
    })
  })

  it('cloud mode ignores the env key: the tenant sends with its stored key', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    process.env.MOBILE_PUSH_RELAY_KEY = 'env-key-must-not-be-used'
    expect((await pushRelayConfig()).key).toBeNull()
    await call(body())
    expect((await pushRelayConfig()).key).toBe(KEY)
  })

  it('refuses a missing key, a non-https url or a missing database, storing nothing', async () => {
    for (const over of [
      { relay_key: '' },
      { relay_key: 42 },
      { relay_url: 'http://relay.example' },
      { relay_url: undefined },
      { connectionString: '' },
      { connectionString: { host: 'x' } },
      { dbClient: 'sqlite3' },
      { dbClient: 7 },
      { slug: '' },
      { slug: undefined },
      { slug: { a: 1 } }
    ]) {
      const res = await call(body(over))
      expect(res.statusCode).toBe(400)
      expect(res.body).not.toContain(KEY)
    }
    expect(h.connections).toEqual([])
  })
})
