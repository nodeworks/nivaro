// api/src/test/unit/services/traffic-map-snapshots.test.ts
// Pure logic of the snapshots / retention / overhead / environment / node-description items
// (#2173 #2174 #2177 #2178 #2181 #2242 #2245).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: Object.assign(vi.fn(), { schema: {} }) }))
vi.mock('../../../plugins/socketio.js', () => ({
  getRealtimeStats: () => ({ sockets: [] })
}))
vi.mock('../../../services/instance-roster.js', () => ({ INSTANCE_ID: 'node-a' }))
vi.mock('../../../services/request-trace.js', () => ({
  currentTraceCaller: vi.fn(() => null),
  currentTraceMeta: vi.fn(() => null)
}))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: async () => false }))

import { matchRegistry, tierOf } from '../../../services/traffic-environment.js'
import {
  advanceTo,
  buildSnapshot,
  drainEvents,
  estimateMapBytes,
  noteRequest,
  resetTrafficMap
} from '../../../services/traffic-map.js'
import {
  effectiveSettings,
  MapSettingsError,
  serializeSettings,
  validatePatch
} from '../../../services/traffic-map-settings.js'
import { builtInText } from '../../../services/traffic-node-info.js'
import {
  keepEvent,
  overheadReport,
  overheadTick,
  planEvery,
  setSampleThreshold
} from '../../../services/traffic-overhead.js'
import { scheduleDue } from '../../../services/traffic-snapshot-schedule.js'
import {
  cutoffs,
  diffSnapshots,
  kindOf,
  nearestSnapshot,
  type StoredSnapshot,
  thumbOf
} from '../../../services/traffic-snapshots.js'
import {
  closeMinute,
  countRequest,
  MIN_PEAK_REQ,
  type PeakFacts,
  peakToCapture
} from '../../../services/traffic-taps/peak.js'

const snapOpts = { sockets: 0, users: 0, journalSeq: null }

describe('map settings', () => {
  it('defaults: 30 days for scheduled snapshots, others kept, peak on, no schedule', () => {
    const s = effectiveSettings({})
    expect(s.retention).toEqual({ snapshots_days: 0, scheduled_days: 30, notebooks_days: 0 })
    expect(s.schedule).toEqual({ peak: true, every_hours: 0 })
    expect(s.overhead.sample_above_rps).toBe(300)
  })
  it('the env var is the default sampling threshold, a stored value beats it', () => {
    expect(
      effectiveSettings({}, { TRAFFIC_SAMPLE_ABOVE_RPS: '80' }).overhead.sample_above_rps
    ).toBe(80)
    expect(
      effectiveSettings({ overhead: { sample_above_rps: 10 } }, { TRAFFIC_SAMPLE_ABOVE_RPS: '80' })
        .overhead.sample_above_rps
    ).toBe(10)
  })
  it('ignores bad stored values instead of failing', () => {
    const s = effectiveSettings({
      retention: { scheduled_days: -4, snapshots_days: 'x' },
      schedule: { every_hours: 5 },
      descriptions: { a: 7, b: '  hello ' }
    })
    expect(s.retention.scheduled_days).toBe(30)
    expect(s.schedule.every_hours).toBe(0)
    expect(s.descriptions).toEqual({ b: 'hello' })
  })
  it('a patch names every bad key', () => {
    expect(() =>
      validatePatch({ retention: { scheduled_days: -1, nope: 1 }, schedule: { every_hours: 5 } })
    ).toThrow(MapSettingsError)
    try {
      validatePatch({ retention: { scheduled_days: -1 }, schedule: { every_hours: 5 }, extra: 1 })
    } catch (e) {
      const m = (e as Error).message
      expect(m).toContain('retention.scheduled_days')
      expect(m).toContain('schedule.every_hours')
      expect(m).toContain('extra is not a setting')
    }
  })
  it('saves only the keys it is handed and keeps unknown keys', () => {
    const stored = JSON.stringify({ future: { a: 1 }, retention: { notebooks_days: 9 } })
    const next = JSON.parse(
      serializeSettings(stored, validatePatch({ retention: { scheduled_days: 7 } })) as string
    )
    expect(next).toEqual({ future: { a: 1 }, retention: { notebooks_days: 9, scheduled_days: 7 } })
  })
  it('null unsets a key and an empty object stores NULL', () => {
    const stored = JSON.stringify({ retention: { scheduled_days: 7 } })
    expect(
      serializeSettings(stored, validatePatch({ retention: { scheduled_days: null } }))
    ).toBeNull()
  })
  it('descriptions: add, clear with empty text, reject a bad node id', () => {
    const one = serializeSettings(
      null,
      validatePatch({ descriptions: { 'entity:items/x': ' Orders ' } })
    )
    expect(JSON.parse(one as string).descriptions['entity:items/x']).toBe('Orders')
    expect(
      serializeSettings(one, validatePatch({ descriptions: { 'entity:items/x': '' } }))
    ).toBeNull()
    expect(() => validatePatch({ descriptions: { '<b>': 'x' } })).toThrow()
  })
})

