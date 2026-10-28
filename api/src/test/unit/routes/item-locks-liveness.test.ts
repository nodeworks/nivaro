import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 2026-10-28 (staging): an approver's "Submit to Warehouse" got 409 RECORD_LOCKED
// naming someone who had left the record minutes before. A lock is held only
// while its holder is still here: a heartbeat inside the 30 s lease, and — when
// the realtime view can tell — a socket somewhere. A View-as that ends lets go
// of the locks it took.
const state = vi.hoisted(() => ({
  me: 'U-APPROVER',
  authMethod: 'session' as string,
  lock: null as null | Record<string, unknown>,
  deleted: [] as string[],
  inserted: [] as Array<Record<string, unknown>>,
  updated: [] as Array<Record<string, unknown>>,
  notified: [] as string[]
}))

vi.mock('../../../db/index.js', () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['where', 'whereIn', 'whereRaw', 'select', 'orderBy', 'leftJoin']) b[m] = chain
    b.first = async () => {
      if (table === 'nivaro_collections') return { item_locking_enabled: 1 }
      if (table === 'nivaro_item_locks') return state.lock ?? undefined
      if (table === 'nivaro_users') return { first_name: 'Etien', last_name: 'Gjoni', email: 'e@x' }
      return undefined
    }
    b.delete = async () => {
      state.deleted.push(table)
      if (table === 'nivaro_item_locks') {
        const had = state.lock ? 1 : 0
        state.lock = null
        return had
      }
      return 1
    }
    b.del = b.delete
    b.insert = async (row: Record<string, unknown>) => {
      state.inserted.push(row)
      if (table === 'nivaro_item_locks') state.lock = { id: 2, ...row }
      return [1]
    }
    b.update = async (row: Record<string, unknown>) => {
      state.updated.push(row)
      if (table === 'nivaro_item_locks' && state.lock) state.lock = { ...state.lock, ...row }
      return 1
    }
    // biome-ignore lint/suspicious/noThenProperty: knex builders are awaitable
    b.then = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res)
    return b
  }
  return { db: (t: string) => builder(t) }
})
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean; authMethod?: string }) => {
    req.user = { id: state.me, role: 'R' }
    req.isAdmin = false
    req.authMethod = state.authMethod
  },
  requireAuth: async () => undefined,
  requireAdmin: async () => undefined
}))
vi.mock('../../../services/help-videos.js', () => ({
  isAuthor: vi.fn(async () => true),
  isUuid: (v: unknown) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v))
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/record-events.js', () => ({ announceRecordAspect: vi.fn() }))
vi.mock('../../../services/notification-channels.js', () => ({
  notifyUser: vi.fn(async (_app: unknown, user: string) => {
    state.notified.push(user)
  })
}))
vi.mock('../../../services/edit-lock.js', () => ({
  EDIT_LOCKED: 'EDIT_LOCKED',
  lockHolderVerdict: async () => ({ locked: false, allowed: true, message: '' })
}))
vi.mock('../../../services/items.js', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  CollectionNotFoundError: class CollectionNotFoundError extends Error {},
  canUpdateItem: vi.fn(async () => true),
  idFitsCollection: async () => true,
  readItems: vi.fn(
    async (_u: unknown, _c: string, _q: unknown, req: { query: { conditions: string } }) => ({
      data: [{ id: JSON.parse(req.query.conditions)[0].value }]
    })
  )
}))

import {
  itemLocksRoutes,
  noteMasqueradeLock,
  releaseMasqueradeLocks
} from '../../../routes/item-locks.js'
import { LOCK_LIVE_MS, setLockPresenceProbe } from '../../../services/lock-presence.js'

async function app() {
  const a = Fastify()
  await a.register(itemLocksRoutes, { prefix: '/api/item-locks' })
  return a
}
/** Etien's lock: taken 3 min ago, last heartbeat `beatAgoMs` ago, 30 s lease. */
const etiensLock = (beatAgoMs: number) => ({
  id: 9,
  collection: 'inventory_request',
  item: '42',
  user: 'U-ETIEN',
  locked_at: new Date(Date.now() - 180_000),
  expires_at: new Date(Date.now() - beatAgoMs + LOCK_LIVE_MS),
  note: null
})
const acquire = async (body: Record<string, unknown> = { beat_ms: 10_000 }) =>
  (await app()).inject({
    method: 'POST',
    url: '/api/item-locks/inventory_request/42/lock',
    payload: body
  })

