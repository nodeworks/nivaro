import type { Knex } from 'knex'
import { Server } from 'socket.io'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWithTenantDb } from '../../../db/tenant-context.js'
import {
  cloudUserRoom,
  ownUserRoom,
  scopeUserRoomsPerTenant
} from '../../../services/cloud-user-rooms.js'
import {
  __resetFieldChangeRelay,
  fieldValueAudience,
  type RelayDeps
} from '../../../services/field-change-relay.js'
import {
  createSocketLimiter,
  eventClass,
  SOCKET_BUCKETS,
  socketRateLimitOn
} from '../../../services/socket-rate-limit.js'

function inTenant<T>(id: string, fn: () => T): T {
  let out: T
  runWithTenantDb(
    {} as Knex,
    `slug-${id}`,
    () => {
      out = fn()
    },
    id
  )
  return out!
}

afterEach(() => {
  vi.unstubAllEnvs()
  __resetFieldChangeRelay()
})

describe('per-socket rate limit (M10)', () => {
  it('classifies events', () => {
    expect(eventClass('auth')).toBe('auth')
    expect(eventClass('huddle:signal')).toBe('signal')
    expect(eventClass('record:join')).toBe('join')
    expect(eventClass('chat:join')).toBe('join')
    expect(eventClass('presence:watch')).toBe('join')
    expect(eventClass('page:at')).toBe('join')
    expect(eventClass('field:change')).toBe('other')
  })

  it('lets a full bucket through, then drops, then refills over time', () => {
    let t = 0
    const limiter = createSocketLimiter(() => t)
    const cap = SOCKET_BUCKETS.join.capacity
    for (let i = 0; i < cap; i++) expect(limiter.allow('record:join')).toBe(true)
    expect(limiter.allow('record:join')).toBe(false)
    expect(limiter.dropped).toBe(1)
    // Other classes have their own buckets.
    expect(limiter.allow('field:change')).toBe(true)
    t += 1000
    for (let i = 0; i < SOCKET_BUCKETS.join.refillPerSec; i++)
      expect(limiter.allow('record:join')).toBe(true)
    expect(limiter.allow('record:join')).toBe(false)
  })

  it('normal use never meets the limit: 4 keystrokes/s + a page ping a second for an hour', () => {
    let t = 0
    const limiter = createSocketLimiter(() => t)
    for (let s = 0; s < 3600; s++) {
      for (let k = 0; k < 4; k++) expect(limiter.allow('field:change')).toBe(true)
      expect(limiter.allow('page:at')).toBe(true)
      t += 1000
    }
  })

  it('sign-in attempts are limited hard', () => {
    const limiter = createSocketLimiter(() => 0)
    let ok = 0
    for (let i = 0; i < 100; i++) if (limiter.allow('auth')) ok++
    expect(ok).toBe(SOCKET_BUCKETS.auth.capacity)
  })

  it('SOCKET_RATE_LIMIT=off turns it off; the scale multiplies buckets', () => {
    vi.stubEnv('SOCKET_RATE_LIMIT', 'off')
    expect(socketRateLimitOn()).toBe(false)
    vi.stubEnv('SOCKET_RATE_LIMIT', '')
    expect(socketRateLimitOn()).toBe(true)
    vi.stubEnv('SOCKET_RATE_LIMIT_SCALE', '2')
    const limiter = createSocketLimiter(() => 0)
    let ok = 0
    for (let i = 0; i < 100; i++) if (limiter.allow('auth')) ok++
    expect(ok).toBe(SOCKET_BUCKETS.auth.capacity * 2)
  })
})

describe('field:change values follow the viewer field list (M6)', () => {
  const deps = (fields: Record<string, string[] | null>): RelayDeps => ({
    loadUser: async (id) => (id in fields ? ({ id, role: 'R' } as never) : null),
    allowedFields: async (u) => fields[(u as { id: string }).id] as string[] | null,
    now: () => 0
  })

  it('splits viewers into readers and others', async () => {
    const out = await fieldValueAudience(
      ['admin', 'narrow', 'wide', 'gone'],
      'orders',
      'cost',
      deps({ admin: null, narrow: ['qty'], wide: ['*'] })
    )
    expect(out.readers.sort()).toEqual(['admin', 'wide'])
    expect(out.others.sort()).toEqual(['gone', 'narrow'])
  })

  it('a failing permission read keeps the value back', async () => {
    const out = await fieldValueAudience(['x'], 'orders', 'cost', {
      loadUser: async () => ({ id: 'x' }) as never,
      allowedFields: async () => {
        throw new Error('db away')
      },
      now: () => 0
    })
    expect(out).toEqual({ readers: [], others: ['x'] })
  })

  it('caches the answer per viewer and collection', async () => {
    const allowed = vi.fn(async () => ['cost'])
    const d: RelayDeps = {
      loadUser: async (id) => ({ id }) as never,
      allowedFields: allowed,
      now: () => 0
    }
    await fieldValueAudience(['a'], 'orders', 'cost', d)
    await fieldValueAudience(['a'], 'orders', 'qty', d)
    expect(allowed).toHaveBeenCalledTimes(1)
  })
})

describe('personal rooms are per tenant in cloud mode (Low: user: rooms)', () => {
  it('self-hosted names are unchanged', () => {
    expect(cloudUserRoom('user:U1', 'A')).toBe('user:U1')
    expect(ownUserRoom('U1', 'A')).toBe('user:U1')
  })

  it('cloud: own room and broadcasts carry the tenant; other rooms untouched', () => {
    vi.stubEnv('CLOUD_META_DB_URL', 'postgres://meta')
    expect(ownUserRoom('U1', 'A')).toBe('t:A:user:U1')
    expect(cloudUserRoom('user:U1', 'A')).toBe('t:A:user:U1')
    expect(cloudUserRoom('replay:abc', 'A')).toBe('replay:abc')
    expect(cloudUserRoom('user:U1', '')).toBe('user:U1')

    const io = new Server()
    scopeUserRoomsPerTenant(io)
    const rooms = (op: unknown) => [...((op as { rooms: Set<string> }).rooms ?? [])]
    inTenant('A', () => {
      expect(rooms(io.to('user:U1'))).toEqual(['t:A:user:U1'])
      expect(rooms(io.to(['user:U1', 'chat:x']).to('user:U2'))).toEqual([
        't:A:user:U1',
        'chat:x',
        't:A:user:U2'
      ])
      expect(rooms(io.in('user:U3'))).toEqual(['t:A:user:U3'])
    })
  })
})
