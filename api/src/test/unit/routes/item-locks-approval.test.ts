import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// army v3: a transition into approval left an approver holding the edit lock
// of a record they may no longer change, and the creator was locked out. A
// lock its holder may no longer use is void; nobody the approval edit lock
// refuses gets one.
const state = vi.hoisted(() => ({
  me: 'U-PETER',
  lock: null as null | Record<string, unknown>,
  refused: new Set<string>(),
  deleted: [] as string[],
  inserted: [] as Array<Record<string, unknown>>,
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
      if (table === 'nivaro_users') return { first_name: 'Bryan', last_name: 'M', email: 'b@x' }
      return undefined
    }
    b.delete = async () => {
      state.deleted.push(table)
      if (table === 'nivaro_item_locks') state.lock = null
      return 1
    }
    b.del = b.delete
    b.insert = async (row: Record<string, unknown>) => {
      state.inserted.push(row)
      if (table === 'nivaro_item_locks') state.lock = { id: 2, ...row }
      return [1]
    }
    b.update = async () => 1
    // biome-ignore lint/suspicious/noThenProperty: knex builders are awaitable
    b.then = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res)
    return b
  }
  return { db: (t: string) => builder(t) }
})
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: state.me, role: 'R' }
    req.isAdmin = false
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
  lockHolderVerdict: async (holder: string | { id: string }) => {
    const id = typeof holder === 'string' ? holder : holder.id
    return state.refused.has(id)
      ? {
          locked: true,
          allowed: false,
          message: 'This record is at Level 1 — only the creator and step owners can change it.'
        }
      : { locked: false, allowed: true, message: '' }
  }
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

import { itemLocksRoutes } from '../../../routes/item-locks.js'
import { canUpdateItem } from '../../../services/items.js'

async function app() {
  const a = Fastify()
  await a.register(itemLocksRoutes, { prefix: '/api/item-locks' })
  return a
}
const lockOf = (user: string) => ({
  id: 9,
  collection: 'workflows',
  item: '372793',
  user,
  locked_at: new Date(),
  expires_at: new Date(Date.now() + 60_000),
  note: null
})

describe('edit locks follow the approval edit lock', () => {
  beforeEach(() => {
    state.me = 'U-PETER'
    state.lock = null
    state.refused = new Set()
    state.deleted = []
    state.inserted = []
    state.notified = []
  })

  it('voids the lock of a holder the approval lock now refuses: the creator gets it', async () => {
    state.lock = lockOf('U-BRYAN')
    state.refused.add('U-BRYAN')
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/item-locks/workflows/372793/lock',
      payload: {}
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.user).toBe('U-PETER')
    expect(state.notified).toContain('U-BRYAN')
  })

  it('keeps a lock its holder may still use (409 for the next person)', async () => {
    state.lock = lockOf('U-BRYAN')
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/item-locks/workflows/372793/lock',
      payload: {}
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().locked_by).toBe('U-BRYAN')
  })

  it('gives no lock to someone the approval lock refuses', async () => {
    state.me = 'U-BRYAN'
    state.refused.add('U-BRYAN')
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/item-locks/workflows/372793/lock',
      payload: {}
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('EDIT_LOCKED')
    expect(state.inserted).toHaveLength(0)
  })

  it('tells a holder whose lock was voided why on the heartbeat (403, not a re-acquire)', async () => {
    state.me = 'U-BRYAN'
    state.lock = lockOf('U-BRYAN')
    state.refused.add('U-BRYAN')
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/item-locks/workflows/372793/heartbeat',
      payload: {}
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('EDIT_LOCKED')
    expect(state.deleted).toContain('nivaro_item_locks')
  })

  it('a holder who may still edit keeps beating', async () => {
    state.me = 'U-BRYAN'
    state.lock = lockOf('U-BRYAN')
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/item-locks/workflows/372793/heartbeat',
      payload: {}
    })
    expect(res.statusCode).toBe(200)
  })
})

// M2 (security audit 2026-10-27): an edit lock is for someone who could save.
describe('edit locks need update rights on the record', () => {
  const OTHER = '3f1c2b3a-1234-4abc-9def-0123456789ab'
  beforeEach(() => {
    state.lock = null
    state.refused = new Set()
    state.deleted = []
    state.inserted = []
    state.notified = []
    vi.mocked(canUpdateItem).mockReset()
  })

  it('gives a read-only viewer no lock, no queue place and no request ping', async () => {
    state.me = 'U-READONLY-1'
    vi.mocked(canUpdateItem).mockResolvedValue(false)
    const a = await app()
    const lock = await a.inject({
      method: 'POST',
      url: '/api/item-locks/workflows/500/lock',
      payload: {}
    })
    expect(lock.statusCode).toBe(403)
    expect(lock.json().code).toBe('NOT_EDITABLE')
    expect(state.inserted).toEqual([])
    state.lock = { ...lockOf('U-BRYAN'), item: '500' }
    for (const path of ['lock/queue', 'lock/request', 'lock/force']) {
      const r = await a.inject({
        method: 'POST',
        url: `/api/item-locks/workflows/500/${path}`,
        payload: {}
      })
      expect(r.statusCode).toBe(403)
    }
    expect(state.notified).toEqual([])
    expect(state.lock?.user).toBe('U-BRYAN')
  })

  it('drops the lock of a holder who may no longer change the record', async () => {
    state.me = 'U-READONLY-2'
    vi.mocked(canUpdateItem).mockResolvedValue(false)
    state.lock = { ...lockOf('U-READONLY-2'), item: '501' }
    const r = await (await app()).inject({
      method: 'POST',
      url: '/api/item-locks/workflows/501/heartbeat',
      payload: {}
    })
    expect(r.statusCode).toBe(403)
    expect(r.json().code).toBe('EDIT_LOCKED')
    expect(state.lock).toBeNull()
  })

  it('lets only the holder answer a lock request', async () => {
    state.me = 'U-STRANGER'
    vi.mocked(canUpdateItem).mockResolvedValue(true)
    state.lock = { ...lockOf('U-BRYAN'), item: '502' }
    const r = await (await app()).inject({
      method: 'POST',
      url: '/api/item-locks/workflows/502/lock/respond',
      payload: { to: OTHER, action: 'decline', note: 'spoof' }
    })
    expect(r.statusCode).toBe(403)
    expect(state.notified).toEqual([])
  })

  it('lets the holder hand the lock to the requester', async () => {
    state.me = 'U-BRYAN'
    vi.mocked(canUpdateItem).mockResolvedValue(true)
    state.lock = { ...lockOf('U-BRYAN'), item: '503' }
    const r = await (await app()).inject({
      method: 'POST',
      url: '/api/item-locks/workflows/503/lock/respond',
      payload: { to: OTHER, action: 'release' }
    })
    expect(r.statusCode).toBe(200)
    expect(state.lock).toBeNull()
    expect(state.notified).toContain(OTHER)
  })
})