describe('retention cut-offs', () => {
  it('0 days keeps for ever, N days is N days ago', () => {
    const now = Date.UTC(2026, 9, 17)
    const c = cutoffs({ snapshots_days: 0, scheduled_days: 30, notebooks_days: 7 }, now)
    expect(c.snapshots).toBeNull()
    expect(c.scheduled?.getTime()).toBe(now - 30 * 86_400_000)
    expect(c.notebooks?.getTime()).toBe(now - 7 * 86_400_000)
  })
})

describe('snapshot kinds', () => {
  it('reads the kind from the filters JSON', () => {
    expect(kindOf('{"kind":"peak","win":900}')).toBe('peak')
    expect(kindOf('{"kind":"schedule"}')).toBe('schedule')
    expect(kindOf('{"win":60,"kinds":["read"]}')).toBe('manual')
    expect(kindOf(null)).toBe('manual')
    expect(kindOf('not json')).toBe('manual')
  })
})

describe('scheduled snapshots (#2173)', () => {
  it('is due when none exists or the interval has passed (with slack for the tick)', () => {
    const now = Date.UTC(2026, 9, 17, 12)
    expect(scheduleDue(0, null, now)).toBe(false)
    expect(scheduleDue(6, null, now)).toBe(true)
    expect(scheduleDue(6, new Date(now - 5 * 3_600_000), now)).toBe(false)
    expect(scheduleDue(6, new Date(now - 6 * 3_600_000 + 60_000), now)).toBe(true)
  })
  it('tracks the busiest minute of the day and captures it once it has settled', () => {
    const st = { day: -1, peakMinute: -1, peakCount: 0, minute: -1, count: 0, capturedMinute: -1 }
    const base = 1_800_000_000 - (1_800_000_000 % 60)
    for (let i = 0; i < 40; i++) countRequest(st, base + 5) // 40 in the first minute
    for (let i = 0; i < 90; i++) countRequest(st, base + 65) // 90 in the second
    for (let i = 0; i < 10; i++) countRequest(st, base + 130)
    closeMinute(st)
    expect(st.peakCount).toBe(90)
    expect(st.peakMinute).toBe(Math.floor((base + 65) / 60))
    const facts: PeakFacts = {
      day: st.day,
      peakMinute: st.peakMinute,
      peakCount: st.peakCount,
      capturedMinute: -1
    }
    expect(peakToCapture(facts, base + 65 + 3 * 60)).toBeNull() // still settling
    expect(peakToCapture(facts, base + 65 + 6 * 60)).toBe(st.peakMinute)
    expect(peakToCapture(facts, base + 65 + 20 * 60)).toBeNull() // out of the ring's reach
    expect(
      peakToCapture({ ...facts, capturedMinute: st.peakMinute }, base + 65 + 6 * 60)
    ).toBeNull()
  })
  it('a quiet day has no peak worth a snapshot', () => {
    const f: PeakFacts = {
      day: 1,
      peakMinute: 100,
      peakCount: MIN_PEAK_REQ - 1,
      capturedMinute: -1
    }
    expect(peakToCapture(f, 100 * 60 + 400)).toBeNull()
  })
  it('a new UTC day starts a new peak', () => {
    const st = { day: -1, peakMinute: -1, peakCount: 0, minute: -1, count: 0, capturedMinute: -1 }
    const day1 = 1440 * 20 + 600
    for (let i = 0; i < 50; i++) countRequest(st, day1 * 60)
    countRequest(st, (1440 * 21 + 5) * 60)
    closeMinute(st)
    countRequest(st, (1440 * 21 + 6) * 60)
    closeMinute(st)
    expect(st.day).toBe(21)
    expect(st.peakCount).toBe(1)
  })
})