describe('a lock is held only while its holder is still here', () => {
  beforeEach(() => {
    state.me = 'U-APPROVER'
    state.authMethod = 'session'
    state.lock = null
    state.deleted = []
    state.inserted = []
    state.updated = []
    state.notified = []
    setLockPresenceProbe(null)
  })

  it('a lapsed heartbeat is free to take, silently', async () => {
    state.lock = etiensLock(35_000)
    const res = await acquire()
    expect(res.statusCode).toBe(200)
    expect(res.json().data.user).toBe('U-APPROVER')
    expect(state.notified).not.toContain('U-ETIEN')
  })

  it('a live heartbeat still refuses the next person (409, naming the holder)', async () => {
    state.lock = etiensLock(5_000)
    const res = await acquire()
    expect(res.statusCode).toBe(409)
    expect(res.json().locked_by_name).toBe('Etien Gjoni')
  })

  it('a client that beats every 10 s gets a 30 s lease; an older client the legacy one', async () => {
    let res = await acquire({ beat_ms: 10_000 })
    expect(res.statusCode).toBe(200)
    const lease = new Date(state.inserted[0].expires_at as Date).getTime() - Date.now()
    expect(lease).toBeGreaterThan(25_000)
    expect(lease).toBeLessThanOrEqual(30_000)
    state.lock = null
    res = await acquire({})
    const legacy = new Date(state.inserted[1].expires_at as Date).getTime() - Date.now()
    expect(legacy).toBeGreaterThan(140_000)
  })

  it('presence absent: the lock reads free and is free to take inside its lease', async () => {
    setLockPresenceProbe((id) => id !== 'U-ETIEN')
    state.lock = etiensLock(8_000)
    const read = await (await app()).inject({
      method: 'GET',
      url: '/api/item-locks/inventory_request/42/lock'
    })
    expect(read.statusCode).toBe(200)
    expect(read.json().data).toBeNull()
    state.lock = etiensLock(8_000)
    expect((await acquire()).statusCode).toBe(200)
  })

  it('presence unavailable: the heartbeat rule alone (live lease still refuses)', async () => {
    setLockPresenceProbe(() => null)
    state.lock = etiensLock(8_000)
    expect((await acquire()).statusCode).toBe(409)
  })

  it("the holder's own heartbeat is proof they are here, whatever presence says", async () => {
    setLockPresenceProbe(() => false)
    state.me = 'U-ETIEN'
    state.lock = etiensLock(8_000)
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/item-locks/inventory_request/42/heartbeat',
      payload: { idle_seconds: 0, beat_ms: 10_000 }
    })
    expect(res.statusCode).toBe(200)
    expect(state.lock).not.toBeNull()
  })
})

describe('View-as stop releases the locks that View-as took', () => {
  beforeEach(() => {
    state.lock = null
    state.deleted = []
  })

  it('remembers the token on acquire and lets go of its locks when the View-as ends', async () => {
    const sets = new Map<string, Set<string>>()
    const redis = {
      sadd: async (k: string, v: string) => {
        const s = sets.get(k) ?? new Set<string>()
        s.add(v)
        sets.set(k, s)
        return 1
      },
      expire: async () => 1,
      smembers: async (k: string) => [...(sets.get(k) ?? [])],
      del: async (k: string) => (sets.delete(k) ? 1 : 0)
    }
    const req = {
      authMethod: 'masquerade',
      headers: { authorization: 'Bearer nvm_abc' },
      server: { redis }
    } as never
    noteMasqueradeLock(req, 'inventory_request', '42')
    // A session-signed request is not a View-as: nothing remembered.
    noteMasqueradeLock(
      { authMethod: 'session', headers: {}, server: { redis } } as never,
      'workflows',
      '7'
    )
    await new Promise((r) => setTimeout(r, 0))
    expect([...sets.values()].map((s) => [...s])).toEqual([['inventory_request\u000042']])

    state.lock = etiensLock(2_000)
    const released = await releaseMasqueradeLocks({ redis } as never, 'nvm_abc', 'U-ETIEN')
    expect(released).toBe(1)
    expect(state.lock).toBeNull()
    expect(sets.size).toBe(0)
    // A second stop (or another token) releases nothing.
    expect(await releaseMasqueradeLocks({ redis } as never, 'nvm_other', 'U-ETIEN')).toBe(0)
  })
})
