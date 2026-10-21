import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetReplayForTests,
  buildCapture,
  createReplayRun,
  idsOnly,
  mirrorRoom,
  parseRedisInfo,
  planReplayClients,
  planReplayEmits,
  replayJoinAllowed,
  replayPayload,
  replayServerRefusal,
  socketReplayRefusal,
  stopReplayRun
} from '../../../services/socket-replay.js'

const capture = () =>
  buildCapture({
    entries: [
      {
        at: 2000,
        room: 'collection:orders',
        event: 'collection:update',
        payload: {
          collection: 'orders',
          item: 5,
          action: 'update',
          changed_fields: ['total'],
          note: 'secret'
        }
      },
      { at: 1000, room: 'session:abc', event: 'session:ended', payload: { reason: 'x' } },
      {
        at: 1500,
        room: 'record:orders:5',
        event: 'record:integrity',
        payload: { collection: 'orders', item: '5' }
      }
    ],
    rooms: [
      { room: 'collection:orders', size: 40 },
      { room: 'record:orders:5', size: 4 },
      { room: 'masq:zzz', size: 1 }
    ],
    localSockets: 50,
    instances: [
      { instance: 'production', sockets: 120, users: 80 },
      { instance: 'production-2', sockets: 30, users: 25 }
    ],
    origin: 'https://ops.example.com',
    now: 0
  })

describe('socket replay (#2478)', () => {
  afterEach(() => _resetReplayForTests())

  it('captures ids only and never a sign-in room', () => {
    expect(
      idsOnly({
        collection: 'orders',
        item: 5,
        items: [1, 'x', { a: 1 }],
        action: 'drop',
        title: 'v'
      })
    ).toEqual({
      collection: 'orders',
      item: '5',
      items: ['1', 'x']
    })
    const c = capture()
    expect(c.origin).toBe('ops.example.com')
    expect(c.events.map((e) => [e.t, e.room])).toEqual([
      [0, 'record:orders:5'],
      [500, 'collection:orders']
    ])
    expect(JSON.stringify(c)).not.toContain('secret')
    expect(JSON.stringify(c)).not.toContain('total')
    expect(c.rooms.map((r) => r.room)).toEqual(['collection:orders', 'record:orders:5'])
    expect(c.connections).toMatchObject({ sockets: 150, users: 105, local_sockets: 50 })
    expect(c.window_ms).toBe(500)
  })

  it('refuses the capture origin, refused hosts, and bad URLs', () => {
    const ctx = {
      origin: 'ops.example.com',
      refused: ['http://localhost:3055', 'db.internal', 'https://prod-api.example.com']
    }
    expect(socketReplayRefusal('https://ops.example.com', ctx)).toMatch(/capture came from/)
    expect(socketReplayRefusal('https://prod-api.example.com', ctx)).toMatch(/refused host/)
    expect(socketReplayRefusal('http://db.internal:1433', ctx)).toMatch(/refused host/)
    expect(socketReplayRefusal('http://localhost:3055', ctx)).toMatch(/refused host/)
    expect(socketReplayRefusal('http://localhost:3181', ctx)).toBeNull()
    expect(socketReplayRefusal('https://staging.example.com', ctx)).toBeNull()
    expect(socketReplayRefusal('ftp://x', ctx)).toMatch(/http/)
    expect(socketReplayRefusal('nope', ctx)).toMatch(/URL/)
  })

  it('the target accepts only with REALTIME_REPLAY=on, never its own capture or in cloud', () => {
    const self = { captureOrigin: 'ops.example.com', selfHosts: ['https://staging.example.com'] }
    expect(replayServerRefusal({}, self)).toMatch(/REALTIME_REPLAY=on/)
    expect(replayServerRefusal({ REALTIME_REPLAY: 'on' }, self)).toBeNull()
    expect(replayServerRefusal({ REALTIME_REPLAY: 'on', CLOUD_META_DB_URL: 'x' }, self)).toMatch(
      /cloud/
    )
    expect(
      replayServerRefusal(
        { REALTIME_REPLAY: 'on' },
        { captureOrigin: 'ops.example.com', selfHosts: ['https://ops.example.com'] }
      )
    ).toMatch(/came from this server/)
  })

  it('plans the room mix scaled to the clients and the schedule at a speed', () => {
    const c = capture()
    const plan = planReplayClients(c, 10)
    const count = (room: string) => plan.filter((p) => p.includes(room)).length
    // 40 of 50 sockets → 8 of 10 clients; 4 of 50 → at least one.
    expect(count('collection:orders')).toBe(8)
    expect(count('record:orders:5')).toBe(1)
    expect(planReplayClients(c, 0)).toEqual([])
    expect(planReplayEmits(c, 5).map((e) => e.at)).toEqual([0, 100])
    expect(planReplayEmits(c, 3).map((e) => e.at)).toEqual([0, 500])
  })

  it('mirrors rooms per run and pads payloads to the captured size', () => {
    expect(mirrorRoom('r1', 't:ten:collection:a')).toBe('rtreplay:r1:collection:a')
    const p = replayPayload(
      { at: 0, room: 'r', event: 'e', ids: { collection: 'a' }, bytes: 400 },
      'r1',
      5
    )
    expect(p).toMatchObject({ collection: 'a', _replay: 'r1', _rs: 5 })
    const size = Buffer.byteLength(JSON.stringify(p))
    expect(size).toBeGreaterThan(380)
    expect(size).toBeLessThan(420)
  })

  it('runs are secret-gated, one at a time, and stop with a report', async () => {
    expect(() => createReplayRun({ capture: { version: 2 } }, null)).toThrow(/version 1/)
    expect(() => createReplayRun({ capture: capture(), speed: 3 }, null)).toThrow(/speed/)
    const run = createReplayRun({ capture: capture(), speed: 2 }, 'u')
    expect(run.emits).toBe(2)
    expect(() => createReplayRun({ capture: capture() }, 'u')).toThrow(/already running/)
    expect(replayJoinAllowed(run.id, run.secret)).toBe(true)
    expect(replayJoinAllowed(run.id, 'wrong')).toBe(false)
    await expect(stopReplayRun(run.id, 'wrong')).rejects.toMatchObject({ statusCode: 404 })
    const report = await stopReplayRun(run.id, run.secret)
    expect(report).toMatchObject({ id: run.id, speed: 2, planned: 2, emitted: 0 })
    expect(replayJoinAllowed(run.id, run.secret)).toBe(false)
  })

  it('parses the Redis INFO figures it compares', () => {
    expect(
      parseRedisInfo('# Stats\r\ntotal_commands_processed:120\r\nused_cpu_sys:1.50\r\nother:3\r\n')
    ).toEqual({ total_commands_processed: 120, used_cpu_sys: 1.5 })
  })
})
