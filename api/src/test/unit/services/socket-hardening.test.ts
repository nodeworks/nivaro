import type { Knex } from 'knex'
import { Server } from 'socket.io'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWithTenantDb } from '../../../db/tenant-context.js'
import { bumpAccessStamp } from '../../../services/access-stamp.js'
import {
  cloudUserRoom,
  ownUserRoom,
  scopeUserRoomsPerTenant
} from '../../../services/cloud-user-rooms.js'
import {
  __resetFieldChangeRelay,
  fieldChangeDelivery,
  fieldNameDelivery,
  isMachineViewer,
  presenceNameTarget,
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
  afterEach(() => __resetFieldChangeRelay())
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

  it('a field reader gets the value; a non-reader gets nothing, not even the name (L4)', async () => {
    const out = await fieldChangeDelivery(
      [v('s1', 'admin'), v('s2', 'narrow'), v('s3', 'wide'), v('s4', 'gone')],
      'orders',
      'cost',
      deps({ admin: null, narrow: ['qty'], wide: ['*'] })
    )
    expect(out.valueTo.sort()).toEqual(['s1', 's3'])
    expect(out.nameTo).toEqual([])
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
    expect(out.nameTo).toEqual([])
  })

  it('an API-key socket gets nothing (its key may narrow the field list)', async () => {
    const out = await fieldChangeDelivery(
      [v('k', 'admin', 'apikey')],
      'orders',
      'cost',
      deps({ admin: null })
    )
    expect(out).toEqual({ valueTo: [], nameTo: [] })
  })

  it('a socket whose sign-in kind is missing or unknown gets nothing', async () => {
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
    expect(out.nameTo).toEqual([])
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
      expect(out.nameTo).toEqual([])
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
    expect(out).toEqual({ valueTo: [], nameTo: [] })
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

  it('M1: a field list is keyed on role + access stamp — a re-check or role change asks again', async () => {
    let role = 'R1'
    let list: string[] = ['cost']
    let clock = 0
    const allowed = vi.fn(async () => list)
    const d: RelayDeps = {
      loadUser: async (id) => ({ id, role }) as never,
      allowedFields: allowed,
      valueFields: async () => ORDER_VALUE_FIELDS,
      now: () => clock
    }
    expect((await fieldChangeDelivery([v('s', 'a')], 'orders', 'cost', d)).valueTo).toEqual(['s'])
    // Access taken away: an access re-check (forgetJoinVerdicts → bumpAccessStamp, also a
    // config write / epoch move) makes the very next keystroke judged on the new list — not
    // after the 30 s TTL.
    list = ['qty']
    bumpAccessStamp()
    expect(await fieldChangeDelivery([v('s', 'a')], 'orders', 'cost', d)).toEqual({
      valueTo: [],
      nameTo: []
    })
    expect(allowed).toHaveBeenCalledTimes(2)
    // A role change is its own key: once the person row is read again (5 s), the list is too,
    // though the 30 s list TTL has not run out.
    list = ['cost']
    role = 'R2'
    clock += 6_000
    expect((await fieldChangeDelivery([v('s', 'a')], 'orders', 'cost', d)).valueTo).toEqual(['s'])
    expect(allowed).toHaveBeenCalledTimes(3)
  })

  it('M1: `fresh` (the co-edit room re-check) never answers from the cache', async () => {
    const allowed = vi.fn(async () => ['cost'])
    const d: RelayDeps = {
      loadUser: async (id) => ({ id, role: 'R' }) as never,
      allowedFields: allowed,
      valueFields: async () => ORDER_VALUE_FIELDS,
      now: () => 0
    }
    await fieldChangeDelivery([v('s', 'a')], 'orders', 'cost', d)
    await fieldChangeDelivery([v('s', 'a')], 'orders', 'cost', d, { fresh: true })
    await fieldChangeDelivery([v('s', 'a')], 'orders', 'cost', d, { fresh: true })
    expect(allowed).toHaveBeenCalledTimes(3)
  })

  it('L6: a machine account (not a placeholder) is never sent a value or a name', async () => {
    const d: RelayDeps = {
      loadUser: async (id) =>
        ({
          id,
          role: 'R',
          account_kind: id === 'bot' ? 'integration' : id === 'ph' ? 'placeholder' : null
        }) as never,
      allowedFields: async () => null,
      valueFields: async () => ORDER_VALUE_FIELDS,
      now: () => 0
    }
    const out = await fieldChangeDelivery(
      [v('s-bot', 'bot'), v('s-ph', 'ph'), v('s-person', 'person')],
      'orders',
      'cost',
      d
    )
    expect(out.valueTo.sort()).toEqual(['s-person', 's-ph'])
    expect(await fieldNameDelivery([v('s-bot', 'bot')], 'orders', 'cost', d)).toEqual([])
    expect(isMachineViewer({ account_kind: 'bot' })).toBe(true)
    expect(isMachineViewer({ account_kind: 'placeholder' })).toBe(false)
    expect(isMachineViewer({ account_kind: null })).toBe(false)
  })

  it('L4: presence field names reach the field readers only (fields, row and cell marks)', async () => {
    const d: RelayDeps = {
      loadUser: async (id) => ({ id, role: 'R' }) as never,
      allowedFields: async (u, c) => {
        const id = (u as { id: string }).id
        if (id === 'admin') return null
        if (c === 'order_lines') return id === 'lines' ? ['price'] : []
        return id === 'narrow' ? ['qty'] : ['cost', 'qty']
      },
      valueFields: async () => ORDER_VALUE_FIELDS,
      now: () => 0
    }
    const all = [
      v('s-admin', 'admin'),
      v('s-narrow', 'narrow'),
      v('s-lines', 'lines'),
      v('s-key', 'admin', 'apikey')
    ]
    expect((await fieldNameDelivery(all, 'orders', 'cost', d)).sort()).toEqual([
      's-admin',
      's-lines'
    ])
    // row:<child collection>:<id> — readers of the child collection at all.
    expect((await fieldNameDelivery(all, 'orders', 'row:order_lines:9', d)).sort()).toEqual([
      's-admin',
      's-lines'
    ])
    // cell:<child collection>:<row>:<field> — readers of that child field.
    expect((await fieldNameDelivery(all, 'orders', 'cell:order_lines:9:price', d)).sort()).toEqual([
      's-admin',
      's-lines'
    ])
    expect(await fieldNameDelivery(all, 'orders', 'cell:order_lines:9:cost', d)).toEqual([
      's-admin'
    ])
    // Made-up shapes name nothing to anyone.
    expect(await fieldNameDelivery(all, 'orders', 'a:b', d)).toEqual([])
    expect(presenceNameTarget('orders', 'cost')).toEqual({ collection: 'orders', field: 'cost' })
    expect(presenceNameTarget('orders', 'row:x:1')).toEqual({ collection: 'x', field: null })
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
