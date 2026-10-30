import Fastify, { type FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Command Center security pass: a wallboard (kiosk) link is a BUSINESS board (never an admin
// console), is pinned to its link's region + map collection, and refuses the reads that name
// people or comment text; a scoped API key is never treated as an administrator and never reads
// another credential's cached answer; a region the caller cannot read is dropped.

type Row = Record<string, unknown>
const m = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  session: null as Row | null,
  sessionAdmin: false,
  apiKeyId: null as number | null,
  readable: ['R1', '7'] as string[],
  geo: [{ key: 'locations', label: 'Locations' }] as Array<{ key: string; label: string }>
}))

const ci = (a: unknown, b: unknown) =>
  String(a ?? '')
    .replace(/ +$/, '')
    .toLowerCase() ===
  String(b ?? '')
    .replace(/ +$/, '')
    .toLowerCase()

vi.mock('../../../db/index.js', () => {
  const chain = (table: string) => {
    const name = table.split(' as ')[0]
    const preds: Array<(r: Row) => boolean> = []
    const rows = () => (m.tables[name] ?? []).filter((r) => preds.every((p) => p(r)))
    const col = (c: string) => c.replace(/^\w+\./, '')
    const api: Record<string, unknown> = {
      where: (a: unknown, b?: unknown) => {
        if (typeof a === 'string') preds.push((r) => ci(r[col(a)], b))
        else for (const [k, v] of Object.entries(a as Row)) preds.push((r) => ci(r[col(k)], v))
        return api
      },
      whereIn: (c: string, vals: unknown[]) => {
        preds.push((r) => vals.some((v) => ci(r[col(c)], v)))
        return api
      },
      select: () => Promise.resolve(rows()),
      first: () => Promise.resolve(rows()[0]),
      update: () => Object.assign(Promise.resolve(1), { catch: () => undefined })
    }
    return api
  }
  return { db: Object.assign((t: string) => chain(t), { raw: vi.fn(() => 'raw') }) }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async (req: Row) => {
    if (!m.session) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = m.apiKeyId ? { ...m.session, api_key_scopes: [{ x: 1 }] } : m.session
    req.isAdmin = m.sessionAdmin
    if (m.apiKeyId) req.apiKeyId = m.apiKeyId
  }),
  requireAdmin: vi.fn(async () => undefined),
  // The real rule: a scoped API key is never an administrator on administrator routes.
  adminRefusal: (req: { isAdmin?: boolean; user?: { api_key_scopes?: unknown } }) => {
    if (!req.isAdmin) return { error: 'Forbidden', code: 'ADMIN_ONLY' }
    if (req.user?.api_key_scopes) return { error: 'scoped', code: 'API_KEY_SCOPE_MISSING' }
    return null
  },
  credentialMintRefusal: () => null
}))
vi.mock('../../../services/permission-cache.js', () => ({ notePrincipalKind: vi.fn() }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))

const spies = vi.hoisted(() => ({
  peek: vi.fn(async () => ({ id: '1' })),
  workload: vi.fn(async () => ({ rows: [], region_applies: null, truncated: false })),
  feed: vi.fn(async () => ({ entries: [], region_applies: false, next_before: null })),
  layer: vi.fn(async (..._a: unknown[]) => ({
    kind: 'sla_heat',
    points: [],
    region_applies: false
  })),
  geoPins: vi.fn(async (..._a: unknown[]) => ({
    pins: [],
    truncated: false,
    region_applies: false
  })),
  flow: vi.fn(async (req: { query: Row }) => [{ region: req.query.region ?? null }]),
  health: vi.fn(async () => ({ db: 'ok' })),
  people: vi.fn(async () => ({
    online_count: 2,
    idle_count: 1,
    names: ['Ann', 'Bob'],
    by_region: [],
    offices: [{ lat: 1, lng: 2, label: 'HQ', count: 2, names: ['Ann', 'Bob'] }],
    regions: [
      {
        region_id: 'R1',
        label: 'North',
        count: 2,
        names: ['Ann', 'Bob'],
        people: [{ user_id: 'u', name: 'Ann', idle: false, page_label: 'x', record: null }]
      }
    ]
  })),
  risk: vi.fn(async () => ({ at_risk: 1, tracked: 2, open_issues: null })),
  throughput: vi.fn(async () => ({ transitions_today: 1, transitions_yesterday_same_time: 1 })),
  snapFeed: vi.fn(async () => [{ id: 1 }])
}))

