// api/src/test/unit/services/traffic-realtime.test.ts — Traffic Map realtime nodes: streams
// (#2155), rooms (#2159), connection failures (#2263), adapter lag (#2266), media (#2269),
// search (#2270) and MCP clients (#2211).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const measure = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('../../../services/request-trace.js', () => ({
  currentTraceCaller: vi.fn(() => null),
  currentTraceMeta: vi.fn(() => null),
  requestMeasure: vi.fn(() => measure.value)
}))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))
vi.mock('../../../services/traffic-source.js', () => ({ currentTrafficSource: () => null }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { allowReport } from '../../../routes/connection-reports.js'
import { advanceTo, noteRequest, resetTrafficMap } from '../../../services/traffic-map.js'
import {
  adapterLagFigures,
  browserOf,
  connectionFailures,
  describeRoom,
  judgeLag,
  networkOf,
  noteAdapterLag,
  noteConnectionReport,
  noteRoomBroadcast,
  noteRoomDelivery,
  noteSocketApp,
  noteSocketClose,
  noteSocketOpen,
  noteSocketTransport,
  parseConnectionReport,
  rankRooms,
  sseFrameIsEvent,
  streamFigures,
  trackSse
} from '../../../services/traffic-taps/realtime.js'
import {
  declaredBytes,
  keepSlowest,
  mcpFigures,
  mcpToolOf,
  mediaFigures,
  mediaKindOf,
  type SlowSearch,
  searchFigures,
  searchKindOf
} from '../../../services/traffic-taps/realtime-nodes.js'

const sec = () => Math.floor(Date.now() / 1000)
const T0 = 1_800_000_000

beforeEach(() => {
  resetTrafficMap()
  advanceTo(T0)
  measure.value = null
})

function req(over: Partial<Parameters<typeof noteRequest>[0]> = {}) {
  noteRequest({
    method: 'GET',
    path: '/api/items/workflows',
    status: 200,
    latencyMs: 100,
    authMethod: 'session',
    apiKeyId: null,
    userId: 'u1',
    graphqlOperation: null,
    graphqlKind: null,
    cacheHit: false,
    at: T0 * 1000,
    req: { headers: {} },
    ...over
  })
}

describe('streams (#2155)', () => {
  it('tells an event frame from a heartbeat or retry hint', () => {
    expect(sseFrameIsEvent('event: next\ndata: {}\n\n')).toBe(true)
    expect(sseFrameIsEvent(': hb\n\n')).toBe(false)
    expect(sseFrameIsEvent('retry: 5000\n\n')).toBe(false)
  })

  it('counts an SSE response: open, events, bytes, then closed', () => {
    const closers: Array<() => void> = []
    const writes: unknown[] = []
    const raw = {
      write: (c: unknown) => {
        writes.push(c)
        return true
      },
      once: (_e: string, fn: () => void) => closers.push(fn)
    }
    trackSse(raw, 'graphql-sse')
    raw.write(': connected\n\n')
    raw.write('event: next\ndata: {"a":1}\n\n')
    raw.write('event: next\ndata: {"a":2}\n\n')
    const row = streamFigures(300, sec()).find((r) => r.kind === 'graphql-sse')
    expect(writes).toHaveLength(3)
    expect(row?.open).toBe(1)
    expect(row?.opened).toBe(1)
    expect(row?.events).toBe(2)
    expect(row?.bytes).toBeGreaterThan(40)
    for (const c of closers) c()
    expect(streamFigures(300, sec()).find((r) => r.kind === 'graphql-sse')?.open).toBe(0)
  })
})

describe('rooms (#2159)', () => {
  it('hides rooms that name people or private chat, but not public ones', () => {
    expect(describeRoom('chat:dm:a:b')).toMatchObject({ hidden: true, kind: 'chat:dm:*' })
    expect(describeRoom('chat:channel:7')).toMatchObject({ hidden: true })
    expect(describeRoom('chat:global').hidden).toBe(false)
    expect(describeRoom('user:abc').hidden).toBe(true)
    expect(describeRoom('record:projects:12')).toMatchObject({
      hidden: false,
      cls: 'record',
      kind: 'record:projects:*'
    })
    expect(describeRoom('collection:projects').cls).toBe('collection')
    expect(describeRoom('watch:traffic-map').cls).toBe('watch')
  })

  it('ranks by traffic then members, folding private rooms into one kind row', () => {
    for (let i = 0; i < 30; i++) noteRoomDelivery('collection:projects', 'collection:update', 100)
    noteRoomBroadcast('collection:projects')
    for (let i = 0; i < 5; i++) noteRoomDelivery('chat:dm:a:b', 'chat:message', 50)
    for (let i = 0; i < 5; i++) noteRoomDelivery('chat:dm:c:d', 'chat:message', 50)
    noteRoomDelivery('session:secret', 'x', 1)
    const members = new Map([
      ['collection:projects', 4],
      ['record:tasks:9', 9],
      ['chat:dm:a:b', 2],
      ['chat:dm:c:d', 2],
      ['session:secret', 1]
    ])
    const { rows } = rankRooms(members, 60, sec())
    expect(rows[0].room).toBe('collection:projects')
    expect(rows[0].deliveries_pm).toBeCloseTo(30)
    expect(rows[0].broadcasts_pm).toBeCloseTo(1)
    const dm = rows.find((r) => r.hidden)
    expect(dm).toMatchObject({ room: 'chat:dm:*', rooms: 2, members: 4 })
    expect(rows.some((r) => r.room.startsWith('session:'))).toBe(false)
    expect(rows.find((r) => r.room === 'record:tasks:9')?.members).toBe(9)
  })
})

describe('connection failures (#2263)', () => {
  it('reads a coarse browser and network', () => {
    expect(browserOf('Mozilla/5.0 Chrome/120.0 Safari/537.36')).toBe('Chrome')
    expect(browserOf('Mozilla/5.0 Chrome/120.0 Safari/537.36 Edg/120.0')).toBe('Edge')
    expect(browserOf('Mozilla/5.0 (iPhone) AppleWebKit Version/17 Mobile Safari/604')).toBe(
      'Safari (mobile)'
    )
    expect(browserOf('')).toBe('Unknown')
    expect(networkOf('203.0.113.77')).toBe('203.0.113.0/24')
    expect(networkOf('::ffff:10.1.2.3')).toBe('10.1.2.0/24')
    expect(networkOf('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48')
    expect(networkOf(undefined)).toBe('unknown')
  })

  it('validates untrusted report bodies', () => {
    expect(parseConnectionReport({ kind: 'failed', transport: 'WebSocket', app: 'Admin' })).toEqual(
      {
        kind: 'failed',
        transport: 'websocket',
        reason: null,
        app: 'admin'
      }
    )
    expect(parseConnectionReport({ kind: 'weird' })).toBeNull()
    expect(parseConnectionReport(null)).toBeNull()
  })

  it('groups reports by network, browser and app, counting people once', () => {
    const ua = 'Mozilla/5.0 Chrome/120.0 Safari/537.36'
    const r = {
      kind: 'failed' as const,
      transport: 'websocket',
      reason: 'xhr-poll-error',
      app: 'admin'
    }
    noteConnectionReport(r, 'u1', ua, '203.0.113.5')
    noteConnectionReport(r, 'u1', ua, '203.0.113.9')
    noteConnectionReport(r, 'u2', ua, '203.0.113.20')
    noteConnectionReport({ ...r, kind: 'downgraded' }, 'u3', 'Firefox/120.0', '198.51.100.4')
    const f = connectionFailures(24)
    expect(f.failed).toBe(3)
    expect(f.downgraded).toBe(1)
    expect(f.by_network[0]).toEqual({ key: '203.0.113.0/24', n: 3, people: 2 })
    expect(f.by_browser.map((b) => b.key).sort()).toEqual(['Chrome', 'Firefox'])
    expect(f.by_app[0].key).toBe('admin')
  })

  it('lists sockets on long-polling right now by network', () => {
    noteSocketOpen('s1', { 'user-agent': 'Firefox/120.0' }, '192.0.2.10', 'polling')
    noteSocketOpen('s2', { 'user-agent': 'Chrome/120.0 Safari/1' }, '192.0.2.99', 'websocket')
    noteSocketApp('s1', 'admin')
    expect(connectionFailures(24).polling_now).toMatchObject({ total: 1, sockets: 2 })
    noteSocketTransport('s2', 'polling')
    expect(connectionFailures(24).polling_now.by_network[0]).toMatchObject({
      key: '192.0.2.0/24',
      n: 2
    })
    noteSocketClose('s1')
    noteSocketClose('s2')
    expect(connectionFailures(24).polling_now.sockets).toBe(0)
  })

  it('caps reports at six a minute per person', () => {
    const t = 1_900_000_000_000
    for (let i = 0; i < 6; i++) expect(allowReport('p1', t)).toBe(true)
    expect(allowReport('p1', t)).toBe(false)
    expect(allowReport('p2', t)).toBe(true)
    expect(allowReport('p1', t + 60_000)).toBe(true)
  })
})

describe('adapter lag (#2266)', () => {
  it('judges lag: error at 4x the line, warn above it or when it doubles', () => {
    expect(judgeLag(null, null, 500).level).toBe('idle')
    expect(judgeLag(80, 70, 500).level).toBe('ok')
    expect(judgeLag(600, 500, 500).level).toBe('warn')
    expect(judgeLag(2100, 500, 500).level).toBe('error')
    expect(judgeLag(300, 100, 500)).toEqual({ level: 'warn', growing: true })
    // growing but tiny: not worth a warning
    expect(judgeLag(60, 20, 500)).toEqual({ level: 'ok', growing: false })
  })

  it('averages by minute and reports the worst', () => {
    const now = 1_900_000_000_000
    noteAdapterLag(100, now)
    noteAdapterLag(300, now + 1000)
    const lag = adapterLagFigures(now + 2000, 500)
    expect(lag.total).toBe(2)
    expect(lag.recent_avg_ms).toBe(200)
    expect(lag.recent_max_ms).toBe(300)
    expect(lag.level).toBe('ok')
    expect(lag.minutes).toHaveLength(15)
    expect(lag.minutes[lag.minutes.length - 1].n).toBe(2)
  })
})

describe('classifying media, search and MCP', () => {
  it('finds help-video streams and replay uploads', () => {
    expect(mediaKindOf('GET', '/api/help-videos/12/stream?st=abc')).toBe('video')
    expect(mediaKindOf('GET', '/api/help-videos/12/poster')).toBeNull()
    expect(mediaKindOf('POST', '/api/session-recordings/abc/events')).toBe('replay')
    expect(mediaKindOf('GET', '/api/session-recordings/abc/events')).toBeNull()
  })

  it('finds the search routes and the collection browser box', () => {
    expect(searchKindOf('GET', '/api/global-search?q=a')).toBe('omnisearch')
    expect(searchKindOf('POST', '/api/search/semantic')).toBe('semantic')
    expect(searchKindOf('GET', '/api/items/projects', 'acme')).toBe('browser')
    expect(searchKindOf('GET', '/api/items/projects', '  ')).toBeNull()
    expect(searchKindOf('GET', '/api/items/projects')).toBeNull()
  })

  it('normalises an MCP tool header', () => {
    expect(mcpToolOf('read_items')).toBe('read_items')
    expect(mcpToolOf(['create_item'])).toBe('create_item')
    expect(mcpToolOf('Bad Tool!')).toBe('unknown')
    expect(mcpToolOf(undefined)).toBe('unknown')
    expect(declaredBytes('2048')).toBe(2048)
    expect(declaredBytes(undefined)).toBe(0)
  })

  it('keeps the slowest ten searches of the last hour', () => {
    const mk = (db_ms: number, at: number): SlowSearch => ({
      at,
      kind: 'omnisearch',
      route: 'GET /api/global-search',
      ms: db_ms,
      db_ms,
      stmt_ms: null,
      sql: null,
      caller: 'u1',
      status: 200
    })
    const now = 10_000_000
    let list: SlowSearch[] = []
    for (let i = 1; i <= 12; i++) list = keepSlowest(list, mk(i * 10, now), now)
    expect(list).toHaveLength(10)
    expect(list[0].db_ms).toBe(120)
    expect(list.some((s) => s.db_ms === 10)).toBe(false)
    list = keepSlowest(list, mk(1, now + 4_000_000), now + 4_000_000)
    expect(list).toHaveLength(1)
  })
})

describe('the request tap (media, search, MCP)', () => {
  it('counts help-video streams, their bandwidth, viewers and failures', () => {
    const reply = { getHeader: (n: string) => (n === 'content-length' ? '1048576' : undefined) }
    req({ path: '/api/help-videos/7/stream', userId: 'a', reply })
    req({ path: '/api/help-videos/7/stream', userId: 'b', reply })
    req({ path: '/api/help-videos/7/stream', userId: 'b', status: 500, reply })
    const m = mediaFigures(300, T0)
    expect(m.video.requests).toBe(3)
    expect(m.video.bytes).toBe(3 * 1048576)
    expect(m.video.failed).toBe(1)
    expect(m.video.active).toBe(2)
    expect(m.replay.requests).toBe(0)
  })

  it('counts replay uploads by the declared request size', () => {
    req({
      method: 'POST',
      path: '/api/session-recordings/r1/events',
      req: { headers: { 'content-length': '5000' } }
    })
    expect(mediaFigures(300, T0).replay.bytes).toBe(5000)
  })

  it('takes search database time and keeps the slowest statement', () => {
    measure.value = {
      sqlMs: 80,
      maxStatementMs: 60,
      maxStatementSql: 'select * from t where x like ?'
    }
    req({ path: '/api/global-search', latencyMs: 120 })
    measure.value = { sqlMs: 20, maxStatementMs: 15, maxStatementSql: 'select 1' }
    req({
      path: '/api/items/projects',
      req: { headers: {}, query: { search: 'acme' } },
      latencyMs: 40
    })
    req({ path: '/api/items/projects' })
    const s = searchFigures(300, T0, T0 * 1000)
    expect(s.total.requests).toBe(2)
    expect(s.total.db_ms).toBe(100)
    expect(s.by_kind[0]).toMatchObject({ kind: 'omnisearch', requests: 1 })
    expect(s.slowest[0]).toMatchObject({
      db_ms: 80,
      stmt_ms: 60,
      sql: 'select * from t where x like ?'
    })
  })

  it('counts MCP calls per tool and key, with errors', () => {
    const headers = (tool: string) => ({ 'x-nivaro-app': 'mcp', 'x-nivaro-mcp-tool': tool })
    req({ authMethod: 'api_key', apiKeyId: 5, req: { headers: headers('read_items') } })
    req({ authMethod: 'api_key', apiKeyId: 5, req: { headers: headers('read_items') } })
    req({
      authMethod: 'api_key',
      apiKeyId: 6,
      status: 403,
      req: { headers: headers('delete_item') },
      errorCode: 'FORBIDDEN'
    })
    req({ req: { headers: { 'x-nivaro-app': 'admin' } } })
    const m = mcpFigures(300, T0)
    expect(m.calls).toBe(3)
    expect(m.errors).toBe(1)
    expect(m.tools[0]).toMatchObject({ tool: 'read_items', calls: 2 })
    expect(m.keys.map((k) => k.caller).sort()).toEqual(['k5', 'k6'])
    expect(m.recent_errors[0]).toMatchObject({ tool: 'delete_item', status: 403, caller: 'k6' })
  })
})
