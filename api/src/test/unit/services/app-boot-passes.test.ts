import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentTenantKey } from '../../../services/tenant-rooms.js'

// Hub shared deployments: the boot passes that read or write an app's database (warms, the
// db-tuning twin sweep, the REST route inventory, extension registry versions, the portal-URL
// warning) run once per app when that app becomes ready, inside it. Self-hosted calls the same
// named passes inline from server.ts (its order and timers unchanged); Nivaro Cloud runs none.

const state = vi.hoisted(() => ({
  calls: [] as Array<{ pass: string; app: string }>,
  fail: new Set<string>(),
  bootWarmTaken: new Set<string>(),
  portal: 'https://a.example.com' as string | null
}))

async function note(pass: string) {
  state.calls.push({ pass, app: currentTenantKey() })
  if (state.fail.has(pass)) throw new Error(`${pass} broke`)
}

vi.mock('../../../services/pipeline-engine.js', () => ({
  warmOwnerGroupCache: vi.fn(async () => {
    await note('owner-groups')
    return 3
  })
}))
vi.mock('../../../services/config-conformance.js', () => ({
  warmCompiledChecks: vi.fn(async () => {
    await note('integrity-checks')
    return 2
  })
}))
vi.mock('../../../services/cache-warm.js', () => ({
  cacheWarmAllowed: () => true,
  warmMetadata: vi.fn(async () => {
    await note('metadata')
    return 1
  }),
  takeBootWarm: vi.fn(async (_redis: unknown, version: string, _holder: string) => {
    const key = `${currentTenantKey()}|${version}`
    if (state.bootWarmTaken.has(key)) return false
    state.bootWarmTaken.add(key)
    return true
  }),
  runCacheWarm: vi.fn(async () => {
    await note('query-caches')
    return {}
  })
}))
vi.mock('../../../services/readiness.js', () => ({
  warmReadiness: vi.fn(async () => {
    await note('readiness')
    return 0
  })
}))
vi.mock('../../../services/db-tuning/twin.js', () => ({
  sweepTwinLeftovers: vi.fn(async () => {
    await note('db-tuning-twins')
    return []
  })
}))
vi.mock('../../../services/db-tuning/settings.js', () => ({
  readTuningSettings: vi.fn(async () => ({ proc_timeout_minutes: 30 }))
}))
vi.mock('../../../services/api-changelog.js', () => ({
  recordRestRoutes: vi.fn(async (_version: string, routes: string[]) => {
    await note(`rest-routes:${routes.length}`)
  })
}))
vi.mock('../../../extensions/loader.js', () => ({
  extensionRegistry: new Map([['ext-a', {}]]),
  describeExtensionRegistry: vi.fn(async () => ({ hooks: [] }))
}))
vi.mock('../../../services/extension-registry-versions.js', () => ({
  recordRegistryVersion: vi.fn(async () => {
    await note('extension-registry')
    return { version: 1, changed: false }
  })
}))
vi.mock('../../../services/app-links.js', () => ({
  portalRegistration: vi.fn(async () => {
    await note('portal-url')
    return state.portal ? { base: state.portal } : null
  }),
  adminPageBase: () => 'https://a.example.com'
}))
vi.mock('../../../services/instance-roster.js', () => ({ INSTANCE_ID: 'inst-1' }))

const lc = await import('../../../services/tenancy/app-lifecycle.js')
const passes = await import('../../../services/app-boot-passes.js')
type TenantRecord = import('../../../services/tenancy/types.js').TenantRecord

const tenant = (id: string): TenantRecord => ({
  id,
  slug: id.toLowerCase(),
  name: `App ${id}`,
  status: 'active',
  dbClient: 'pg',
  dbConnection: `postgres://u@127.0.0.1:1/app_${id.toLowerCase()}`,
  poolMax: 1,
  hostnames: [`${id.toLowerCase()}.example.com`]
})

