import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  runWithoutTenant,
  runWithTenantDb,
  tenantOrigin,
  withTenant
} from '../../../db/tenant-context.js'

// Hub phase 6 parked wave (T14): tenantOrigin() fell back to the CLOUD canonical origin
// (`<slug>.<CLOUD_BASE_DOMAIN>`) for a tenant context opened without an origin. On a Hub shared
// deployment that is a Nivaro Cloud host, never the app's: there it now answers null (callers use
// the configured address). Nivaro Cloud is byte-identical: these tests pin its answers too.

const savedEnv = { ...process.env }
beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB_SHARED_DEPLOYMENT
  delete process.env.CLOUD_BASE_DOMAIN
})
afterEach(() => {
  process.env = { ...savedEnv }
})

const knexStub = {} as never

/** tenantOrigin() inside a context opened like a request (runWithTenantDb). */
function inRequest(slug: string, origin?: string): string | null {
  let seen: string | null = 'unset'
  runWithTenantDb(
    knexStub,
    slug,
    () => {
      seen = tenantOrigin()
    },
    `${slug}-id`,
    origin
  )
  return seen
}

/** tenantOrigin() inside a context opened like a job (withTenant), with or without an origin. */
async function inJob(slug: string, origin?: string): Promise<string | null> {
  const t = {
    id: `${slug}-id`,
    slug,
    dbClient: 'pg',
    dbConnection: `postgres://u:p@127.0.0.1:1/${slug}`,
    poolMax: null
  }
  return withTenant(t, async () => tenantOrigin(), origin)
}

describe('Nivaro Cloud (unchanged)', () => {
  beforeEach(() => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta@127.0.0.1:1/meta'
  })

  it('no origin: the canonical <slug>.<base> origin, as before', async () => {
    expect(inRequest('acme')).toBe('https://acme.nivaro.dev')
    expect(await inJob('acme')).toBe('https://acme.nivaro.dev')
    process.env.CLOUD_BASE_DOMAIN = 'example.test'
    expect(inRequest('Beta')).toBe('https://beta.example.test')
  })

  it('a verified origin wins', async () => {
    expect(inRequest('acme', 'https://crm.crm-corp.com')).toBe('https://crm.crm-corp.com')
    expect(await inJob('acme', 'https://acme.nivaro.dev')).toBe('https://acme.nivaro.dev')
  })

  it('cloud wins even with HUB_SHARED_DEPLOYMENT set by mistake', () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
    expect(inRequest('acme')).toBe('https://acme.nivaro.dev')
  })
})

describe('Hub shared deployment', () => {
  beforeEach(() => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
  })

  it('no origin: null, never the cloud canonical host', async () => {
    expect(inRequest('app-a')).toBeNull()
    expect(await inJob('app-a')).toBeNull()
  })

  it("the app's own origin, when the context carries it", async () => {
    expect(inRequest('app-a', 'https://a.example.com')).toBe('https://a.example.com')
    expect(await inJob('app-a', 'http://app-c.localhost:3141')).toBe('http://app-c.localhost:3141')
  })
})

describe('outside any tenant', () => {
  it('null on every deployment kind', () => {
    expect(runWithoutTenant(() => tenantOrigin())).toBeNull()
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
    expect(tenantOrigin()).toBeNull()
    process.env.CLOUD_META_DB_URL = 'postgres://meta@127.0.0.1:1/meta'
    expect(tenantOrigin()).toBeNull()
  })
})
