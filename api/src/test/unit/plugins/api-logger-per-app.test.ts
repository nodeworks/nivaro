import Fastify from 'fastify'
import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TenantRecord } from '../../../services/tenancy/types.js'

// Hub shared deployments, Task 6: the request log is buffered per app. Two apps A and B (copies:
// same paths, same user id) share one process; each flush writes A's rows into A's own
// nivaro_api_logs and B's into B's — whichever request or timer starts the flush — and the rows
// of an app that has left the deployment are dropped. Self-hosted keeps its one buffer.

const inserted = vi.hoisted(() => [] as Array<{ tenant: string; row: Record<string, unknown> }>)
const failFor = vi.hoisted(() => new Set<string>())

vi.mock('../../../db/index.js', async () => {
  const { getTenantId } = await import('../../../db/tenant-context.js')
  const db = () => {
    const builder = {
      insert: async (rows: Array<Record<string, unknown>>) => {
        for (const row of rows) inserted.push({ tenant: getTenantId() ?? '', row })
      },
      where: () => builder,
      delete: async () => 0
    }
    return builder
  }
  return { db }
})
// withTenant opens the app's pool; here the context alone is enough (the db above is a fake).
vi.mock('../../../db/tenant-context.js', async (orig) => {
  const real = await orig<typeof import('../../../db/tenant-context.js')>()
  return {
    ...real,
    withTenant: <T>(t: { id: string; slug: string }, fn: () => Promise<T>) => {
      if (failFor.has(t.id)) throw new Error(`no pool for ${t.id}`)
      return new Promise<T>((res, rej) => {
        real.runWithTenantDb({} as Knex, t.slug, () => void fn().then(res, rej), t.id)
      })
    }
  }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: async () => true }))
vi.mock('../../../services/chain-columns.js', () => ({ hasChainColumns: async () => false }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))
vi.mock('../../../services/traffic-taps/public-clients.js', () => ({ notePublicHit: vi.fn() }))

const { apiLoggerPlugin } = await import('../../../plugins/api-logger.js')
const { setTenantRegistryForTests } = await import('../../../services/tenancy/registry.js')
const { runWithTenantDb } = await import('../../../db/tenant-context.js')

const tenant = (id: string): TenantRecord => ({
  id,
  slug: id.toLowerCase(),
  name: `App ${id}`,
  status: 'active',
  dbClient: 'pg',
  dbConnection: `postgres://u@127.0.0.1:1/app_${id.toLowerCase()}`,
  poolMax: 1,
  hostnames: []
})

const SHARED: Record<string, string> = {
  HUB_SHARED_DEPLOYMENT: 'shared-a',
  HUB_URL: 'https://hub.example',
  HUB_DEPLOYMENT_TOKEN: 'x'.repeat(32)
}
const KEYS = ['CLOUD_META_DB_URL', ...Object.keys(SHARED)]
const saved = { ...process.env }

function useRegistry(list: TenantRecord[], withById = true) {
  setTenantRegistryForTests({
    source: 'hub',
    resolve: async () => null,
    listActive: async () => list,
    ...(withById ? { byId: async (id: string) => list.find((t) => t.id === id) ?? null } : {}),
    status: () => ({
      source: 'hub',
      count: list.length,
      loadedAt: null,
      stale: false,
      lastError: null
    })
  })
}

/** A process whose requests carry the app the tenant hook stamped (`?app=`) and run inside it,
 *  as the tenant middleware does (so a threshold flush starts inside that app). */
async function server() {
  const a = Fastify()
  a.addHook('onRequest', (req, _reply, done) => {
    const app = (req.query as { app?: string }).app
    ;(req as { user?: unknown }).user = { id: 'USER-1' }
    if (!app) return done()
    ;(req as unknown as { nvrTenantId?: string }).nvrTenantId = app
    runWithTenantDb({} as Knex, app.toLowerCase(), done, app)
  })
  await a.register(apiLoggerPlugin)
  a.get('/api/items/things', async () => ({ data: [] }))
  await a.ready()
  return a
}

beforeEach(() => {
  inserted.length = 0
  for (const k of KEYS) delete process.env[k]
})
afterEach(() => {
  setTenantRegistryForTests(null)
  process.env = { ...saved }
})

