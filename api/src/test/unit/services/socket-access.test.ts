import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../auth/session.js', () => ({ REVOKED_PREFIX: 'sess:revoked:' }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
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
  canSeeRecordRoom,
  endRoomSockets,
  masqRoom,
  parseWsTokenValue,
  RECHECK_EVENT,
  recheckSocketRooms,
  requestAccessRecheck,
  roomStillAllowed,
  type SocketAccessHooks,
  sessionRoom,
  sha,
  sweepSockets
} from '../../../services/socket-access.js'
import type { User } from '../../../types.js'

const ANA = { id: 'ANA', role: 'R-EDITOR', status: 'active' } as unknown as User

/** db(table) → admin_access lookups and fresh user rows. */
function mockDb(opts: { admin?: boolean; users?: Array<Record<string, unknown>> } = {}) {
  vi.mocked(db).mockImplementation(((table: string) => {
    const b: Record<string, unknown> = {}
    b.where = vi.fn(() => b)
    b.whereIn = vi.fn(() => b)
    b.first = vi.fn(async () => (table === 'nivaro_roles' ? { admin_access: !!opts.admin } : null))
    b.select = vi.fn(async () => opts.users ?? [])
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

describe('ws-token binding (#1719)', () => {
  it('reads the session or masquerade a token was minted from', () => {
    expect(parseWsTokenValue('{"u":"ANA","s":"sid1"}')).toEqual({ userId: 'ANA', sid: 'sid1' })
    expect(parseWsTokenValue('{"u":"ANA","m":"nvm_x"}')).toEqual({ userId: 'ANA', masq: 'nvm_x' })
  })
  it('accepts a bare user id from an older API', () => {
    expect(parseWsTokenValue('ANA')).toEqual({ userId: 'ANA' })
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
  it('leaves rooms it does not know alone', async () => {
    expect(await roomStillAllowed(ANA, 'presence:some-page', notAdmin)).toBe(true)
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

  it('a request with no people re-checks everyone', () => {
    const io = fakeIo([])
    vi.mocked(getIo).mockReturnValue(io as never)
    requestAccessRecheck({ userIds: ['ana'] })
    requestAccessRecheck()
    vi.advanceTimersByTime(1500)
    expect(io.serverSideEmit).toHaveBeenCalledWith(RECHECK_EVENT, { all: true, userIds: ['ANA'] })
  })
})