const SHARED: Record<string, string> = {
  HUB_SHARED_DEPLOYMENT: 'shared-a',
  HUB_URL: 'https://hub.example',
  HUB_DEPLOYMENT_TOKEN: 'x'.repeat(32)
}
const CLOUD: Record<string, string> = { CLOUD_META_DB_URL: 'postgres://meta/x' }
const KEYS = ['CLOUD_META_DB_URL', 'HUB_SHARED_DEPLOYMENT', 'HUB_URL', 'HUB_DEPLOYMENT_TOKEN']
const saved = { ...process.env }
function useEnv(env: Record<string, string>) {
  for (const k of KEYS) delete process.env[k]
  Object.assign(process.env, env)
}

/** The slice of a Fastify instance the passes use; onReady hooks are kept to run by hand. */
function fakeApp() {
  const hooks: Array<{ name: string; fn: () => Promise<void> | void }> = []
  const warn = vi.fn()
  const info = vi.fn()
  const heavy: Array<{ label: string; appKey?: string }> = []
  const app = {
    log: { warn, info, error: vi.fn(), debug: vi.fn() },
    redis: {},
    cron: {
      list: () => [],
      withHeavySlot: async (label: string, work: () => Promise<void>, appKey?: string) => {
        heavy.push({ label, appKey })
        await work()
      }
    },
    addHook: (name: string, fn: () => Promise<void> | void) => {
      hooks.push({ name, fn })
    }
  }
  const ready = async () => {
    for (const h of hooks) if (h.name === 'onReady') await h.fn()
  }
  return { app: app as never, hooks, warn, info, heavy, ready }
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1))
}
/** Until `n` passes have been recorded (or a second has gone by). */
const until = async (n: number) => {
  for (let i = 0; i < 200 && state.calls.length < n; i++) await new Promise((r) => setTimeout(r, 5))
}

const ORDER = [
  'owner-groups',
  'integrity-checks',
  'metadata',
  'query-caches',
  'readiness',
  'db-tuning-twins',
  'rest-routes:2',
  'extension-registry',
  'portal-url'
]

beforeEach(() => {
  lc._resetAppLifecycleForTests()
  state.calls = []
  state.fail.clear()
  state.bootWarmTaken.clear()
  state.portal = 'https://a.example.com'
  useEnv(SHARED)
})
afterEach(() => {
  lc._resetAppLifecycleForTests()
  process.env = { ...saved }
})

