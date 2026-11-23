import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 ruling P6-32 (E2E A bug 3): the Hub's strict maintenance of one app was the plain
// Redis key `nvr:maintenance`, so every process on that Redis db (other apps with their own
// prefixes, the Hub, a shared deployment) read it as its own freeze. It is now keyed per app:
// `<prefix>nvr:maintenance:<hub-link tag>` on a hub-linked app, `<prefix>nvr:maintenance` on a
// shared deployment; Nivaro Cloud and a self-hosted process without HUB_TOKEN keep exactly
// `nvr:maintenance` (the EFP go-live chain writes it with redis-cli).

const st = vi.hoisted(() => ({ store: new Map<string, string>() }))
const redis = {
  get: async (k: string) => st.store.get(k) ?? null,
  set: async (k: string, v: string) => {
    st.store.set(k, v)
    return 'OK'
  },
  del: async (k: string) => (st.store.delete(k) ? 1 : 0)
}

vi.mock('../../../db/index.js', () => {
  const db = () => {
    const chain = {
      where: () => chain,
      first: async () => ({ maintenance_mode: false, maintenance_message: null }),
      catch: () => chain
    }
    return chain
  }
  return { db, _backgroundDb: null, _staticDb: null, resolveDb: () => db }
})
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => ({ redis }), getIo: () => null }))
vi.mock('../../../services/record-events.js', () => ({ announceToTenant: () => {} }))

const security = await import('../../../services/security.js')
const { runWithTenantDb } = await import('../../../db/tenant-context.js')

const TOKEN_A = 'a'.repeat(40)
const TOKEN_B = 'b'.repeat(40)
/** One Redis db, several processes: each "process" is the env it runs with. */
const APP_A = { HUB_TOKEN: TOKEN_A, REDIS_CHANNEL_PREFIX: 'e2e:alpha:' }
const APP_B = { HUB_TOKEN: TOKEN_B, REDIS_CHANNEL_PREFIX: 'e2e:beta:' }
const HUB_PROCESS = { REDIS_CHANNEL_PREFIX: 'e2e:hub:' } // HUB=on, no HUB_TOKEN
const SHARED = {
  HUB_SHARED_DEPLOYMENT: 'demo',
  HUB_URL: 'https://hub.example',
  HUB_DEPLOYMENT_TOKEN: 't'.repeat(40),
  REDIS_CHANNEL_PREFIX: 'e2e:demo:'
}
const CLOUD = { CLOUD_META_DB_URL: 'postgres://meta@127.0.0.1:1/meta' }
const PLAIN = {}

const KEYS = [
  'HUB_TOKEN',
  'REDIS_CHANNEL_PREFIX',
  'HUB_SHARED_DEPLOYMENT',
  'HUB_URL',
  'HUB_DEPLOYMENT_TOKEN',
  'CLOUD_META_DB_URL'
]
const saved = { ...process.env }

function as(env: Record<string, string>) {
  for (const k of KEYS) delete process.env[k]
  Object.assign(process.env, env)
  security.bustMaintenanceCache()
}

/** maintenanceState() as that process sees it (inside an app on a multi-tenant process). */
async function stateOf(env: Record<string, string>) {
  as(env)
  if (!env.HUB_SHARED_DEPLOYMENT && !env.CLOUD_META_DB_URL) return security.maintenanceState()
  return new Promise<Awaited<ReturnType<typeof security.maintenanceState>>>((resolve, reject) =>
    runWithTenantDb(
      {} as never,
      'gamma',
      () => void security.maintenanceState().then(resolve, reject),
      'gamma-e3'
    )
  )
}

beforeEach(() => st.store.clear())
afterEach(() => {
  process.env = { ...saved }
  security.bustMaintenanceCache()
})

