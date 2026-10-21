import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/io-holder.js', () => ({ getIo: () => null, getApp: () => null }))

import {
  _resetChaosForTests,
  applyChaos,
  type ChaosSpec,
  chaosCounters,
  chaosMatches,
  chaosRefusal,
  endChaos,
  noteChaosInbound,
  parseChaosRequest,
  shareBucket,
  startChaos,
  sumCounters,
  wrapChaosWrite
} from '../../../services/socket-chaos.js'

function fakeSocket(id: string, rooms: string[] = []) {
  const handlers: Record<string, () => void> = {}
  return {
    id,
    rooms: new Set([id, ...rooms]),
    once: (ev: string, cb: () => void) => {
      handlers[ev] = cb
    },
    handlers
  } as any
}

function spec(over: Partial<ChaosSpec> = {}): ChaosSpec {
  const now = Date.now()
  return {
    id: 'drill-1',
    target: { kind: 'user', user_id: 'aaaaaaaa-0000-0000-0000-000000000001' },
    fault: { latency_ms: 0, drop_pct: 0, disconnect: 'none', disconnect_every_s: 30 },
    seconds: 30,
    started_at: now,
    ends_at: now + 30_000,
    started_by: null,
    started_by_name: null,
    ...over
  }
}

const USER = 'aaaaaaaa-0000-0000-0000-000000000001'

