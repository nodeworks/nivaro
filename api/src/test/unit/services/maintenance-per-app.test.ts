import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 5 Task 11 (carries from the Task 10 review, rule T7):
//  - "End maintenance" deleted the deployment-wide Redis key `nvr:maintenance`. On a
//    multi-tenant process one app's admin would end the operator's freeze for every app; there
//    it now ends only that app's own setting (the settings row the same PATCH writes).
//  - maintenance-live re-reads busted EVERY tenant's cached state; it now busts only the tenant
//    it reads.

const state = vi.hoisted(() => ({
  reads: new Map<string, number>(),
  on: new Map<string, boolean>(),
  redis: {
    get: async (_k: string) => null as string | null,
    del: async (_k: string) => 1
  }
}))

vi.mock('../../../db/index.js', async () => {
  const tc = await import('../../../db/tenant-context.js')
  const db = () => {
    const tenant = tc.getTenantId() ?? ''
    const chain = {
      where: () => chain,
      first: async () => {
        state.reads.set(tenant, (state.reads.get(tenant) ?? 0) + 1)
        return { maintenance_mode: state.on.get(tenant) ?? false, maintenance_message: null }
      },
      catch: () => chain
    }
    return chain
  }
  return { db, _backgroundDb: null, _staticDb: null, resolveDb: () => db }
})
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => ({ redis: state.redis }) }))
vi.mock('../../../services/record-events.js', () => ({ announceToTenant: () => {} }))

const security = await import('../../../services/security.js')
const live = await import('../../../services/maintenance-live.js')
const { runWithTenantDb } = await import('../../../db/tenant-context.js')

function asApp<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    runWithTenantDb(
      {} as never,
      id.toLowerCase(),
      () => void Promise.resolve().then(fn).then(resolve, reject),
      id
    )
  })
}

const saved = { ...process.env }
beforeEach(() => {
  state.reads.clear()
  state.on.clear()
  security.bustMaintenanceCache()
  live._resetMaintenanceLive()
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB_SHARED_DEPLOYMENT
})
afterEach(() => {
  live.stopMaintenanceWatch()
  vi.restoreAllMocks()
  process.env = { ...saved }
})

describe('End maintenance never clears the deployment-wide key on a multi-tenant process', () => {
  it('self-hosted: clears nvr:maintenance as before', async () => {
    const del = vi.spyOn(state.redis, 'del')
    await security.clearMaintenanceOverride()
    expect(del).toHaveBeenCalledWith('nvr:maintenance')
  })

  for (const [label, env] of [
    ['shared deployment', { HUB_SHARED_DEPLOYMENT: 'shared-1' }],
    ['cloud', { CLOUD_META_DB_URL: 'mssql://meta' }]
  ] as const) {
    it(`${label}: an app admin's End maintenance leaves the deployment key alone`, async () => {
      Object.assign(process.env, env)
      const del = vi.spyOn(state.redis, 'del')
      await asApp('A', () => security.clearMaintenanceOverride())
      expect(del).not.toHaveBeenCalled()
    })
  }

  it('shared: the operator freeze still holds for the app after its admin ends maintenance', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
    vi.spyOn(state.redis, 'get').mockImplementation(async (k: string) =>
      k === 'nvr:maintenance' ? JSON.stringify({ on: true, message: 'Platform upgrade' }) : null
    )
    await asApp('A', () => security.clearMaintenanceOverride())
    const s = await asApp('A', () => security.maintenanceState())
    expect(s).toMatchObject({ on: true, source: 'override', message: 'Platform upgrade' })
  })
})

describe('busting the maintenance cache per tenant', () => {
  it('bustMaintenanceCache(tenant) forgets that tenant only; no argument forgets all', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
    await asApp('A', () => security.maintenanceState())
    await asApp('B', () => security.maintenanceState())
    security.bustMaintenanceCache('A')
    await asApp('A', () => security.maintenanceState())
    await asApp('B', () => security.maintenanceState())
    expect(state.reads.get('A')).toBe(2)
    expect(state.reads.get('B')).toBe(1)
    security.bustMaintenanceCache()
    await asApp('B', () => security.maintenanceState())
    expect(state.reads.get('B')).toBe(2)
  })

  it('maintenance-live re-reads bust only the tenant being read', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
    await asApp('A', () => security.maintenanceState())
    await asApp('B', () => security.maintenanceState())
    await asApp('A', () => live.recheckMaintenanceSoon())
    await new Promise((r) => setTimeout(r, 400))
    expect(state.reads.get('A')).toBe(2) // A's entry was forgotten and read again
    // B still answers from its own cache: nothing of B's was forgotten
    await asApp('B', () => security.maintenanceState())
    expect(state.reads.get('B')).toBe(1)
  })

  it('self-hosted watch: each tick busts the one self-hosted entry', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    try {
      state.on.set('', true)
      await security.maintenanceState()
      expect(live._maintenanceWatching()).toBe(true)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(state.reads.get('')).toBe(2) // inside the 15 s cache: read again only after a bust
    } finally {
      vi.useRealTimers()
    }
  })
})