vi.mock('../../../services/command-center/regions.js', () => ({
  bustRegionCaches: vi.fn(),
  detectPlacement: vi.fn(async () => null),
  readableName: (c: string) => c,
  readableRegions: vi.fn(async () => m.readable.map((id) => ({ id, label: `Region ${id}` }))),
  regionCentroids: vi.fn(async () => []),
  resolveGeoCollections: vi.fn(async () => m.geo),
  resolveRegionSource: vi.fn(async () => ({ collection: 'regions', scope_dimension: 'r' })),
  recordIdsInRegion: vi.fn(async () => null),
  userIdsInRegion: vi.fn(async () => null),
  userRegionMap: vi.fn(async () => null)
}))
vi.mock('../../../services/command-center/geo.js', () => ({
  geoPins: spies.geoPins,
  readGeoFilters: () => ({ states: [], sla: [], owner: null }),
  validGeoCollection: (c: unknown) => typeof c === 'string' && /^[A-Za-z0-9_]+$/.test(c)
}))
vi.mock('../../../services/command-center/layers.js', () => ({
  LAYER_KINDS: ['sla_heat', 'activity', 'out_today'],
  mapLayer: spies.layer,
  messageableUserIds: vi.fn(async () => [])
}))
vi.mock('../../../services/command-center/peek.js', () => ({ peekRecord: spies.peek }))
vi.mock('../../../services/command-center/config.js', () => ({
  readCcConfig: vi.fn(async () => ({ stuck_days: 3, geo_collections: [], region: null })),
  writeCcConfig: vi.fn()
}))
vi.mock('../../../services/command-center/workload.js', () => ({
  WorkloadForbidden: class extends Error {},
  workloadForRequest: spies.workload
}))
vi.mock('../../../services/command-center/attention.js', () => ({
  attentionForRequest: vi.fn(async () => ({ items: [], live_only: false, region_applies: null }))
}))
vi.mock('../../../services/command-center/flow.js', () => ({
  flowForRequest: spies.flow,
  snapshotFlowBlock: vi.fn(async () => [])
}))
vi.mock('../../../services/command-center/forecast.js', () => ({
  forecastForRequest: vi.fn(async () => ({}))
}))
vi.mock('../../../services/command-center/activity.js', () => ({
  parseFeedFilter: () => 'all',
  readFeed: spies.feed,
  snapshotFeed: spies.snapFeed
}))
vi.mock('../../../services/command-center/system.js', () => ({ readSystemHealth: spies.health }))
vi.mock('../../../services/command-center/risk.js', () => ({ snapshotRiskBlock: spies.risk }))
vi.mock('../../../services/command-center/throughput.js', () => ({
  readMarkers: vi.fn(async () => []),
  readThroughput: vi.fn(async () => ({
    hours: [],
    time_zone: 'UTC',
    today_total: 0,
    yesterday_same_time: 0,
    region_applies: false
  })),
  startOfLocalDay: () => 0,
  snapshotThroughput: spies.throughput
}))
vi.mock('../../../services/command-center/partners.js', () => ({
  readPartners: vi.fn(async () => [])
}))
vi.mock('../../../services/command-center/banner.js', () => ({
  readBanner: vi.fn(async () => ({ maintenance: null, incident: null }))
}))
vi.mock('../../../services/command-center/brief.js', () => ({
  buildBrief: vi.fn(async () => ({}))
}))
vi.mock('../../../services/user-time.js', () => ({ userTimeZone: vi.fn(async () => 'UTC') }))
vi.mock('../../../services/command-center/nudge.js', () => ({
  liveNudgeDeps: vi.fn(),
  runNudge: vi.fn(async () => ({ status: 200, body: {} }))
}))
vi.mock('../../../services/command-center/people.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/command-center/people.js')>()),
  snapshotPeople: spies.people
}))

const { commandCenterRoutes } = await import('../../../routes/command-center.js')
const { commandCenterPlaceRoutes } = await import('../../../routes/command-center-place.js')
const { commandCenterWorkRoutes } = await import('../../../routes/command-center-work.js')
const { commandCenterTimeRoutes } = await import('../../../routes/command-center-time.js')
const { hashKioskToken } = await import('../../../services/command-center/kiosk.js')
const { resetTenantMemos } = await import('../../../services/command-center/work-access.js')
const { readCcScope } = await import('../../../services/command-center/scope.js')

