import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The origin a tenant is served on (cloud) is CANONICAL: the request host only when it is the
// tenant's own `<subdomain>.<CLOUD_BASE_DOMAIN>` or its active custom domain, else
// `https://<subdomain>.<base>` — also for work outside a request. Never PUBLIC_URL (the shared
// process's own address), never a host a caller made up.

const meta = vi.hoisted(() => ({
  rows: {
    acme: { id: 'T-ACME', slug: 'acme', subdomain: 'acme', name: 'Acme', status: 'active' },
    beta: { id: 'T-BETA', slug: 'beta', subdomain: 'beta', name: 'Beta', status: 'active' },
    crm: {
      id: 'T-CRM',
      slug: 'crmco',
      subdomain: 'crm',
      name: 'Crm Co',
      status: 'active',
      custom_domain: 'crm.crm-corp.com',
      custom_domain_status: 'active'
    },
    pend: {
      id: 'T-PEND',
      slug: 'pend',
      subdomain: 'pend',
      name: 'Pend',
      status: 'active',
      custom_domain: 'pend.example.org',
      custom_domain_status: 'pending'
    },
    susp: { id: 'T-SUSP', slug: 'susp', subdomain: 'susp', name: 'Susp', status: 'suspended' }
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
          return r
            ? { ...r, db_client: 'pg', db_connection_string: `postgres://${sub}` }
            : undefined
        }
      }
      return b
    }
    return conn
  })
}))
vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../admin-base.js', () => ({ adminBaseUrl: () => 'https://shared-process.example' }))

const { cleanTenantHost, getTenantOrigin, runWithTenantDb, tenantOrigin, verifiedTenantOrigin } =
  await import('../../../db/tenant-context.js')
const { tenantHook, resolveReadyTenant } = await import('../../../middleware/tenant.js')
const { instanceOrigin } = await import('../../../services/phone-push.js')

const inTenant = <T>(slug: string, origin: string | undefined, fn: () => Promise<T>) =>
  new Promise<T>((resolve, reject) =>
    runWithTenantDb({} as never, slug, () => void fn().then(resolve, reject), 'tid', origin)
  )

afterEach(() => {
  delete process.env.CLOUD_META_DB_URL
  delete process.env.CLOUD_BASE_DOMAIN
})

/** A cloud app with the tenant hook, answering the origin the request's context carries. */
async function hookApp() {
  process.env.CLOUD_META_DB_URL = 'postgres://meta'
  const app = Fastify()
  app.addHook('onRequest', tenantHook)
  const where = async (req: unknown) => ({
    origin: getTenantOrigin() ?? null,
    block: (req as { nvrTenantBlock?: unknown }).nvrTenantBlock ?? null
  })
  app.get('/api/where', where)
  app.get('/api/app-info', where)
  await app.ready()
  return app
}

describe('cleanTenantHost', () => {
  it('first of a list, lower case, a host name (with port) only', () => {
    expect(cleanTenantHost('Acme.Nivaro.dev, proxy.internal')).toBe('acme.nivaro.dev')
    expect(cleanTenantHost('acme.nivaro.dev:8443')).toBe('acme.nivaro.dev:8443')
    for (const bad of [undefined, '', 'a b', 'evil.example/path', 'x@y', 'h:99999x'])
      expect(cleanTenantHost(bad)).toBeNull()
  })
})

describe('verifiedTenantOrigin', () => {
  const acme = { slug: 'acme', subdomain: 'acme' }
  it('the tenant’s own subdomain host is kept; anything else is the canonical origin', () => {
    expect(verifiedTenantOrigin('ACME.nivaro.dev', acme)).toBe('https://acme.nivaro.dev')
    expect(verifiedTenantOrigin('acme.attacker.example', acme)).toBe('https://acme.nivaro.dev')
    expect(verifiedTenantOrigin('beta.nivaro.dev', acme)).toBe('https://acme.nivaro.dev')
    expect(verifiedTenantOrigin(undefined, acme)).toBe('https://acme.nivaro.dev')
  })

  it('an active custom domain registered to the tenant is kept; a pending one is not', () => {
    const row = { slug: 'crmco', subdomain: 'crm', custom_domain: 'CRM.crm-corp.com' }
    expect(
      verifiedTenantOrigin('crm.crm-corp.com', { ...row, custom_domain_status: 'active' })
    ).toBe('https://crm.crm-corp.com')
    expect(
      verifiedTenantOrigin('crm.crm-corp.com', { ...row, custom_domain_status: 'pending' })
    ).toBe('https://crm.nivaro.dev')
  })

  it('CLOUD_BASE_DOMAIN moves the canonical host; a local base is served over http', () => {
    process.env.CLOUD_BASE_DOMAIN = 'cloud.example.com'
    expect(verifiedTenantOrigin('x.y', acme)).toBe('https://acme.cloud.example.com')
    process.env.CLOUD_BASE_DOMAIN = 'localhost:3055'
    expect(verifiedTenantOrigin('acme.localhost:3055', acme)).toBe('http://acme.localhost:3055')
  })
})

