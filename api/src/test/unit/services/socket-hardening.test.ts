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
  fieldChangeDelivery,
  type RelayDeps,
  relayableValue,
  relayViewers
} from '../../../services/field-change-relay.js'
import {
  boardPeerViewers,
  boardViewerEntry,
  resetBoard,
  setPeerBoardsForTests
} from '../../../services/realtime-board.js'
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

describe('field:change values go only to sockets whose person may read the field', () => {
  // `cost` and `qty` are plain fields of orders; `card_no` is encrypted (left out of the
  // value-field set, as loadValueFields does for is_encrypted / credential / concealed fields).
  const ORDER_VALUE_FIELDS = new Set(['cost', 'qty'])
  const deps = (
    fields: Record<string, string[] | null>,
    valueFields: (c: string) => Set<string> = (c) =>
      c === 'orders' ? ORDER_VALUE_FIELDS : new Set()
  ): RelayDeps => ({
    loadUser: async (id) => (id in fields ? ({ id, role: 'R' } as never) : null),
    allowedFields: async (u) => fields[(u as { id: string }).id] as string[] | null,
    valueFields: async (c) => valueFields(c),
    now: () => 0
  })
  const v = (socket: string, id: string, kind: string | undefined = 'session') => ({
    socket,
    id,
    kind
  })

  it('a field reader gets the value; a non-reader gets the name only', async () => {
    const out = await fieldChangeDelivery(
      [v('s1', 'admin'), v('s2', 'narrow'), v('s3', 'wide'), v('s4', 'gone')],
      'orders',
      'cost',
      deps({ admin: null, narrow: ['qty'], wide: ['*'] })
    )
    expect(out.valueTo.sort()).toEqual(['s1', 's3'])
    expect(out.nameTo.sort()).toEqual(['s2', 's4'])
  })

  it('an encrypted field never carries its value, even to someone who may read it', async () => {
    const out = await fieldChangeDelivery(
      [v('s1', 'admin'), v('s2', 'wide')],
      'orders',
      'card_no',
      deps({ admin: null, wide: ['*'] })
    )
    expect(out).toEqual({ valueTo: [], nameTo: ['s1', 's2'] })
  })

  it('the real value-field set leaves out encrypted, credential, concealed and to-many fields', async () => {
    vi.resetModules()
    vi.doMock('../../../services/collections.js', () => ({
      getFields: async () =>
        ['cost', 'card_no', 'pin', 'static_token', 'lines', 'note'].map((field) => ({
          field,
          interface: field === 'pin' ? 'input-password' : 'input',
          special: null
        })),
      getRelations: async () => [
        { many_collection: 'order_lines', one_collection: 'orders', one_field: 'lines' }
      ]
    }))
    vi.doMock('../../../services/encryption.js', () => ({
      getEncryptedFields: async () => ['card_no']
    }))
    vi.doMock('../../../services/permissions.js', () => ({
      getAllowedFields: async () => null
    }))
    vi.doMock('../../../db/index.js', () => ({
      db: () => ({ where: () => ({ first: async () => ({ id: 'admin', role: 'A' }) }) })
    }))
    try {
      const relay = await import('../../../services/field-change-relay.js')
      const viewers = [v('s1', 'admin')]
      for (const field of ['card_no', 'pin', 'static_token', 'lines', 'row:7', 'nope']) {
        const out = await relay.fieldChangeDelivery(viewers, 'orders', field)
        expect({ field, ...out }).toEqual({ field, valueTo: [], nameTo: ['s1'] })
      }
      expect(await relay.fieldChangeDelivery(viewers, 'orders', 'note')).toEqual({
        valueTo: ['s1'],
        nameTo: []
      })
      // System collections never carry values, whoever is watching.
      expect(await relay.fieldChangeDelivery(viewers, 'nivaro_users', 'email')).toEqual({
        valueTo: [],
        nameTo: ['s1']
      })
      relay.__resetFieldChangeRelay()
    } finally {
      vi.doUnmock('../../../services/collections.js')
      vi.doUnmock('../../../services/encryption.js')
      vi.doUnmock('../../../services/permissions.js')
      vi.doUnmock('../../../db/index.js')
      vi.resetModules()
    }
  })

  it('a View-as socket is judged as the viewed person, not the admin behind it', async () => {
    // The admin `rob` views as `beth`: the socket is signed in as beth (id beth, kind masq).
    // beth may not read cost, so that socket gets the name only, though rob could read it.
    const out = await fieldChangeDelivery(
      [v('rob-own-tab', 'rob', 'session'), v('rob-as-beth', 'beth', 'masq')],
      'orders',
      'cost',
      deps({ rob: null, beth: ['qty'] })
    )
    expect(out.valueTo).toEqual(['rob-own-tab'])
    expect(out.nameTo).toEqual(['rob-as-beth'])
  })

  it('an API-key socket gets the name only', async () => {
    const out = await fieldChangeDelivery(
      [v('k', 'admin', 'apikey')],
      'orders',
      'cost',
      deps({ admin: null })
    )
    expect(out).toEqual({ valueTo: [], nameTo: ['k'] })
  })

  it('a socket whose sign-in kind is missing or unknown gets the name only', async () => {
    const out = await fieldChangeDelivery(
      [
        v('known', 'admin'),
        { socket: 'missing', id: 'admin' },
        v('odd', 'admin', 'carrier-pigeon')
      ],
      'orders',
      'cost',
      deps({ admin: null })
    )
    expect(out.valueTo).toEqual(['known'])
    expect(out.nameTo.sort()).toEqual(['missing', 'odd'])
  })

  it('the board publishes the bind kind, and a peer viewer is judged by it (fail closed)', async () => {
    // Publishing side: the entry carries the kind when known, and has no kind otherwise.
    expect(boardViewerEntry('s1', { id: 'u', name: 'U' }, 'apikey')).toEqual({
      socket: 's1',
      id: 'u',
      name: 'U',
      kind: 'apikey'
    })
    expect(boardViewerEntry('s2', { id: 'u', name: 'U' })).toEqual({
      socket: 's2',
      id: 'u',
      name: 'U'
    })
    // Reading side: three viewers on ANOTHER process — a session, an API key, and one from an
    // older process that publishes no kind.
    const room = 'record:orders:7'
    setPeerBoardsForTests([
      {
        node: 'other-replica',
        at: Date.now(),
        sockets: 3,
        users: ['admin'],
        viewers: {
          [room]: [
            boardViewerEntry('peer-session', { id: 'admin', name: 'A' }, 'session'),
            boardViewerEntry('peer-key', { id: 'admin', name: 'A' }, 'apikey'),
            { socket: 'peer-old', id: 'admin', name: 'A' }
          ]
        },
        pages: []
      }
    ])
    try {
      const viewers = relayViewers(
        [['local-tab', { id: 'admin' }]],
        () => 'session',
        boardPeerViewers(room)
      )
      expect(viewers.map((x) => [x.socket, x.kind])).toEqual([
        ['local-tab', 'session'],
        ['peer-session', 'session'],
        ['peer-key', 'apikey'],
        ['peer-old', undefined]
      ])
      const out = await fieldChangeDelivery(viewers, 'orders', 'cost', deps({ admin: null }))
      expect(out.valueTo.sort()).toEqual(['local-tab', 'peer-session'])
      expect(out.nameTo.sort()).toEqual(['peer-key', 'peer-old'])
    } finally {
      resetBoard()
    }
  })

  it('a failing permission read keeps the value back', async () => {
    const out = await fieldChangeDelivery([v('s', 'x')], 'orders', 'cost', {
      ...deps({ x: ['cost'] }),
      allowedFields: async () => {
        throw new Error('db away')
      }
    })
    expect(out).toEqual({ valueTo: [], nameTo: ['s'] })
  })

  it('caches the answers per viewer + collection and per collection', async () => {
    const allowed = vi.fn(async () => ['cost'])
    const valueFields = vi.fn(async () => ORDER_VALUE_FIELDS)
    const d: RelayDeps = {
      loadUser: async (id) => ({ id }) as never,
      allowedFields: allowed,
      valueFields,
      now: () => 0
    }
    await fieldChangeDelivery([v('s', 'a')], 'orders', 'cost', d)
    await fieldChangeDelivery([v('s', 'a')], 'orders', 'qty', d)
    expect(allowed).toHaveBeenCalledTimes(1)
    expect(valueFields).toHaveBeenCalledTimes(1)
  })

  it('only scalar values travel', () => {
    expect(relayableValue('abc')).toBe(true)
    expect(relayableValue(3)).toBe(true)
    expect(relayableValue(false)).toBe(true)
    expect(relayableValue(null)).toBe(true)
    expect(relayableValue({ secret: 1 })).toBe(false)
    expect(relayableValue(['x'])).toBe(false)
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