describe('the key each process writes and reads', () => {
  it('per app on a hub-linked app (prefix + hub-link tag); per deployment on shared', () => {
    as(APP_A)
    const a = security.maintenanceOverrideKey()
    as(APP_B)
    const b = security.maintenanceOverrideKey()
    expect(a).toMatch(/^e2e:alpha:nvr:maintenance:[0-9a-f]{16}$/)
    expect(b).toMatch(/^e2e:beta:nvr:maintenance:[0-9a-f]{16}$/)
    expect(a).not.toBe(b)
    // same prefix, different token: still two keys
    expect(security.maintenanceOverrideKey({ HUB_TOKEN: TOKEN_A } as never)).not.toBe(
      security.maintenanceOverrideKey({ HUB_TOKEN: TOKEN_B } as never)
    )
    as(SHARED)
    expect(security.maintenanceOverrideKey()).toBe('e2e:demo:nvr:maintenance')
  })

  it('Nivaro Cloud and a self-hosted process without HUB_TOKEN keep exactly nvr:maintenance', () => {
    as(CLOUD)
    expect(security.maintenanceOverrideKey()).toBe('nvr:maintenance')
    as({ ...CLOUD, REDIS_CHANNEL_PREFIX: 'x:', HUB_TOKEN: TOKEN_A })
    expect(security.maintenanceOverrideKey()).toBe('nvr:maintenance')
    as(PLAIN)
    expect(security.maintenanceOverrideKey()).toBe('nvr:maintenance')
    as({ REDIS_CHANNEL_PREFIX: 'efp:' })
    expect(security.maintenanceOverrideKey()).toBe('nvr:maintenance')
  })
})

describe('one Redis db, several apps', () => {
  it('maintenance on app A leaves app B, the Hub and a shared deployment serving', async () => {
    as(APP_A)
    await security.setHubMaintenance({ on: true, moveId: 9999 })
    expect(st.store.has('nvr:maintenance')).toBe(false)
    expect(await stateOf(APP_A)).toMatchObject({ on: true, strict: true, hub: true })
    expect((await stateOf(APP_B)).on).toBe(false)
    expect((await stateOf(HUB_PROCESS)).on).toBe(false)
    expect((await stateOf(SHARED)).on).toBe(false)
    expect((await stateOf(PLAIN)).on).toBe(false)
    // and the release lifts A only
    as(APP_B)
    await security.setHubMaintenance({ on: true, moveId: 10 })
    as(APP_A)
    await security.setHubMaintenance({ on: false, moveId: 9999 })
    expect((await stateOf(APP_A)).on).toBe(false)
    expect((await stateOf(APP_B)).on).toBe(true)
  })

  it('boot maintenance lands in the app key too', async () => {
    as(APP_A)
    expect(
      await security.applyHubBootMaintenance(redis, { ...process.env, HUB_BOOT_MAINTENANCE: '12' })
    ).toBe(true)
    expect(st.store.has('nvr:maintenance')).toBe(false)
    expect((await stateOf(APP_A)).strict).toBe(true)
    expect((await stateOf(APP_B)).on).toBe(false)
  })

  it("an admin's End maintenance on B never touches A's freeze", async () => {
    as(APP_A)
    await security.setHubMaintenance({ on: true, moveId: 3 })
    as(APP_B)
    await security.clearMaintenanceOverride()
    expect((await stateOf(APP_A)).on).toBe(true)
  })
})

describe("an operator's plain nvr:maintenance (go-live scripts)", () => {
  it('still freezes a self-hosted process, and a hub-linked app (non-strict, admins exempt)', async () => {
    st.store.set('nvr:maintenance', JSON.stringify({ on: true, message: 'Rebuild' }))
    expect(await stateOf(PLAIN)).toMatchObject({ on: true, message: 'Rebuild' })
    const a = await stateOf(APP_A)
    expect(a).toMatchObject({ on: true, message: 'Rebuild' })
    expect(a.strict).toBeUndefined()
    // an admin's End maintenance on the hub-linked app clears it, as before
    as(APP_A)
    await security.clearMaintenanceOverride()
    expect(st.store.has('nvr:maintenance')).toBe(false)
  })

  it("a Hub freeze an older version left in the plain key is not another app's freeze", async () => {
    st.store.set(
      'nvr:maintenance',
      JSON.stringify({ on: true, strict: true, hub: true, move_id: 44, set_by: 'hub' })
    )
    expect((await stateOf(APP_B)).on).toBe(false)
    // the move it belongs to lifts it on release (an app upgraded mid-move is not stuck)
    as(APP_A)
    await security.setHubMaintenance({ on: false, moveId: 45 })
    expect(st.store.has('nvr:maintenance')).toBe(true)
    await security.setHubMaintenance({ on: false, moveId: 44 })
    expect(st.store.has('nvr:maintenance')).toBe(false)
  })

  it('a shared deployment with no prefix keeps the old deployment-wide key (rule T7)', async () => {
    st.store.set('nvr:maintenance', JSON.stringify({ on: true, message: 'Platform upgrade' }))
    const { REDIS_CHANNEL_PREFIX: _p, ...noPrefix } = SHARED
    expect((await stateOf(noPrefix)).on).toBe(true)
    expect((await stateOf(SHARED)).on).toBe(false)
  })
})