describe('registerAppBootPasses on a shared deployment', () => {
  it('runs every pass once, in order, inside the app that became ready', async () => {
    const f = fakeApp()
    passes.registerAppBootPasses(f.app, { restRoutes: ['GET /a', 'POST /b'] })
    await f.ready()
    lc.fireAppReady(tenant('A'))
    await until(ORDER.length)
    expect(state.calls.map((c) => c.pass)).toEqual(ORDER)
    expect(new Set(state.calls.map((c) => c.app))).toEqual(new Set(['A']))
    // the query warm holds that app's own heavy slot
    expect(f.heavy).toEqual([{ label: 'cache-warm (boot)', appKey: 'A' }])
  })

  it('two apps with copied data: each runs its own passes, never the other app', async () => {
    const f = fakeApp()
    passes.registerAppBootPasses(f.app, { restRoutes: ['GET /a', 'POST /b'] })
    await f.ready()
    // One after the other: under vitest's module mocks a second concurrent dynamic import of one
    // mocked module stalls (the passes import their services lazily; Node's own cache does not).
    lc.fireAppReady(tenant('A'))
    await until(ORDER.length)
    lc.fireAppReady(tenant('B'))
    await until(2 * ORDER.length)
    for (const id of ['A', 'B']) {
      expect(
        state.calls.filter((c) => c.app === id).map((c) => c.pass),
        id
      ).toEqual(ORDER)
    }
    expect(state.calls.every((c) => c.app === 'A' || c.app === 'B')).toBe(true)
  })

  it('waits for the server to be ready before any pass runs (the route list is complete)', async () => {
    const f = fakeApp()
    passes.registerAppBootPasses(f.app, { restRoutes: ['GET /a', 'POST /b'] })
    lc.fireAppReady(tenant('A'))
    await settle()
    expect(state.calls).toEqual([])
    await f.ready()
    await until(ORDER.length)
    expect(state.calls.map((c) => c.pass)).toEqual(ORDER)
  })

  it('a pass that throws never stops the next one; one warn line names it', async () => {
    state.fail.add('integrity-checks')
    state.fail.add('readiness')
    const f = fakeApp()
    passes.registerAppBootPasses(f.app, { restRoutes: ['GET /a', 'POST /b'] })
    await f.ready()
    lc.fireAppReady(tenant('A'))
    await until(ORDER.length)
    expect(state.calls.map((c) => c.pass)).toEqual(ORDER)
    const lines = f.warn.mock.calls
      .map((c) => String(c.at(-1)))
      .filter((l) => l.startsWith('[boot-passes]'))
    expect(lines).toEqual([
      '[boot-passes] app A: integrity-checks failed',
      '[boot-passes] app A: readiness failed'
    ])
  })

  it('the boot query warm runs once per app and version, not once per deployment', async () => {
    const f = fakeApp()
    passes.registerAppBootPasses(f.app, { restRoutes: [] })
    await f.ready()
    lc.fireAppReady(tenant('A'))
    await until(ORDER.length)
    lc.fireAppReady(tenant('B'))
    await until(2 * ORDER.length)
    expect(state.calls.filter((c) => c.pass === 'query-caches').map((c) => c.app)).toEqual([
      'A',
      'B'
    ])
  })

  it("warns when the app's portal is its own admin, naming the app", async () => {
    const f = fakeApp()
    passes.registerAppBootPasses(f.app, { restRoutes: [] })
    await f.ready()
    lc.fireAppReady(tenant('A'))
    await until(ORDER.length)
    const hit = f.warn.mock.calls.find((c) => String(c.at(-1)).includes('adminBaseUrl()'))
    expect(hit?.[0]).toMatchObject({ app: 'A', portal_url: 'https://a.example.com' })
  })

  it('outside any app every named pass does nothing (no static database on shared)', async () => {
    const f = fakeApp()
    await passes.warmOwnerGroups(f.app)
    await passes.warmIntegrityChecks(f.app)
    await passes.warmCaches(f.app)
    await passes.warmReadinessResults(f.app)
    await passes.sweepTuningTwins(f.app)
    await passes.recordRestRouteInventory(['GET /a'])
    await passes.recordExtensionRegistryVersions(f.app)
    await passes.warnIfPortalIsAdmin(f.app)
    expect(state.calls).toEqual([])
    expect(f.warn).not.toHaveBeenCalled()
  })
})

describe('registerAppBootPasses elsewhere', () => {
  for (const [name, env] of [
    ['self-hosted', {}],
    ['cloud', CLOUD]
  ] as const) {
    it(`${name}: registers nothing (no ready hook, no server hook)`, async () => {
      useEnv(env)
      const f = fakeApp()
      passes.registerAppBootPasses(f.app, { restRoutes: ['GET /a'] })
      expect(f.hooks).toEqual([])
      lc.fireAppReady(tenant('A'))
      await settle()
      expect(state.calls).toEqual([])
    })
  }

  it('self-hosted: the named passes run against the one database (no app needed)', async () => {
    useEnv({})
    const f = fakeApp()
    await passes.warmOwnerGroups(f.app)
    await passes.sweepTuningTwins(f.app)
    await passes.recordRestRouteInventory(['GET /a'])
    expect(state.calls).toEqual([
      { pass: 'owner-groups', app: '' },
      { pass: 'db-tuning-twins', app: '' },
      { pass: 'rest-routes:1', app: '' }
    ])
  })
})