const snap = (over: Partial<StoredSnapshot> = {}): StoredSnapshot =>
  ({
    instance: 'i',
    node_scope: '',
    at: '2026-10-17T10:00:00.000Z',
    window_s: 300,
    uptime_s: 1,
    frame: 1,
    lanes: [],
    entities: [
      {
        key: 'items/orders',
        lane: 'items',
        entity: 'orders',
        label: 'orders',
        system: false,
        req: 600,
        read: 600,
        create: 0,
        update: 0,
        delete: 0,
        error: 6,
        p50: 20,
        p95: 100,
        series: [],
        routes: [],
        callers: [{ key: 'u1', n: 500 }],
        down: { db: 600 },
        recent_errors: [],
        recent_writes: []
      }
    ],
    callers: [{ key: 'u1', req: 500, error: 5 }],
    down: [{ id: 'db', label: 'SQL Server', kind: 'db', req: 600, error: 0, p95: 30 }],
    totals: {
      req: 600,
      read: 600,
      create: 0,
      update: 0,
      delete: 0,
      error: 6,
      p50: 20,
      p95: 100,
      outbound_req: 0,
      outbound_error: 0
    },
    sockets: { count: 0, users: 0 },
    journal_seq: null,
    ...over
  }) as StoredSnapshot

describe('compare two snapshots (#2174)', () => {
  it('compares per minute so unequal windows still compare, node by node and edge by edge', () => {
    const a = snap()
    const b = snap({
      window_s: 60,
      entities: [
        {
          ...a.entities[0],
          req: 300,
          error: 30,
          p95: 400,
          callers: [{ key: 'u1', n: 250 }],
          down: { db: 300 }
        },
        {
          ...a.entities[0],
          key: 'items/new',
          entity: 'new',
          label: 'new',
          req: 60,
          error: 0,
          p95: 10,
          callers: [],
          down: {}
        }
      ]
    })
    const d = diffSnapshots(a, b)
    const orders = d.nodes.find((n) => n.key === 'items/orders')!
    expect(orders.a.rpm).toBe(120) // 600 over 5 minutes
    expect(orders.b.rpm).toBe(300) // 300 over 1 minute
    expect(orders.delta_rpm).toBe(180)
    expect(orders.delta_pct).toBe(150)
    expect(orders.delta_p95).toBe(300)
    expect(orders.delta_error_pts).toBeCloseTo(9, 1) // 1 % -> 10 %
    expect(d.nodes.find((n) => n.key === 'items/new')!.only).toBe('b')
    const edge = d.edges.find((e) => e.key === 'u1>items/orders')!
    expect(edge.a_rpm).toBe(100)
    expect(edge.b_rpm).toBe(250)
    expect(d.edges.find((e) => e.key === 'items/orders>db')!.delta_rpm).toBe(180)
    // biggest movers first
    expect(Math.abs(d.nodes[0].delta_rpm)).toBeGreaterThanOrEqual(Math.abs(d.nodes[1].delta_rpm))
  })
  it('a node in only one snapshot is marked with its side', () => {
    const a = snap()
    const b = snap({ down: [] })
    const d = diffSnapshots(a, b)
    expect(d.nodes.find((n) => n.key === 'db')!.only).toBe('a')
  })
})

describe('thumbnails (#2181)', () => {
  it('keeps the totals and the busiest nodes', () => {
    const t = thumbOf(snap({ environment: { name: 'Staging', tier: 'staging' } }), 3)
    expect(t.req).toBe(600)
    expect(t.bars).toEqual([{ label: 'orders', req: 600, error: 6 }])
    expect(t.environment).toBe('Staging')
  })
  it('picks the snapshot nearest in time, within the limit', () => {
    const rows = [
      { id: 'a', created_at: new Date(1_000_000) },
      { id: 'b', created_at: new Date(1_900_000) },
      { id: 'c', created_at: new Date(9_000_000) }
    ]
    expect(nearestSnapshot(rows, 1_800_000, 600_000)?.id).toBe('b')
    expect(nearestSnapshot(rows, 5_000_000, 600_000)).toBeNull()
  })
})

