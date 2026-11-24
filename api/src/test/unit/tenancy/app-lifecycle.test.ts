import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub shared deployments: the app-ready / app-left hooks later per-app work hangs on.

vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: () => {} }))
const fireSpy = vi.fn()
vi.mock('../../../services/tenancy/app-lifecycle.js', async (orig) => {
  const real = await orig<typeof import('../../../services/tenancy/app-lifecycle.js')>()
  return {
    ...real,
    fireAppReady: (t: unknown) => {
      fireSpy(t)
      real.fireAppReady(t as never)
    }
  }
})

const lc = await import('../../../services/tenancy/app-lifecycle.js')
const m = await import('../../../services/tenancy/app-migrations.js')
const { currentTenantKey } = await import('../../../services/tenant-rooms.js')
type TenantRecord = import('../../../services/tenancy/types.js').TenantRecord

const rec = (id: string): TenantRecord => ({
  id,
  slug: id,
  name: id,
  status: 'active',
  dbClient: 'pg',
  dbConnection: `postgres://app_${id}:s@db.internal:5432/app_${id}`,
  poolMax: null,
  hostnames: [`${id}.example.com`]
})
const settle = () => new Promise((r) => setTimeout(r, 10))
const savedEnv = { ...process.env }
const deps = () => ({
  migrate: vi.fn(async () => [1, []] as [number, string[]]),
  schemaSteps: vi.fn(async () => ({ applied: [], skipped: [], failed: [] })),
  workspace: vi.fn(async () => {}),
  seeds: vi.fn(async () => {}),
  extensions: () => []
})

beforeEach(() => {
  lc._resetAppLifecycleForTests()
  m._resetAppMigrationsForTests()
  fireSpy.mockClear()
})
afterEach(() => {
  lc._resetAppLifecycleForTests()
  m._resetAppMigrationsForTests()
  process.env = { ...savedEnv }
})

describe('app lifecycle hooks', () => {
  it('runs a ready hook inside the app', async () => {
    const seen: string[] = []
    lc.onAppReady('x', () => {
      seen.push(currentTenantKey())
    })
    lc.fireAppReady(rec('A'))
    await settle()
    expect(seen).toEqual(['A'])
  })

  it('a throwing ready hook does not stop the next one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seen: string[] = []
    lc.onAppReady('a-bad', () => {
      throw new Error('boom')
    })
    lc.onAppReady('b-good', () => {
      seen.push(currentTenantKey())
    })
    lc.fireAppReady(rec('A'))
    await settle()
    expect(seen).toEqual(['A'])
  })

  it('re-registering a name replaces the hook', async () => {
    const first = vi.fn()
    const second = vi.fn()
    lc.onAppReady('x', first)
    lc.onAppReady('x', second)
    lc.fireAppReady(rec('A'))
    await settle()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('calls left hooks with the app id, one throwing does not stop the next', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const left = vi.fn()
    lc.onAppLeft('a-bad', () => {
      throw new Error('boom')
    })
    lc.onAppLeft('b-good', left)
    lc.fireAppLeft('A')
    expect(left).toHaveBeenCalledWith('A')
  })

  it('fires ready after migrations on a shared deployment, never otherwise', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
    process.env.HUB_URL = 'https://hub.example'
    process.env.HUB_DEPLOYMENT_TOKEN = 't'.repeat(40)
    await m.ensureAppSchema(rec('A'), deps())
    expect(fireSpy).toHaveBeenCalledTimes(1)
    expect(fireSpy.mock.calls[0]?.[0]).toMatchObject({ id: 'A' })

    fireSpy.mockClear()
    m._resetAppMigrationsForTests()
    delete process.env.HUB_SHARED_DEPLOYMENT
    delete process.env.HUB_URL
    delete process.env.HUB_DEPLOYMENT_TOKEN
    await m.ensureAppSchema(rec('A'), deps())
    expect(fireSpy).not.toHaveBeenCalled()
  })
})