describe('request log per app on a shared deployment', () => {
  beforeEach(() => {
    Object.assign(process.env, SHARED)
  })

  it("each flush writes an app's rows into that app's database only", async () => {
    useRegistry([tenant('A'), tenant('B')])
    const a = await server()
    await a.inject({ method: 'GET', url: '/api/items/things?app=A' })
    await a.inject({ method: 'GET', url: '/api/items/things?app=B' })
    await a.inject({ method: 'GET', url: '/api/items/things?app=A' })
    await a.close() // flushes outside any app
    const by = (t: string) => inserted.filter((x) => x.tenant === t).map((x) => x.row.query)
    expect(by('A')).toEqual(['app=A', 'app=A'])
    expect(by('B')).toEqual(['app=B'])
    expect(inserted).toHaveLength(3)
  })

  it('finds the app on the active list when the registry has no byId', async () => {
    useRegistry([tenant('A'), tenant('B')], false)
    const a = await server()
    await a.inject({ method: 'GET', url: '/api/items/things?app=B' })
    await a.close()
    expect(inserted.map((x) => x.tenant)).toEqual(['B'])
  })

  it('a row with no app is never written, not even into the app whose flush carries it', async () => {
    const listed = vi.fn(async () => [tenant('A')])
    setTenantRegistryForTests({
      source: 'hub',
      resolve: async () => null,
      listActive: listed,
      byId: async (id: string) => (id === 'A' ? tenant('A') : null),
      status: () => ({ source: 'hub', count: 1, loadedAt: null, stale: false, lastError: null })
    })
    const a = await server()
    await a.inject({ method: 'GET', url: '/api/items/things?probe=no-app' })
    // A's 50th row fills its bucket: the threshold flush starts from A's request
    for (let i = 0; i < 50; i++) await a.inject({ method: 'GET', url: '/api/items/things?app=A' })
    await vi.waitFor(() => expect(inserted.length).toBe(50))
    await a.close()
    expect(inserted.every((x) => x.tenant === 'A' && x.row.query === 'app=A')).toBe(true)
    expect(inserted.some((x) => x.row.query === 'probe=no-app')).toBe(false)
  })

  it("one app's failing write never loses another app's rows", async () => {
    useRegistry([tenant('A'), tenant('B')])
    failFor.add('A')
    const a = await server()
    await a.inject({ method: 'GET', url: '/api/items/things?app=A' })
    await a.inject({ method: 'GET', url: '/api/items/things?app=B' })
    await a.close()
    failFor.clear()
    expect(inserted.map((x) => x.tenant)).toEqual(['B'])
  })

  it('drops the rows of an app that left the deployment; the others still land', async () => {
    useRegistry([tenant('A')])
    const a = await server()
    await a.inject({ method: 'GET', url: '/api/items/things?app=A' })
    await a.inject({ method: 'GET', url: '/api/items/things?app=GONE' })
    await a.close()
    expect(inserted.map((x) => x.tenant)).toEqual(['A'])
  })
})

describe('request log in Nivaro Cloud (unchanged)', () => {
  // Known: Cloud keeps its one process buffer, written in whatever context the flush runs in
  // (out of scope here). Pinned so the per-app buffers stay a shared-deployment change.
  it('one buffer, flushed in the current context; the registry is never asked', async () => {
    Object.assign(process.env, { CLOUD_META_DB_URL: 'postgres://meta/x' })
    const listed = vi.fn(async () => [tenant('A'), tenant('B')])
    setTenantRegistryForTests({
      source: 'cloud-meta',
      resolve: async () => null,
      listActive: listed,
      status: () => ({
        source: 'cloud-meta',
        count: 2,
        loadedAt: null,
        stale: false,
        lastError: null
      })
    })
    const a = await server()
    await a.inject({ method: 'GET', url: '/api/items/things?app=A' })
    await a.inject({ method: 'GET', url: '/api/items/things?app=B' })
    await a.close() // flushes outside any app
    expect(inserted.map((x) => x.tenant)).toEqual(['', ''])
    expect(listed).not.toHaveBeenCalled()
  })
})

describe('request log self-hosted', () => {
  it('one buffer, written where it always was', async () => {
    const a = await server()
    await a.inject({ method: 'GET', url: '/api/items/things' })
    await a.inject({ method: 'GET', url: '/api/items/things?app=A' })
    await a.close()
    expect(inserted.map((x) => x.tenant)).toEqual(['', ''])
  })
})