const ADMIN_ROLE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const CREATOR = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const LINK_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
const TOKEN = 'ab'.repeat(24)

function seed(meta: Row = { label: 'Wall', region: '7', map_collection: 'locations' }) {
  m.tables = {
    nivaro_roles: [{ id: ADMIN_ROLE, admin_access: true, app_access: true }],
    nivaro_users: [{ id: CREATOR, status: 'active', role: ADMIN_ROLE }],
    nivaro_share_links: [
      {
        id: LINK_ID,
        item: '__cc_kiosk__',
        token: hashKioskToken(TOKEN),
        is_active: 1,
        expires_at: new Date(Date.now() + 86_400_000),
        created_by: CREATOR
      }
    ],
    nivaro_extension_settings: [
      { extension_id: 'nivaro-core', key: `cc_kiosk:${LINK_ID}`, value: JSON.stringify(meta) }
    ]
  }
}

async function build(): Promise<FastifyInstance> {
  const app = Fastify()
  ;(app as unknown as { redis: null }).redis = null
  await app.register(
    async (api) => {
      for (const r of [
        commandCenterRoutes,
        commandCenterPlaceRoutes,
        commandCenterWorkRoutes,
        commandCenterTimeRoutes
      ])
        await api.register(r, { prefix: '/command-center' })
    },
    { prefix: '/api' }
  )
  await app.ready()
  return app
}

const K = `kiosk=${TOKEN}`
const get = (app: FastifyInstance, url: string) =>
  app.inject({ method: 'GET', url: `/api/command-center${url}` })

beforeEach(() => {
  seed()
  m.session = null
  m.sessionAdmin = false
  m.apiKeyId = null
  m.readable = ['R1', '7']
  m.geo = [{ key: 'locations', label: 'Locations' }]
  resetTenantMemos()
  for (const s of Object.values(spies)) s.mockClear()
})

