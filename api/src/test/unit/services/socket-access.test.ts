import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../auth/session.js', () => ({ REVOKED_PREFIX: 'sess:revoked:' }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/collections.js', () => ({
  getCollection: vi.fn(async (n: string) => (n === 'orders' ? { collection: 'orders' } : undefined))
}))
vi.mock('../../../services/chat.js', () => ({ canSeeRoom: vi.fn(async () => true) }))
vi.mock('../../../services/io-holder.js', () => ({ getIo: vi.fn(() => null) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/record-access.js', () => ({
  compileAccessGates: vi.fn(async () => ({})),
  visibleIds: vi.fn(async (_g: unknown, ids: string[]) => new Set(ids))
}))
vi.mock('../../../services/socket-tenant.js', () => ({
  inSocketTenant:
    (_s: unknown, fn: (...a: unknown[]) => Promise<void>) =>
    (...a: unknown[]) =>
      fn(...a)
}))

import { db } from '../../../db/index.js'
import { canSeeRoom } from '../../../services/chat.js'
import { getIo } from '../../../services/io-holder.js'
import { can } from '../../../services/permissions.js'
import { visibleIds } from '../../../services/record-access.js'
import {
  bindFromRequest,
  bindVerdict,
  canSeeRecordRoom,
  checkBind,
  encodeBoundToken,
  endRoomSockets,
  isKnownCollection,
  masqRoom,
  parseWsTokenValue,
  RECHECK_EVENT,
  recheckSocketRooms,
  requestAccessRecheck,
  roomStillAllowed,
  runLocalRecheck,
  type SocketAccessHooks,
  type SocketBind,
  sessionRoom,
  sha,
  sweepSockets
} from '../../../services/socket-access.js'
import type { User } from '../../../types.js'

const ANA = { id: 'ANA', role: 'R-EDITOR', status: 'active' } as unknown as User

/** db(table) → admin_access lookups, fresh user rows and API key rows. */
function mockDb(
  opts: {
    admin?: boolean
    users?: Array<Record<string, unknown>>
    keys?: Array<Record<string, unknown>>
  } = {}
) {
  vi.mocked(db).mockImplementation(((table: string) => {
    const b: Record<string, unknown> = {}
    b.where = vi.fn(() => b)
    b.whereIn = vi.fn(() => b)
    b.first = vi.fn(async () => (table === 'nivaro_roles' ? { admin_access: !!opts.admin } : null))
    b.select = vi.fn(async () =>
      table === 'nivaro_api_keys' ? (opts.keys ?? []) : (opts.users ?? [])
    )
    return b
  }) as never)
}

function fakeSocket(user: User, rooms: string[], data: Record<string, unknown> = {}) {
  let current = user
  const left: string[] = []
  const emitted: Array<[string, unknown]> = []
  const hooks: SocketAccessHooks = {
    user: () => current,
    applyUser: (u) => {
      current = u
    },
    leaveRoom: (r) => left.push(r)
  }
  const socket = {
    id: 'sock1',
    rooms: new Set(['sock1', ...rooms]),
    data: { nvrAccess: hooks, ...data },
    emit: vi.fn((ev: string, p: unknown) => emitted.push([ev, p])),
    leave: vi.fn(),
    disconnect: vi.fn()
  }
  return { socket, left, emitted, current: () => current }
}

function fakeIo(sockets: unknown[]) {
  return {
    sockets: { sockets: new Map(sockets.map((s, i) => [`s${i}`, s])) },
    serverSideEmit: vi.fn(),
    to: vi.fn(() => ({ emit: vi.fn() })),
    in: vi.fn(() => ({ disconnectSockets: vi.fn() }))
  }
}

beforeEach(() => mockDb())
afterEach(() => vi.clearAllMocks())