describe('socket chaos (#2463)', () => {
  beforeEach(() => _resetChaosForTests())
  afterEach(() => {
    vi.useRealTimers()
    _resetChaosForTests()
  })

  it('is refused in cloud mode and in production without the flag', () => {
    expect(chaosRefusal({ NODE_ENV: 'development' })).toBeNull()
    expect(chaosRefusal({ NODE_ENV: 'production' })).toMatch(/CHAOS_ENABLED/)
    expect(chaosRefusal({ NODE_ENV: 'production', CHAOS_ENABLED: 'true' })).toBeNull()
    expect(chaosRefusal({ NODE_ENV: 'development', CLOUD_META_DB_URL: 'x' })).toMatch(/cloud/)
  })

  it('checks a drill request and names every bad field', () => {
    const ok = parseChaosRequest({
      target: { kind: 'share', share_pct: 10 },
      fault: { latency_ms: 500, disconnect: 'every', disconnect_every_s: 20 },
      seconds: 120
    })
    expect(ok.fault).toEqual({
      latency_ms: 500,
      drop_pct: 0,
      disconnect: 'every',
      disconnect_every_s: 20
    })
    expect(() => parseChaosRequest({ target: { kind: 'room', room: 'session:abc' } })).toThrow(
      /sign-in rooms/
    )
    expect(() => parseChaosRequest({ target: { kind: 'user', user_id: USER }, fault: {} })).toThrow(
      /at least one fault/
    )
    expect(() =>
      parseChaosRequest({
        target: { kind: 'share', share_pct: 0 },
        fault: { drop_pct: 150 },
        seconds: 9999
      })
    ).toThrow(/share_pct.*drop_pct.*seconds/)
  })

  it('picks a stable share of sockets per drill', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `sock-${i}`)
    const picked = ids.filter((id) => shareBucket(id, 'd1') < 10).length
    expect(picked).toBeGreaterThan(140)
    expect(picked).toBeLessThan(260)
    expect(shareBucket('sock-1', 'd1')).toBe(shareBucket('sock-1', 'd1'))
  })

  it('matches rooms with or without a tenant prefix, people by id, share needs a sign-in', () => {
    const room = spec({ target: { kind: 'room', room: 'collection:orders' } })
    expect(chaosMatches(room, { id: 's', userId: null, rooms: ['t:x:collection:orders'] })).toBe(
      true
    )
    expect(chaosMatches(room, { id: 's', userId: null, rooms: ['collection:order'] })).toBe(false)
    expect(chaosMatches(spec(), { id: 's', userId: USER.toUpperCase(), rooms: [] })).toBe(true)
    const all = spec({ target: { kind: 'share', share_pct: 100 } })
    expect(chaosMatches(all, { id: 's', userId: null, rooms: [] })).toBe(false)
    expect(chaosMatches(all, { id: 's', userId: USER, rooms: [] })).toBe(true)
  })

  it('drops, delays or passes packets for the targeted socket only, then heals', () => {
    vi.useFakeTimers()
    const out: string[] = []
    const target = fakeSocket('s1')
    const other = fakeSocket('s2')
    const wTarget = wrapChaosWrite(
      target,
      (p) => out.push(`s1:${p}`),
      () => USER
    )
    const wOther = wrapChaosWrite(
      other,
      (p) => out.push(`s2:${p}`),
      () => 'someone-else'
    )
    applyChaos(
      spec({ fault: { latency_ms: 0, drop_pct: 100, disconnect: 'none', disconnect_every_s: 30 } })
    )
    wTarget('a', {})
    wOther('b', {})
    expect(out).toEqual(['s2:b'])
    expect(chaosCounters()?.dropped).toBe(1)

    applyChaos(
      spec({
        id: 'd2',
        fault: { latency_ms: 300, drop_pct: 0, disconnect: 'none', disconnect_every_s: 30 }
      })
    )
    wTarget('c', {})
    wTarget('d', {})
    expect(out).toEqual(['s2:b'])
    vi.advanceTimersByTime(300)
    expect(out).toEqual(['s2:b', 's1:c', 's1:d'])

    endChaos('d2')
    wTarget('e', {})
    expect(out.at(-1)).toBe('s1:e')
  })

  it('counts the catch-up answers and the reconnects of people the drill disconnected', () => {
    const s = fakeSocket('s1')
    const w = wrapChaosWrite(
      s,
      () => {},
      () => USER
    )
    applyChaos(spec())
    w('2["x",{}]', {}) // makes the person a target
    // Their old socket was closed by the drill (as disconnectMatching records it)…
    noteChaosInbound(s, 'collection:join', USER)
    expect(chaosCounters()?.reconnected).toBe(0)
    w('2["catchup:events",{"events":[]}]', {})
    expect(chaosCounters()?.catchup_replayed).toBe(1)
    noteChaosInbound(fakeSocket('s9'), 'catchup', USER)
    expect(chaosCounters()?.catchup_requests).toBe(1)
  })

  it('closes the transport of targeted sockets and sees the person come back', () => {
    const close = vi.fn()
    const s = fakeSocket('old')
    s.conn = { close }
    const bystander = fakeSocket('b')
    bystander.conn = { close: vi.fn() }
    wrapChaosWrite(
      s,
      () => {},
      () => USER
    )
    wrapChaosWrite(
      bystander,
      () => {},
      () => 'other'
    )
    const io = {
      of: () => ({
        sockets: new Map([
          ['old', s],
          ['b', bystander]
        ])
      })
    } as any
    applyChaos(
      spec({ fault: { latency_ms: 0, drop_pct: 0, disconnect: 'once', disconnect_every_s: 30 } }),
      io
    )
    expect(close).toHaveBeenCalledTimes(1)
    expect(bystander.conn.close).not.toHaveBeenCalled()
    expect(chaosCounters()).toMatchObject({ disconnects: 1, disconnected_users: 1, reconnected: 0 })
    noteChaosInbound(s, 'collection:join', USER)
    expect(chaosCounters()?.reconnected).toBe(0)
    noteChaosInbound(fakeSocket('new'), 'collection:join', USER)
    expect(chaosCounters()?.reconnected).toBe(1)
  })

  it('adds up replicas', () => {
    const row = {
      node: 'a',
      sockets: 2,
      users: 1,
      packets: 10,
      delayed: 3,
      dropped: 1,
      disconnects: 1,
      reconnected: 1,
      disconnected_users: 1,
      catchup_requests: 1,
      catchup_replayed: 1,
      catchup_full: 0,
      updated_at: 0
    }
    expect(sumCounters([row, { ...row, node: 'b' }]).packets).toBe(20)
  })

  it('refuses to start in production without the flag', async () => {
    const env = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    delete process.env.CHAOS_ENABLED
    await expect(
      startChaos(
        { target: { kind: 'user', user_id: USER }, fault: { drop_pct: 10 } },
        { id: null, name: null }
      )
    ).rejects.toMatchObject({ statusCode: 403 })
    process.env.NODE_ENV = env
  })
})