describe('environment banner (#2242)', () => {
  it('reads the tier off the name', () => {
    expect(tierOf('production')).toBe('production')
    expect(tierOf('Production (EU)')).toBe('production')
    expect(tierOf('staging')).toBe('staging')
    expect(tierOf('Pre-prod')).toBe('staging')
    expect(tierOf('development')).toBe('development')
    expect(tierOf('Local')).toBe('development')
    expect(tierOf('default')).toBe('other')
  })
  it('matches the registry component that lives at this instance', () => {
    const envs = [
      { id: 1, name: 'Staging' },
      { id: 2, name: 'Production' }
    ]
    const comps = [
      { environment: 1, base_url: 'https://stg.example.com/' },
      { environment: 2, base_url: 'https://app.example.com' }
    ]
    expect(matchRegistry(['app.example.com'], envs, comps)).toBe('Production')
    expect(matchRegistry(['other.example.com'], envs, comps)).toBeNull()
    expect(matchRegistry([], envs, comps)).toBeNull()
  })
})

describe('node descriptions (#2245)', () => {
  it('says something for the system nodes, lanes, jobs and collections', () => {
    expect(builtInText('down', 'db')).toMatch(/database/i)
    expect(builtInText('lane', 'items')).toMatch(/records/i)
    expect(builtInText('caller', 'cron:nightly')).toMatch(/scheduled job/i)
    expect(builtInText('entity', 'items/orders')).toBe('Records of the orders collection.')
    expect(builtInText('caller', 'k12')).toMatch(/API key/)
    expect(builtInText('down', 'unknown-thing')).toBeNull()
  })
})

describe('map overhead (#2178)', () => {
  beforeEach(() => resetTrafficMap())
  afterEach(() => setSampleThreshold(300))

  it('samples only above the threshold and never thins past 1 in 50', () => {
    expect(planEvery(100, 300)).toBe(1)
    expect(planEvery(300, 300)).toBe(1)
    expect(planEvery(450, 300)).toBe(2)
    expect(planEvery(1000, 300)).toBe(4)
    expect(planEvery(1_000_000, 300)).toBe(50)
    expect(planEvery(5000, 0)).toBe(1) // 0 = never sample
  })

  it('thins the ticker above the threshold, keeps errors and exact counts', () => {
    setSampleThreshold(5)
    const T = Math.floor(Date.now() / 1000)
    advanceTo(T)
    const call = (status: number) =>
      noteRequest({
        method: 'GET',
        path: '/api/items/orders',
        status,
        latencyMs: 5,
        at: Date.now(),
        authMethod: 'session',
        userId: 'u1'
      } as never)
    for (let i = 0; i < 100; i++) call(200) // 100 req/s on an empty ring: rate is judged next
    drainEvents()
    overheadTick(T) // 100 / 5 s window = 20 req/s > 5 -> every 4
    for (let i = 0; i < 80; i++) call(200)
    for (let i = 0; i < 3; i++) call(500)
    const events = drainEvents()
    const reads = events.filter((e) => e.kind !== 'error').length
    const errors = events.filter((e) => e.kind === 'error').length
    expect(errors).toBe(3)
    expect(reads).toBeLessThan(40)
    expect(reads).toBeGreaterThan(5)
    const snapshot = buildSnapshot(60, snapOpts)
    expect(snapshot.totals.req).toBe(183) // counts stay exact
    const report = overheadReport(estimateMapBytes(), 0)
    expect(report.sampling.on).toBe(true)
    expect(report.sampling.every).toBeGreaterThan(1)
    expect(report.events_sampled_per_s).toBeGreaterThan(0)
    expect(report.memory.entities).toBe(1)
    expect(report.memory.bytes).toBeGreaterThan(0)
    expect(report.req_per_s).toBeGreaterThan(0)
  })

  it('keeps everything below the threshold', () => {
    setSampleThreshold(1000)
    const T = Math.floor(Date.now() / 1000)
    overheadTick(T)
    expect(keepEvent(false)).toBe(true)
    expect(overheadReport(estimateMapBytes(), 0).sampling.on).toBe(false)
  })
})