describe('ws-token binding (#1719, H1)', () => {
  it('round-trips every bind kind', () => {
    for (const bind of [
      { kind: 'session', sid: 'sid1' },
      { kind: 'masq', token: 'nvm_x' },
      { kind: 'token', tokenHash: sha('t') },
      { kind: 'apikey', id: 7 },
      { kind: 'apikey', id: 7, sim: 'nvq_1' }
    ] as SocketBind[])
      expect(parseWsTokenValue(encodeBoundToken('ANA', bind))).toEqual({ userId: 'ANA', bind })
  })
  it('a bare user id (older API) or a bind with nothing in it signs nothing in', () => {
    expect(parseWsTokenValue('ANA').bind).toBeNull()
    expect(parseWsTokenValue('{"u":"ANA"}').bind).toBeNull()
    expect(parseWsTokenValue('{"u":"ANA","b":{"kind":"token","tokenHash":""}}').bind).toBeNull()
  })
  it('reads the bind from how the request signed in', () => {
    const bearer = (t: string) => ({ authorization: `Bearer ${t}` })
    expect(bindFromRequest({ authMethod: 'session', session: { sessionId: 's1' } })).toEqual({
      kind: 'session',
      sid: 's1'
    })
    expect(bindFromRequest({ authMethod: 'masquerade', headers: bearer('nvm_a') })).toEqual({
      kind: 'masq',
      token: 'nvm_a'
    })
    expect(
      bindFromRequest({ authMethod: 'api_key', apiKeyId: 12, headers: bearer('nvk_x') })
    ).toEqual({ kind: 'apikey', id: 12 })
    expect(
      bindFromRequest({ authMethod: 'key_sim', apiKeySimulatedId: 12, headers: bearer('nvq_y') })
    ).toEqual({ kind: 'apikey', id: 12, sim: 'nvq_y' })
    expect(bindFromRequest({ authMethod: 'token', headers: bearer('static') })).toEqual({
      kind: 'token',
      tokenHash: sha('static')
    })
    expect(bindFromRequest({ authMethod: 'api_key' })).toBeNull()
    expect(bindFromRequest({})).toBeNull()
  })
  it('names rooms without putting a masquerade token in them', () => {
    expect(sessionRoom('sid1')).toBe('session:sid1')
    expect(masqRoom('nvm_secret')).toBe(`masq:${sha('nvm_secret')}`)
    expect(masqRoom('nvm_secret')).not.toContain('nvm_secret')
  })
})

