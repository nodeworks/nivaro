import fastifyCookie from '@fastify/cookie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Review 2026-10-27, cluster E: handshake sessions (A2), auto-batch, parse-once, SSE limits. */

const users = new Map<string, Record<string, unknown>>()
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => {
    let where: Record<string, unknown> = {}
    const b = {
      where: (w: Record<string, unknown>) => {
        where = w
        return b
      },
      first: async () => {
        const u = users.get(String(where.id))
        return u && u.status === where.status ? u : undefined
      }
    }
    return b
  })
}))
vi.mock('../../../services/session-policy.js', () => ({
  getSessionPolicy: async () => ({ max_age_hours: 1 }),
  limitsFor: () => ({ max_age_hours: 1, idle_minutes: null }),
  judgeSession: (_l: unknown, s: { loginAt?: number }) =>
    s.loginAt && Date.now() - s.loginAt > 3_600_000
      ? { ok: false, reason: 'max_age' }
      : { ok: true }
}))
vi.mock('../../../services/event-journal.js', () => ({ journaledEmit: vi.fn(async () => ({})) }))
vi.mock('../../../services/collections.js', () => ({ getCollection: vi.fn(async () => ({})) }))

import { config } from '../../../config.js'
import { sseBufferLimits, staleCollectionFrame } from '../../../routes/events-stream.js'
import {
  autoBatchDue,
  autoBatchPerSecond,
  resetLiveMode
} from '../../../services/collection-live-mode.js'
import {
  handshakeOriginAllowed,
  handshakeSessionUser,
  sessionIdFromCookie
} from '../../../services/socket-handshake-session.js'
import { collectionUpdateOf, encodeEvent } from '../../../services/socket-transport.js'

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
  users.clear()
})

describe('tenant:join by handshake session (A2)', () => {
  const sign = (sid: string) =>
    `nivaro_session=${encodeURIComponent(new fastifyCookie.Signer(config.SESSION_SECRET, 'sha256').sign(sid))}`
  const redis = (values: Record<string, string>) =>
    ({
      mget: vi.fn(async (...keys: string[]) => keys.map((k) => values[k] ?? null))
    }) as unknown as Parameters<typeof handshakeSessionUser>[1]
  const sock = (headers: Record<string, string>) => ({ handshake: { headers } })

  beforeEach(() => {
    users.set('U1', { id: 'U1', status: 'active', role: 'R' })
  })

  it('reads the signed session id; a forged one is refused', () => {
    expect(sessionIdFromCookie(sign('abc'))).toBe('abc')
    expect(sessionIdFromCookie('nivaro_session=abc.forged')).toBeNull()
    expect(sessionIdFromCookie('')).toBeNull()
  })

  it('accepts same-origin (or CORS_ORIGINS) handshakes only', () => {
    expect(handshakeOriginAllowed({ origin: 'https://a.example', host: 'a.example' })).toBe(true)
    expect(handshakeOriginAllowed({ origin: 'https://evil.example', host: 'a.example' })).toBe(
      false
    )
    expect(
      handshakeOriginAllowed({ origin: 'https://app.example', host: 'api.example' }, [
        'https://app.example'
      ])
    ).toBe(true)
    expect(handshakeOriginAllowed({ host: 'a.example' })).toBe(true)
  })

  it('a live session signs the handshake in; revoked, gone, expired or inactive do not', async () => {
    const headers = { origin: 'https://a.example', host: 'a.example', cookie: sign('s1') }
    const live = JSON.stringify({ userId: 'U1', loginAt: Date.now() })
    expect((await handshakeSessionUser(sock(headers), redis({ 'sess:s1': live })))?.sid).toBe('s1')
    expect(
      await handshakeSessionUser(sock(headers), redis({ 'sess:s1': live, 'sess:revoked:s1': '1' }))
    ).toBeNull()
    expect(await handshakeSessionUser(sock(headers), redis({}))).toBeNull()
    const old = JSON.stringify({ userId: 'U1', loginAt: Date.now() - 7_200_000 })
    expect(await handshakeSessionUser(sock(headers), redis({ 'sess:s1': old }))).toBeNull()
    users.set('U1', { id: 'U1', status: 'suspended' })
    expect(await handshakeSessionUser(sock(headers), redis({ 'sess:s1': live }))).toBeNull()
    // Another site opening a socket with the visitor's cookie gets nothing.
    users.set('U1', { id: 'U1', status: 'active' })
    expect(
      await handshakeSessionUser(
        sock({ ...headers, origin: 'https://evil.example' }),
        redis({ 'sess:s1': live })
      )
    ).toBeNull()
  })
})

describe('auto-batch on bursts (live mode on)', () => {
  beforeEach(() => resetLiveMode())

  it('batches past REALTIME_AUTO_BATCH_PER_S in a second, live again after a quiet second', () => {
    process.env.REALTIME_AUTO_BATCH_PER_S = '3'
    const t = 10_000_000
    const due = [0, 1, 2, 3, 4].map((i) => autoBatchDue('orders', t + i))
    expect(due).toEqual([false, false, false, true, true])
    // The next second follows a hot one: still batched.
    expect(autoBatchDue('orders', t + 1000)).toBe(true)
    // A quiet second (one write) → the one after is live.
    expect(autoBatchDue('orders', t + 3000)).toBe(false)
    // Another collection is counted on its own.
    expect(autoBatchDue('items', t + 3000)).toBe(false)
  })

  it('REALTIME_AUTO_BATCH_PER_S=0 turns it off', () => {
    process.env.REALTIME_AUTO_BATCH_PER_S = '0'
    expect(autoBatchPerSecond()).toBe(0)
    for (let i = 0; i < 100; i++) expect(autoBatchDue('orders', 5_000_000)).toBe(false)
  })
})

describe('collection:update parsed once per broadcast', () => {
  it('the same packet string answers the same payload object, encoded back as it came', () => {
    const packet = encodeEvent('collection:update', { collection: 'orders', item: 1, _seq: 9 })
    const parse = vi.spyOn(JSON, 'parse')
    const a = collectionUpdateOf(packet)
    const b = collectionUpdateOf(packet)
    expect(a).toBe(b)
    expect(parse).toHaveBeenCalledTimes(1)
    parse.mockRestore()
    expect(a).toEqual({ collection: 'orders', item: 1, _seq: 9 })
    expect(encodeEvent('collection:update', a)).toBe(packet)
    expect(collectionUpdateOf('2["other",{}]')).toBeNull()
  })
})

describe('SSE backpressure limits', () => {
  it('reads the limits and builds a whole-collection refetch frame', () => {
    expect(sseBufferLimits({})).toEqual({ soft: 262_144, hard: 4_194_304 })
    expect(sseBufferLimits({ SSE_BUFFER_SOFT_BYTES: '10', SSE_BUFFER_HARD_BYTES: '5' })).toEqual({
      soft: 10,
      hard: 10
    })
    const frame = staleCollectionFrame('orders')
    expect(frame.startsWith('event: collection.update\ndata: ')).toBe(true)
    expect(JSON.parse(frame.split('data: ')[1])).toMatchObject({
      collection: 'orders',
      many: true,
      coalesced: true
    })
  })
})