describe('a wallboard link is a business board', () => {
  it('refuses peek, workload, activity and the out-today layer', async () => {
    const app = await build()
    for (const url of [
      `/peek?collection=locations&id=1&${K}`,
      `/workload?${K}`,
      `/activity?${K}`,
      `/layers?kind=out_today&${K}`
    ]) {
      const r = await get(app, url)
      expect(r.statusCode, url).toBe(403)
    }
    expect(spies.peek).not.toHaveBeenCalled()
    expect(spies.workload).not.toHaveBeenCalled()
    expect(spies.feed).not.toHaveBeenCalled()
    expect(spies.layer).not.toHaveBeenCalled()
  })

  it('reads as a non-administrator: no system health, no feed, counts-only people, no issues', async () => {
    const app = await build()
    const r = await get(app, `/snapshot?${K}`)
    expect(r.statusCode).toBe(200)
    const d = r.json().data
    expect(spies.health).not.toHaveBeenCalled()
    expect(spies.snapFeed).not.toHaveBeenCalled()
    expect(d.health).toBeNull()
    expect(d.activity).toEqual([])
    expect(d.people.online_count).toBe(2)
    expect(JSON.stringify(d.people)).not.toMatch(/Ann|Bob/)
    expect(d.people.regions[0]).toMatchObject({ label: 'North', count: 2, names: [], people: [] })
    expect(d.people.offices[0]).toMatchObject({ label: 'HQ', count: 2, names: [] })
    expect(d.risk.open_issues).toBeNull()
  })

  it('a signed-in administrator still gets system health and the feed', async () => {
    m.session = { id: CREATOR }
    m.sessionAdmin = true
    const app = await build()
    const r = await get(app, '/snapshot')
    expect(r.statusCode).toBe(200)
    expect(spies.health).toHaveBeenCalled()
    expect(spies.snapFeed).toHaveBeenCalled()
  })

  it('ignores a region in the query and uses the link’s region', async () => {
    const app = await build()
    await get(app, `/flow?region=R1&${K}`)
    expect(spies.flow.mock.calls[0][0].query.region).toBe('7')
    spies.flow.mockClear()
    resetTenantMemos()
    seed({ label: 'All', region: null, map_collection: null })
    await get(app, `/flow?region=R1&${K}`)
    expect(spies.flow.mock.calls[0][0].query.region).toBeUndefined()
  })

  it('refuses — never widens — when the link’s region cannot be confirmed', async () => {
    const app = await build()
    const before = m.readable
    m.readable = ['R1'] // the link's region '7' is no longer readable
    resetTenantMemos()
    const gone = await get(app, `/flow?${K}`)
    expect(gone.statusCode).toBe(403)
    expect(JSON.parse(gone.body).code ?? JSON.parse(gone.body).error).toBeTruthy()
    const { readableRegions } = await import('../../../services/command-center/regions.js')
    vi.mocked(readableRegions).mockRejectedValueOnce(new Error('db down'))
    m.readable = before
    resetTenantMemos()
    const failed = await get(app, `/flow?${K}`)
    expect(failed.statusCode).toBe(403)
    spies.flow.mockClear()
  })

  it('serves only the link’s map collection', async () => {
    m.geo = [
      { key: 'locations', label: 'Locations' },
      { key: 'depots', label: 'Depots' }
    ]
    const app = await build()
    const other = await get(app, `/geo?collection=depots&${K}`)
    expect(other.statusCode).toBe(403)
    expect(spies.geoPins).not.toHaveBeenCalled()
    const own = await get(app, `/geo?${K}`)
    expect(own.statusCode).toBe(200)
    expect(spies.geoPins.mock.calls[0][1]).toBe('locations')
    const layerOther = await get(app, `/layers?kind=sla_heat&collection=depots&${K}`)
    expect(layerOther.statusCode).toBe(403)
    const layerOwn = await get(app, `/layers?kind=sla_heat&${K}`)
    expect(layerOwn.statusCode).toBe(200)
    expect(spies.layer.mock.calls[0][3]).toBe('locations')
    // Without a map collection on the link, the first configured one.
    seed({ label: 'x', region: null, map_collection: null })
    await get(app, `/geo?${K}`)
    expect(spies.geoPins.mock.calls.at(-1)?.[1]).toBe('locations')
  })

  it('shows the config for only the link’s collection and region', async () => {
    m.geo = [
      { key: 'locations', label: 'Locations' },
      { key: 'depots', label: 'Depots' }
    ]
    const app = await build()
    const r = await get(app, `/config?${K}`)
    const d = r.json().data
    expect(d.geo_collections.map((g: Row) => g.key)).toEqual(['locations'])
    expect(d.regions.map((x: Row) => x.id)).toEqual(['7'])
    expect(d.can_configure).toBe(false)
  })
})

describe('credentials never share cached answers', () => {
  it('a scoped API key does not read the session’s cached flow answer', async () => {
    m.session = { id: CREATOR }
    m.sessionAdmin = true
    const app = await build()
    await get(app, '/flow')
    await get(app, '/flow')
    expect(spies.flow).toHaveBeenCalledTimes(1)
    m.apiKeyId = 9
    await get(app, '/flow')
    expect(spies.flow).toHaveBeenCalledTimes(2)
    await get(app, '/flow')
    expect(spies.flow).toHaveBeenCalledTimes(2)
    m.apiKeyId = 10
    await get(app, '/flow')
    expect(spies.flow).toHaveBeenCalledTimes(3)
  })

  it('a scoped API key is not an administrator in the snapshot', async () => {
    m.session = { id: CREATOR }
    m.sessionAdmin = true
    m.apiKeyId = 9
    const app = await build()
    const r = await get(app, '/snapshot')
    expect(r.statusCode).toBe(200)
    expect(spies.health).not.toHaveBeenCalled()
  })
})

describe('free-form lenses', () => {
  it('drops a region the caller cannot read and keeps one they can', async () => {
    m.session = { id: CREATOR }
    const app = await build()
    await get(app, '/flow?region=NOPE')
    expect(spies.flow.mock.calls[0][0].query.region).toBeUndefined()
    resetTenantMemos()
    await get(app, '/flow?region=r1')
    expect(spies.flow.mock.calls[1][0].query.region).toBe('r1')
  })

  it('rounds a rewind instant down to 5 minutes', () => {
    const at = new Date(Date.now() - 3 * 3_600_000 - 123_456)
    const s = readCcScope({ at: at.toISOString() })
    expect(s.at!.getTime() % 300_000).toBe(0)
    expect(at.getTime() - s.at!.getTime()).toBeLessThan(300_000)
    expect(s.at!.getTime()).toBeLessThanOrEqual(at.getTime())
  })
})