describe('room gates (#1720)', () => {
  const notAdmin = async () => false

  it("keeps the person's own user room and refuses someone else's", async () => {
    expect(await roomStillAllowed(ANA, 'user:ana', notAdmin)).toBe(true)
    expect(await roomStillAllowed(ANA, 'user:BOB', notAdmin)).toBe(false)
  })
  it('re-runs the collection read permission', async () => {
    vi.mocked(can).mockResolvedValueOnce(false)
    expect(await roomStillAllowed(ANA, 'collection:orders', notAdmin)).toBe(false)
  })
  it('re-runs the record gate (row filter + scopes)', async () => {
    vi.mocked(visibleIds).mockResolvedValueOnce(new Set())
    expect(await roomStillAllowed(ANA, 'record:orders:7', notAdmin)).toBe(false)
    expect(await roomStillAllowed(ANA, 'record:orders:7', notAdmin)).toBe(true)
  })
  it('asks canSeeRoom for chat rooms', async () => {
    vi.mocked(canSeeRoom).mockResolvedValueOnce(false)
    expect(await roomStillAllowed(ANA, 'chat:dm:ana:bob', notAdmin)).toBe(false)
  })
  it('keeps admin rooms for administrators only', async () => {
    expect(await roomStillAllowed(ANA, 'watch:traffic', notAdmin)).toBe(false)
    expect(await roomStillAllowed(ANA, 'presence:admin', notAdmin)).toBe(false)
    expect(await roomStillAllowed(ANA, 'pulse', async () => true)).toBe(true)
  })
  it('gates a cloud tenant-prefixed room by the room it names (#1720)', async () => {
    vi.mocked(visibleIds).mockResolvedValueOnce(new Set())
    expect(await roomStillAllowed(ANA, 't:A:record:orders:7', notAdmin)).toBe(false)
    vi.mocked(can).mockResolvedValueOnce(false)
    expect(await roomStillAllowed(ANA, 't:A:collection:orders', notAdmin)).toBe(false)
  })
  it('gates live operations rooms by their topic (ops-live.ts)', async () => {
    const admin = async () => true
    for (const t of ['readiness', 'broadcasts', 'issue:42']) {
      expect(await roomStillAllowed(ANA, `t:A:ops:${t}`, notAdmin)).toBe(false)
      expect(await roomStillAllowed(ANA, `ops:${t}`, admin)).toBe(true)
    }
    for (const t of ['issues', 'support', 'team', 'delegation', 'my-work'])
      expect(await roomStillAllowed(ANA, `t:A:ops:${t}`, notAdmin)).toBe(true)
    expect(await roomStillAllowed(ANA, 'ops:bogus', notAdmin)).toBe(false)
  })
  it("keeps the tenant-wide `all` room for the socket's own tenant only", async () => {
    const ctx = { tenantNames: ['T-A', 'acme'] }
    expect(await roomStillAllowed(ANA, 't:T-A:all', notAdmin, ctx)).toBe(true)
    expect(await roomStillAllowed(ANA, 't:T-B:all', notAdmin, ctx)).toBe(false)
    expect(await roomStillAllowed(ANA, 'all', notAdmin, ctx)).toBe(false)
  })
  it('gates watch:conformance (and any watch room) for administrators', async () => {
    expect(await roomStillAllowed(ANA, 't:A:watch:conformance', notAdmin)).toBe(false)
    expect(await roomStillAllowed(ANA, 't:A:watch:conformance', async () => true)).toBe(true)
  })
  it('keeps page presence for any signed-in person', async () => {
    expect(await roomStillAllowed(ANA, 'presence:some-page', notAdmin)).toBe(true)
  })
  it('denies a room kind it does not know, unless the socket is an administrator (H3)', async () => {
    expect(await roomStillAllowed(ANA, 'mystery:42', notAdmin)).toBe(false)
    expect(await roomStillAllowed(ANA, 't:A:mystery:42', notAdmin)).toBe(false)
    expect(await roomStillAllowed(ANA, 'mystery:42', async () => true)).toBe(true)
  })
  it('gates item rooms like record rooms (H3)', async () => {
    vi.mocked(visibleIds).mockResolvedValueOnce(new Set())
    expect(await roomStillAllowed(ANA, 't:A:item:orders:7', notAdmin)).toBe(false)
    expect(await roomStillAllowed(ANA, 'item:orders:7', notAdmin)).toBe(true)
  })
  it("keeps only the socket's own sign-in rooms", async () => {
    const bind: SocketBind = { kind: 'session', sid: 's1' }
    expect(await roomStillAllowed(ANA, sessionRoom('s1'), notAdmin, { bind })).toBe(true)
    expect(await roomStillAllowed(ANA, sessionRoom('s2'), notAdmin, { bind })).toBe(false)
    expect(await roomStillAllowed(ANA, masqRoom('nvm_x'), notAdmin, { bind })).toBe(false)
  })
  it("keeps a tenant room only for the socket's own tenant in cloud mode", async () => {
    vi.stubEnv('CLOUD_META_DB_URL', 'postgres://meta')
    const ctx = { tenantNames: ['T-A', 'acme'] }
    expect(await roomStillAllowed(ANA, 'tenant:acme', notAdmin, ctx)).toBe(true)
    expect(await roomStillAllowed(ANA, 'tenant:T-B', notAdmin, ctx)).toBe(false)
    vi.unstubAllEnvs()
    expect(await roomStillAllowed(ANA, 'tenant:T-B', notAdmin, ctx)).toBe(true)
  })
  it('lets an administrator into any record room without a row check', async () => {
    expect(await canSeeRecordRoom(ANA, 'orders', '7', true)).toBe(true)
    expect(visibleIds).not.toHaveBeenCalled()
  })
  it('matches record ids case-insensitively (MSSQL upper-cases uuids)', async () => {
    vi.mocked(visibleIds).mockResolvedValueOnce(new Set(['ABC-1']))
    expect(await canSeeRecordRoom(ANA, 'orders', 'abc-1', false)).toBe(true)
  })
  it('refuses on a gate error rather than guessing', async () => {
    vi.mocked(can).mockRejectedValueOnce(new Error('db down'))
    expect(await canSeeRecordRoom(ANA, 'orders', '7', false)).toBe(false)
  })

  it('recheckSocketRooms leaves exactly the rooms that no longer pass', async () => {
    vi.mocked(can).mockImplementation(async (_u, _a, c) => c !== 'secret')
    const { socket, left } = fakeSocket(ANA, ['user:ANA', 'collection:orders', 'collection:secret'])
    const out = await recheckSocketRooms(socket as never, ANA)
    expect(out).toEqual(['collection:secret'])
    expect(left).toEqual(['collection:secret'])
    vi.mocked(can).mockImplementation(async () => true)
  })
})

