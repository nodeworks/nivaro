import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The origin a tenant is served on (cloud): the host its request arrived on, carried in the
// tenant context — never PUBLIC_URL, which is the shared process's own address.

const meta = vi.hoisted(() => ({
  rows: {
    acme: { id: 'T-ACME', slug: 'acme', name: 'Acme', status: 'active' },
    beta: { id: 'T-BETA', slug: 'beta', name: 'Beta', status: 'active' }
  } as Record<string, Record<string, string>>
}))

vi.mock('knex', () => ({
  default: vi.fn(() => {
    const conn = (_table: string) => {
      let sub = ''
      const b = {
        where: (w: { subdomain?: string }) => {
          sub = String(w.subdomain ?? '')
          return b
        },
        first: async () => {
          const r = meta.rows[sub]
          return r ? { ...r, db_client: 'pg', db_connection_string: `postgres://${sub}` } : undefined
        }
      }
      return b
    }
    return conn
  })
}))
vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../admin-base.js', () => ({ adminBaseUrl: () => 'https://shared-process.example' }))

const { cleanTenantHost, getTenantHost, runWithTenantDb, tenantOrigin } = await import(
  '../../../db/tenant-context.js'
)
const { tenantHook } = await import('../../../middleware/tenant.js')
const { instanceOrigin } = await import('../../../services/phone-push.js')
const { requestOrigin } = await import('../../../services/request-origin.js')

const inTenant = <T>(host: string | undefined, fn: () => Promise<T>) =>
  new Promise<T>((resolve, reject) =>
    runWithTenantDb({} as never, 'x', () => void fn().then(resolve, reject), 'tid', host)
  )

afterEach(() => {
  delete process.env.CLOUD_META_DB_URL
})

describe('the tenant host', () => {
  it('is cleaned: first of a list, lower case, a host name (with port) only', () => {
    expect(cleanTenantHost('Acme.Nivaro.dev, proxy.internal')).toBe('acme.nivaro.dev')
    expect(cleanTenantHost('acme.nivaro.dev:8443')).toBe('acme.nivaro.dev:8443')
    for (const bad of [undefined, '', 'a b', 'evil.example/path', 'x@y', 'h:99999x'])
      expect(cleanTenantHost(bad)).toBeNull()
  })

  it('tenantOrigin is https for a real host, http for a local one', async () => {
    expect(await inTenant('acme.nivaro.dev', async () => tenantOrigin())).toBe(
      'https://acme.nivaro.dev'
    )
    expect(await inTenant('acme.localhost:3055', async () => tenantOrigin())).toBe(
      'http://acme.localhost:3055'
    )
    expect(await inTenant(undefined, async () => tenantOrigin())).toBeNull()
    expect(tenantOrigin()).toBeNull()
  })

  it('the tenant hook stores the host the request arrived on', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    const app = Fastify()
    app.addHook('onRequest', tenantHook)
    app.get('/api/where', async () => ({ host: getTenantHost() ?? null }))
    await app.ready()
    const a = await app.inject({ url: '/api/where', headers: { 'x-tenant-host': 'acme.nivaro.dev' } })
    const b = await app.inject({ url: '/api/where', headers: { host: 'beta.customer-domain.com' } })
    expect(a.json()).toEqual({ host: 'acme.nivaro.dev' })
    expect(b.json()).toEqual({ host: 'beta.customer-domain.com' })
    await app.close()
  })
})

describe('instanceOrigin (the relay `instance`)', () => {
  it('cloud: the current tenant’s origin, one per tenant, never the shared PUBLIC_URL', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    expect(await inTenant('acme.nivaro.dev', () => instanceOrigin())).toBe(
      'https://acme.nivaro.dev'
    )
    expect(await inTenant('crm.beta-corp.com', () => instanceOrigin())).toBe(
      'https://crm.beta-corp.com'
    )
    // A tenant context with no host (work started outside a request) names no instance.
    expect(await inTenant(undefined, () => instanceOrigin())).toBe('')
  })

  it('self-hosted: the admin base url, as before', async () => {
    expect(await instanceOrigin()).toBe('https://shared-process.example')
  })
})

describe('requestOrigin', () => {
  it('self-hosted: the request’s own protocol + host (trusted-proxy rules)', async () => {
    const app = Fastify({ trustProxy: true })
    app.get('/o', async (req) => ({ o: requestOrigin(req) }))
    await app.ready()
    const plain = await app.inject({ url: '/o', headers: { host: 'a.example' } })
    expect(plain.json().o).toBe('http://a.example')
    const proxied = await app.inject({
      url: '/o',
      headers: { host: 'internal:3055', 'x-forwarded-host': 'b.example', 'x-forwarded-proto': 'https' }
    })
    expect(proxied.json().o).toBe('https://b.example')
    await app.close()
    // No trusted proxy: forwarded headers are ignored.
    const strict = Fastify()
    strict.get('/o', async (req) => ({ o: requestOrigin(req) }))
    await strict.ready()
    const r = await strict.inject({
      url: '/o',
      headers: { host: 'a.example:8080', 'x-forwarded-host': 'evil.example' }
    })
    expect(r.json().o).toBe('http://a.example:8080')
    await strict.close()
  })

  it('cloud: the tenant’s origin', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    const app = Fastify()
    app.addHook('onRequest', tenantHook)
    app.get('/api/o', async (req) => ({ o: requestOrigin(req) }))
    await app.ready()
    const r = await app.inject({ url: '/api/o', headers: { 'x-tenant-host': 'acme.nivaro.dev' } })
    expect(r.json().o).toBe('https://acme.nivaro.dev')
    await app.close()
  })
})
