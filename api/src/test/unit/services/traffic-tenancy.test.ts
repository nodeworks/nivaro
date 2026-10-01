// api/src/test/unit/services/traffic-tenancy.test.ts — #1132 tenant-scoped stores, #1098 emitter
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/request-trace.js', () => ({
  currentTraceCaller: vi.fn(() => null),
  currentTraceMeta: vi.fn(() => null)
}))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))
vi.mock('../../../db/tenant-context.js', () => ({ getTenantId: vi.fn(() => undefined) }))

import { getTenantId } from '../../../db/tenant-context.js'
import {
  advanceTo,
  buildSnapshot,
  type FrameWire,
  noteRequest,
  noteWrite,
  resetTrafficMap,
  setTrafficCluster,
  startTrafficMapEmitter,
  sweepIdle,
  trafficRoomFor,
  trafficStoreIds
} from '../../../services/traffic-map.js'
import {
  currentStoreId,
  DEFAULT_STORE,
  NO_STORE,
  registerTrafficTap,
  storeForRequest,
  tapState,
  trafficTaps,
  unregisterTrafficTap,
  withTrafficStore
} from '../../../services/traffic-taps.js'

const T0 = 1_800_000_000
const snapOpts = { sockets: 0, users: 0, journalSeq: null }
const req = (over: Partial<Parameters<typeof noteRequest>[0]> = {}) =>
  noteRequest({
    method: 'GET',
    path: '/api/items/workflows',
    status: 200,
    latencyMs: 40,
    authMethod: 'session',
    apiKeyId: null,
    userId: 'u1',
    graphqlOperation: null,
    graphqlKind: null,
    cacheHit: false,
    at: T0 * 1000,
    ...over
  })
const snapIn = (store: string) => withTrafficStore(store, () => buildSnapshot(60, snapOpts))

let prevCloud: string | undefined
beforeEach(() => {
  prevCloud = process.env.CLOUD_META_DB_URL
  for (const t of trafficTaps()) unregisterTrafficTap(t.id)
  resetTrafficMap()
  advanceTo(T0)
  vi.mocked(getTenantId).mockReturnValue(undefined)
  setTrafficCluster(null)
})
afterEach(() => {
  if (prevCloud === undefined) delete process.env.CLOUD_META_DB_URL
  else process.env.CLOUD_META_DB_URL = prevCloud
})

describe('store ids', () => {
  it('self-hosted: always the default store', () => {
    expect(currentStoreId()).toBe(DEFAULT_STORE)
    expect(storeForRequest({ nvrTenantId: 'x' })).toBe(DEFAULT_STORE)
  })
  it('cloud: the tenant from the request stamp, else the ALS, else no store', () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    expect(currentStoreId()).toBe(NO_STORE)
    expect(storeForRequest({ nvrTenantId: 'acme' })).toBe('t:acme')
    vi.mocked(getTenantId).mockReturnValue('globex')
    expect(currentStoreId()).toBe('t:globex')
    expect(storeForRequest({})).toBe('t:globex')
    expect(withTrafficStore('t:x', () => currentStoreId())).toBe('t:x')
    expect(currentStoreId()).toBe('t:globex')
  })
})

describe('tenant isolation (cloud)', () => {
  beforeEach(() => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
  })
  it('each tenant sees only its own requests, callers and writes', () => {
    req({ req: { nvrTenantId: 'acme' }, userId: 'a1' })
    req({ req: { nvrTenantId: 'acme' }, userId: 'a1' })
    req({ req: { nvrTenantId: 'globex' }, path: '/api/items/invoices', userId: 'g1' })
    vi.mocked(getTenantId).mockReturnValue('globex')
    noteWrite({
      collection: 'invoices',
      item: 7,
      action: 'update',
      changedFields: [],
      at: T0 * 1000
    })
    vi.mocked(getTenantId).mockReturnValue(undefined)

    const acme = snapIn('t:acme')
    const globex = snapIn('t:globex')
    expect(acme.entities.map((e) => e.key)).toEqual(['items/workflows'])
    expect(acme.entities[0].req).toBe(2)
    expect(acme.callers.map((c) => c.key)).toEqual(['uA1'])
    expect(globex.entities.map((e) => e.key)).toEqual(['items/invoices'])
    expect(globex.entities[0].update).toBe(1)
    // the write had no request behind it: it counts as cron, inside globex only
    expect(globex.callers.map((c) => c.key).sort()).toEqual(['cron', 'uG1'])
    expect(trafficStoreIds().sort()).toEqual(['t:acme', 't:globex'])
  })
  it('a request with no tenant records nothing', () => {
    req({ req: {} })
    noteWrite({ collection: 'x', item: 1, action: 'create', changedFields: [], at: T0 * 1000 })
    expect(trafficStoreIds()).toEqual([])
  })
  it('tap state follows the store', () => {
    registerTrafficTap({
      id: 'count',
      onRequest: () => {
        tapState('count', () => ({ n: 0 })).n++
      },
      snapshot: () => tapState('count', () => ({ n: 0 })).n
    })
    req({ req: { nvrTenantId: 'acme' } })
    req({ req: { nvrTenantId: 'acme' } })
    req({ req: { nvrTenantId: 'globex' } })
    expect(snapIn('t:acme').ext).toEqual({ count: 2 })
    expect(snapIn('t:globex').ext).toEqual({ count: 1 })
  })
  it('the sweep drops a tenant store once it is empty', () => {
    req({ req: { nvrTenantId: 'acme' } })
    expect(trafficStoreIds()).toEqual(['t:acme'])
    sweepIdle(T0 + 2000)
    expect(trafficStoreIds()).toEqual([])
  })
})