describe('sweepSockets (#1719)', () => {
  function redisWith(values: Record<string, string | null>, fail = false) {
    return {
      mget: vi.fn(async (...keys: string[]) => {
        if (fail) throw new Error('redis down')
        return keys.map((k) => values[k] ?? null)
      })
    }
  }

  it('closes a socket whose session is gone or revoked', async () => {
    mockDb({ users: [{ id: 'ANA', role: 'R-EDITOR', status: 'active' }] })
    const gone = fakeSocket(ANA, [], { nvrBind: { kind: 'session', sid: 'a' } })
    const revoked = fakeSocket(ANA, [], { nvrBind: { kind: 'session', sid: 'b' } })
    const fine = fakeSocket(ANA, [], { nvrBind: { kind: 'session', sid: 'c' } })
    const io = fakeIo([gone.socket, revoked.socket, fine.socket])
    const redis = redisWith({ 'sess:b': '{}', 'sess:revoked:b': '1', 'sess:c': '{}' })
    const closed = await sweepSockets(io as never, { redis: redis as never })
    expect(closed).toBe(2)
    expect(gone.emitted).toContainEqual(['session:ended', { reason: 'signed_out' }])
    expect(revoked.emitted).toContainEqual(['session:ended', { reason: 'signed_out' }])
    expect(fine.emitted).toEqual([])
  })

  it('closes an expired session by the policy judge', async () => {
    mockDb({ users: [{ id: 'ANA', role: 'R-EDITOR', status: 'active' }] })
    const s = fakeSocket(ANA, [], { nvrBind: { kind: 'session', sid: 'a' } })
    const io = fakeIo([s.socket])
    const judge = vi.fn(async () => 'expired' as const)
    await sweepSockets(io as never, {
      redis: redisWith({ 'sess:a': '{"loginAt":1}' }) as never,
      judge
    })
    expect(judge).toHaveBeenCalledWith('R-EDITOR', { loginAt: 1 })
    expect(s.emitted).toContainEqual(['session:ended', { reason: 'expired' }])
  })

  it('closes a suspended account, an ended masquerade and a rotated token', async () => {
    mockDb({
      users: [
        { id: 'ANA', role: 'R', status: 'suspended' },
        { id: 'BOB', role: 'R', status: 'active', static_token: 'new-token' }
      ]
    })
    const BOB = { id: 'BOB', role: 'R', status: 'active' } as unknown as User
    const suspended = fakeSocket(ANA, [], { nvrBind: { kind: 'session', sid: 'a' } })
    const masq = fakeSocket(BOB, [], { nvrBind: { kind: 'masq', token: 'nvm_1' } })
    const rotated = fakeSocket(BOB, [], { nvrBind: { kind: 'token', tokenHash: sha('old') } })
    const io = fakeIo([suspended.socket, masq.socket, rotated.socket])
    await sweepSockets(io as never, { redis: redisWith({ 'sess:a': '{}' }) as never })
    expect(suspended.emitted).toContainEqual(['session:ended', { reason: 'account_inactive' }])
    expect(masq.emitted).toContainEqual(['session:ended', { reason: 'masquerade_ended' }])
    expect(rotated.emitted).toContainEqual(['session:ended', { reason: 'signed_out' }])
  })

  it('re-gates rooms when the role changed, and says which rooms went', async () => {
    mockDb({ users: [{ id: 'ANA', role: 'R-VIEWER', status: 'active' }] })
    vi.mocked(can).mockImplementation(async (_u, _a, c) => c !== 'orders')
    const s = fakeSocket(ANA, ['collection:orders'], { nvrBind: { kind: 'session', sid: 'a' } })
    const io = fakeIo([s.socket])
    await sweepSockets(io as never, { redis: redisWith({ 'sess:a': '{}' }) as never })
    expect(s.current().role).toBe('R-VIEWER')
    expect(s.left).toEqual(['collection:orders'])
    expect(s.emitted).toContainEqual(['access:changed', { rooms_left: ['collection:orders'] }])
    vi.mocked(can).mockImplementation(async () => true)
  })

  it('closes an API-key socket when its key is revoked, expired or re-owned (H1)', async () => {
    mockDb({
      users: [{ id: 'ANA', role: 'R', status: 'active' }],
      keys: [
        { id: 1, user: 'ANA', is_active: true, expires_at: null },
        { id: 2, user: 'ANA', is_active: false, expires_at: null },
        { id: 3, user: 'ANA', is_active: 1, expires_at: '2020-01-01T00:00:00Z' },
        { id: 4, user: 'BOB', is_active: true, expires_at: null }
      ]
    })
    const sockets = [1, 2, 3, 4, 5].map((id) =>
      fakeSocket(ANA, [], { nvrBind: { kind: 'apikey', id } })
    )
    const io = fakeIo(sockets.map((s) => s.socket))
    const closed = await sweepSockets(io as never, { redis: redisWith({}) as never })
    expect(closed).toBe(4)
    expect(sockets[0].emitted).toEqual([])
    for (const s of sockets.slice(1))
      expect(s.emitted).toContainEqual(['session:ended', { reason: 'key_revoked' }])
  })

  it('closes a run-as-key socket when the run-as session ends', async () => {
    mockDb({
      users: [{ id: 'ANA', role: 'R', status: 'active' }],
      keys: [{ id: 1, user: 'ANA', is_active: true, expires_at: null }]
    })
    const live = fakeSocket(ANA, [], { nvrBind: { kind: 'apikey', id: 1, sim: 'nvq_live' } })
    const gone = fakeSocket(ANA, [], { nvrBind: { kind: 'apikey', id: 1, sim: 'nvq_gone' } })
    const io = fakeIo([live.socket, gone.socket])
    await sweepSockets(io as never, { redis: redisWith({ 'keysim:nvq_live': '{}' }) as never })
    expect(live.emitted).toEqual([])
    expect(gone.emitted).toContainEqual(['session:ended', { reason: 'signed_out' }])
  })

  it('never treats a missing or empty bind as "the account alone" (H1)', async () => {
    mockDb({ users: [{ id: 'ANA', role: 'R', status: 'active', static_token: 'tok' }] })
    const unbound = fakeSocket(ANA, [])
    const empty = fakeSocket(ANA, [], { nvrBind: { kind: 'token', tokenHash: '' } })
    const io = fakeIo([unbound.socket, empty.socket])
    expect(await sweepSockets(io as never, { redis: redisWith({}) as never })).toBe(2)
  })

  it('judges nothing when Redis cannot be read', async () => {
    mockDb({ users: [{ id: 'ANA', role: 'R-EDITOR', status: 'active' }] })
    const s = fakeSocket(ANA, [], { nvrBind: { kind: 'session', sid: 'a' } })
    const io = fakeIo([s.socket])
    const closed = await sweepSockets(io as never, { redis: redisWith({}, true) as never })
    expect(closed).toBe(0)
    expect(s.emitted).toEqual([])
  })

  it('skips sockets that never signed in', async () => {
    const anon = { id: 'x', rooms: new Set(['x']), data: {}, emit: vi.fn() }
    const io = fakeIo([anon])
    expect(await sweepSockets(io as never, { redis: redisWith({}) as never })).toBe(0)
  })
})