describe('the tenant hook', () => {
  it('stores the verified origin for the tenant’s own host and active custom domain', async () => {
    const app = await hookApp()
    const own = await app.inject({
      url: '/api/where',
      headers: { 'x-tenant-host': 'acme.nivaro.dev' }
    })
    expect(own.json().origin).toBe('https://acme.nivaro.dev')
    const custom = await app.inject({ url: '/api/where', headers: { host: 'crm.crm-corp.com' } })
    expect(custom.json().origin).toBe('https://crm.crm-corp.com')
    await app.close()
  })

  it('a made-up host that resolves to a tenant gets that tenant’s canonical origin', async () => {
    const app = await hookApp()
    const forged = await app.inject({
      url: '/api/where',
      headers: { 'x-tenant-host': 'acme.attacker.example' }
    })
    expect(forged.json().origin).toBe('https://acme.nivaro.dev')
    const pending = await app.inject({ url: '/api/where', headers: { host: 'pend.example.org' } })
    expect(pending.json().origin).toBe('https://pend.nivaro.dev')
    await app.close()
  })

  it('a blocked tenant’s probe carries the canonical origin too', async () => {
    const app = await hookApp()
    const r = await app.inject({
      url: '/api/app-info',
      headers: { 'x-tenant-host': 'susp.nivaro.dev' }
    })
    expect(r.json().block).toEqual({
      kind: 'suspended',
      name: 'Susp',
      origin: 'https://susp.nivaro.dev'
    })
    await app.close()
    expect((await resolveReadyTenant('acme.evil.example'))?.origin).toBe('https://acme.nivaro.dev')
  })
})

describe('tenantOrigin / instanceOrigin (the relay `instance`)', () => {
  it('cloud: one canonical origin per tenant, never the shared PUBLIC_URL', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    expect(await inTenant('acme', 'https://acme.nivaro.dev', () => instanceOrigin())).toBe(
      'https://acme.nivaro.dev'
    )
    expect(await inTenant('crmco', 'https://crm.crm-corp.com', () => instanceOrigin())).toBe(
      'https://crm.crm-corp.com'
    )
  })

  it('work outside a request (crons, flows, timers) gets the canonical origin, never ""', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    expect(await inTenant('acme', undefined, () => instanceOrigin())).toBe(
      'https://acme.nivaro.dev'
    )
    expect(await inTenant('acme', undefined, async () => tenantOrigin())).toBe(
      'https://acme.nivaro.dev'
    )
    expect(tenantOrigin()).toBeNull()
  })

  it('self-hosted: the admin base url, as before', async () => {
    expect(await instanceOrigin()).toBe('https://shared-process.example')
  })
})

describe('requestIssuer in cloud', () => {
  it('is the tenant’s verified origin, never the request host it was handed', async () => {
    const { requestIssuer } = await import('../../../services/request-origin.js')
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    const app = Fastify()
    app.addHook('onRequest', tenantHook)
    app.get('/api/iss', async (req) => ({ iss: requestIssuer(req) }))
    await app.ready()
    const own = await app.inject({
      url: '/api/iss',
      headers: { 'x-tenant-host': 'acme.nivaro.dev' }
    })
    expect(own.json().iss).toBe('https://acme.nivaro.dev')
    const forged = await app.inject({
      url: '/api/iss',
      headers: { 'x-tenant-host': 'acme.attacker.example' }
    })
    expect(forged.json().iss).toBe('https://acme.nivaro.dev')
    await app.close()
  })
})
