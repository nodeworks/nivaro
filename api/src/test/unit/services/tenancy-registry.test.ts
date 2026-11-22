import knex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))

import { getOrCreateTenantPool, getTenantDb, withTenant } from '../../../db/tenant-context.js'
import { cloudMetaSource, setMetaDbForTests } from '../../../services/tenancy/cloud-meta-source.js'
import { getTenantRegistry, setTenantRegistryForTests } from '../../../services/tenancy/registry.js'

let meta: Knex

beforeEach(async () => {
  meta = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true
  })
  await meta.schema.createTable('cloud_tenants', (t) => {
    t.string('id')
    t.string('slug')
    t.string('subdomain')
    t.string('name')
    t.string('status')
    t.string('db_client')
    t.string('db_connection_string')
    t.string('custom_domain')
    t.string('custom_domain_status')
  })
  await meta('cloud_tenants').insert([
    {
      id: 'T1',
      slug: 'acme',
      subdomain: 'acme',
      name: 'Acme',
      status: 'active',
      db_client: 'pg',
      db_connection_string: 'postgres://acme'
    },
    {
      id: 'T2',
      slug: 'susp',
      subdomain: 'susp',
      name: 'Susp',
      status: 'suspended',
      db_client: 'pg',
      db_connection_string: 'postgres://susp'
    },
    {
      id: 'T3',
      slug: 'prov',
      subdomain: 'prov',
      name: 'Prov',
      status: 'provisioning',
      db_client: 'pg',
      db_connection_string: 'postgres://prov'
    },
    {
      id: 'T4',
      slug: 'crmco',
      subdomain: 'crm',
      name: 'Crm',
      status: 'active',
      db_client: 'pg',
      db_connection_string: 'postgres://crm',
      custom_domain: 'crm.crm-corp.com',
      custom_domain_status: 'active'
    },
    {
      id: 'T5',
      slug: 'pend',
      subdomain: 'pend',
      name: 'Pend',
      status: 'active',
      db_client: 'pg',
      db_connection_string: 'postgres://pend',
      custom_domain: 'pend.example.org',
      custom_domain_status: 'pending'
    }
  ])
  setMetaDbForTests(meta)
})

afterEach(async () => {
  setMetaDbForTests(null)
  setTenantRegistryForTests(null)
  delete process.env.CLOUD_META_DB_URL
  await meta.destroy()
})

describe('cloud meta source', () => {
  it('resolves an active tenant with its verified origin', async () => {
    const r = await cloudMetaSource().resolve('acme.nivaro.dev')
    expect(r?.origin).toBe('https://acme.nivaro.dev')
    expect(r?.tenant).toMatchObject({
      id: 'T1',
      slug: 'acme',
      status: 'active',
      dbClient: 'pg',
      dbConnection: 'postgres://acme',
      poolMax: null
    })
  })

  it('suspended and provisioning rows come back with their status', async () => {
    const s = cloudMetaSource()
    expect((await s.resolve('susp.nivaro.dev'))?.tenant.status).toBe('suspended')
    expect((await s.resolve('prov.nivaro.dev'))?.tenant.status).toBe('provisioning')
  })

  it('reserved and unknown hosts resolve to null', async () => {
    const s = cloudMetaSource()
    expect(await s.resolve('www.nivaro.dev')).toBeNull()
    expect(await s.resolve('nobody.nivaro.dev')).toBeNull()
  })

  it('a meta database error resolves to null, never throws', async () => {
    await meta.schema.dropTable('cloud_tenants')
    expect(await cloudMetaSource().resolve('acme.nivaro.dev')).toBeNull()
  })

  it('custom domains follow verifiedTenantOrigin', async () => {
    const s = cloudMetaSource()
    expect((await s.resolve('crm.nivaro.dev', 'crm.crm-corp.com'))?.origin).toBe(
      'https://crm.crm-corp.com'
    )
    expect((await s.resolve('pend.nivaro.dev', 'pend.example.org'))?.origin).toBe(
      'https://pend.nivaro.dev'
    )
    expect((await s.resolve('crm.nivaro.dev', 'evil.example'))?.origin).toBe(
      'https://crm.nivaro.dev'
    )
    expect((await s.resolve('acme.attacker.example'))?.origin).toBe('https://acme.nivaro.dev')
  })

  it('listActive returns active tenants only and updates status()', async () => {
    const s = cloudMetaSource()
    const list = await s.listActive()
    expect(list.map((t) => t.slug).sort()).toEqual(['acme', 'crmco', 'pend'])
    expect(s.status()).toMatchObject({
      source: 'cloud-meta',
      count: 3,
      stale: false,
      lastError: null
    })
  })
})

describe('withTenant', () => {
  it('runs fn inside the tenant context and leaves it afterwards', async () => {
    const t = {
      id: 'T1',
      slug: 'acme',
      dbClient: 'pg',
      dbConnection: 'postgres://withtenant',
      poolMax: null
    }
    const seen = await withTenant(t, async () => getTenantDb())
    expect(seen).toBeDefined()
    expect(getTenantDb()).toBeUndefined()
  })
})

describe('getOrCreateTenantPool', () => {
  it('defaults to max 5, takes an explicit max, refuses sqlite', async () => {
    const a = getOrCreateTenantPool('postgres://pool-a', 'pg')
    const b = getOrCreateTenantPool('postgres://pool-b', 'pg', 12)
    expect((a.client as any).pool.max).toBe(5)
    expect((b.client as any).pool.max).toBe(12)
    expect(() => getOrCreateTenantPool('x', 'sqlite3')).toThrow()
    await a.destroy()
    await b.destroy()
  })
})

describe('getTenantRegistry', () => {
  it('is null without the cloud env and the cloud source with it', () => {
    delete process.env.CLOUD_META_DB_URL
    expect(getTenantRegistry()).toBeNull()
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    expect(getTenantRegistry()?.source).toBe('cloud-meta')
  })
})