describe('runLocalRecheck with room prefixes (H4)', () => {
  it('re-gates only matching rooms of sockets that hold one', async () => {
    mockDb({ users: [{ id: 'ANA', role: 'R-EDITOR', status: 'active' }] })
    vi.mocked(canSeeRoom).mockResolvedValue(false)
    vi.mocked(can).mockResolvedValue(false)
    const inChannel = fakeSocket(ANA, ['chat:ch:ops', 'collection:orders'])
    const elsewhere = fakeSocket(ANA, ['collection:orders'])
    const io = fakeIo([inChannel.socket, elsewhere.socket])
    await runLocalRecheck(io as never, { roomPrefixes: ['chat:ch:'] })
    expect(inChannel.left).toEqual(['chat:ch:ops'])
    expect(elsewhere.left).toEqual([])
    vi.mocked(canSeeRoom).mockResolvedValue(true)
    vi.mocked(can).mockResolvedValue(true)
  })
})

describe('checkBind — the SSE stream heartbeat (H1)', () => {
  const redis = (values: Record<string, string>) => ({
    mget: vi.fn(async (...keys: string[]) => keys.map((k) => values[k] ?? null))
  })
  it('ends an API-key stream when the key is revoked', async () => {
    mockDb({
      users: [{ id: 'ANA', status: 'active' }],
      keys: [{ id: 9, user: 'ANA', is_active: false, expires_at: null }]
    })
    expect(await checkBind(redis({}) as never, 'ANA', { kind: 'apikey', id: 9 })).toBe(
      'key_revoked'
    )
  })
  it('keeps a stream whose session still stands, ends it when the session goes', async () => {
    mockDb({ users: [{ id: 'ANA', status: 'active' }] })
    const bind: SocketBind = { kind: 'session', sid: 's1' }
    expect(await checkBind(redis({ 'sess:s1': '{}' }) as never, 'ANA', bind)).toBeNull()
    expect(await checkBind(redis({}) as never, 'ANA', bind)).toBe('signed_out')
    expect(await checkBind(redis({}) as never, 'ANA', null)).toBe('signed_out')
  })
  it('bindVerdict puts an inactive account first', () => {
    expect(
      bindVerdict({ kind: 'session', sid: 's' }, { status: 'suspended' }, new Map(), new Map())
    ).toBe('account_inactive')
  })
})