interface FakeIo {
  sockets: { adapter: { rooms: Map<string, Set<string>> } }
  to: () => { emit: () => void }
  local: { to: (room: string) => { emit: (ev: string, p: unknown) => void } }
}
function fakeIo(
  rooms: Map<string, Set<string>>,
  emitted: Array<{ room: string; f: FrameWire }>
): FakeIo {
  return {
    sockets: { adapter: { rooms } },
    to: () => ({ emit: () => {} }),
    local: { to: (room) => ({ emit: (_ev, p) => void emitted.push({ room, f: p as FrameWire }) }) }
  }
}
const tick = () => new Promise((r) => setTimeout(r, 25))

describe('emitter per store (#1132) and across nodes (#1098)', () => {
  it('cloud: a tenant frame goes to that tenant room only', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    const emitted: Array<{ room: string; f: FrameWire }> = []
    const rooms = new Map([[trafficRoomFor('t:acme'), new Set(['s1'])]])
    let clock = T0
    const stop = startTrafficMapEmitter({
      intervalMs: 5,
      io: () => fakeIo(rooms, emitted) as never,
      now: () => clock * 1000,
      node: 'n1'
    })
    await tick()
    req({ req: { nvrTenantId: 'acme' }, at: (T0 + 1) * 1000 })
    req({ req: { nvrTenantId: 'globex' }, at: (T0 + 1) * 1000 })
    advanceTo(T0 + 1)
    clock = T0 + 2
    await tick()
    stop()
    expect(emitted.length).toBeGreaterThan(0)
    expect(new Set(emitted.map((e) => e.room))).toEqual(new Set(['watch:traffic-map:t:acme']))
    expect(emitted.every((e) => e.f.node === 'n1')).toBe(true)
    expect(emitted.some((e) => e.f.entities['items/workflows']?.[0] === 1)).toBe(true)
    expect(trafficRoomFor(DEFAULT_STORE)).toBe('watch:traffic-map')
  })

  it('builds and publishes frames while ANOTHER node watches, with no local watcher', async () => {
    const published: Array<{ store: string; f: FrameWire }> = []
    const announced: string[] = []
    let remote = false
    setTrafficCluster({
      announce: (s) => void announced.push(s),
      watched: () => remote,
      publish: (store, f) => void published.push({ store, f })
    })
    const emitted: Array<{ room: string; f: FrameWire }> = []
    const rooms = new Map<string, Set<string>>()
    let clock = T0
    const stop = startTrafficMapEmitter({
      intervalMs: 5,
      io: () => fakeIo(rooms, emitted) as never,
      now: () => clock * 1000,
      node: 'n2'
    })
    await tick()
    req({ at: (T0 + 1) * 1000 })
    clock = T0 + 2
    await tick()
    expect(published).toHaveLength(0) // idle cluster: nothing published
    remote = true
    req({ at: (T0 + 2) * 1000 })
    clock = T0 + 3
    await tick()
    rooms.set('watch:traffic-map', new Set(['s']))
    clock = T0 + 4
    await tick()
    stop()
    expect(published.length).toBeGreaterThan(0)
    expect(published[0].store).toBe(DEFAULT_STORE)
    expect(published.some((p) => p.f.entities['items/workflows']?.[0] === 1)).toBe(true)
    expect(announced).toContain(DEFAULT_STORE)
    expect(emitted.length).toBeGreaterThan(0)
  })
})