describe('ending and rechecking across replicas', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('endRoomSockets tells the room, then disconnects it on every replica', () => {
    const emit = vi.fn()
    const disconnectSockets = vi.fn()
    const io = { to: vi.fn(() => ({ emit })), in: vi.fn(() => ({ disconnectSockets })) }
    endRoomSockets('session:s1', 'signed_out', io as never)
    expect(io.to).toHaveBeenCalledWith('session:s1')
    expect(emit).toHaveBeenCalledWith('session:ended', { reason: 'signed_out' })
    expect(disconnectSockets).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(disconnectSockets).toHaveBeenCalledWith(true)
  })

  it('requestAccessRecheck debounces a burst into one cross-replica request', () => {
    const io = fakeIo([])
    vi.mocked(getIo).mockReturnValue(io as never)
    requestAccessRecheck({ userIds: ['ana'] })
    requestAccessRecheck({ userIds: ['bob'] })
    expect(io.serverSideEmit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1500)
    expect(io.serverSideEmit).toHaveBeenCalledTimes(1)
    expect(io.serverSideEmit).toHaveBeenCalledWith(RECHECK_EVENT, {
      all: false,
      userIds: ['ANA', 'BOB']
    })
  })

  it('a channel change re-checks channel rooms only, merged with named people', () => {
    const io = fakeIo([])
    vi.mocked(getIo).mockReturnValue(io as never)
    requestAccessRecheck({ roomPrefixes: ['chat:ch:'] })
    requestAccessRecheck({ userIds: ['ana'] })
    vi.advanceTimersByTime(1500)
    expect(io.serverSideEmit).toHaveBeenCalledWith(RECHECK_EVENT, {
      all: false,
      userIds: ['ANA'],
      roomPrefixes: ['chat:ch:']
    })
  })

  it('a request with no people re-checks everyone', () => {
    const io = fakeIo([])
    vi.mocked(getIo).mockReturnValue(io as never)
    requestAccessRecheck({ userIds: ['ana'] })
    requestAccessRecheck()
    vi.advanceTimersByTime(1500)
    expect(io.serverSideEmit).toHaveBeenCalledWith(RECHECK_EVENT, { all: true, userIds: ['ANA'] })
  })
})

describe('collection:join names (isKnownCollection)', () => {
  it('refuses a name that would spell another room kind, accepts real collections', async () => {
    ;(db as unknown as { schema: unknown }).schema = {
      hasTable: vi.fn(async (n: string) => n === 'user_presence')
    }
    expect(await isKnownCollection('orders:5')).toBe(false)
    expect(await isKnownCollection('t:A:collection')).toBe(false)
    expect(await isKnownCollection('orders')).toBe(true)
    expect(await isKnownCollection('user_presence')).toBe(true)
    expect(await isKnownCollection('nope')).toBe(false)
  })
})
