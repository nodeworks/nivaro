import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A lock route answers only for a record the caller can read (404 otherwise —
// the 409 used to name who edits a record hidden from them), tells the client
// whether it may take over, and lets a leaving tab release by POST.
const state = vi.hoisted(() => ({
  readable: true,
  takeover: null as string | null,
  lock: null as null | Record<string, unknown>,
  deleted: [] as string[],
  readCalls: 0,
  readThrows: null as null | Error
}))

vi.mock('../../../db/index.js', () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['where', 'whereIn', 'whereRaw', 'select', 'orderBy', 'leftJoin']) b[m] = chain
    b.first = async () => {
      if (table === 'nivaro_collections') return { item_locking_enabled: 1 }
      if (table === 'nivaro_item_locks') return state.lock ?? undefined
      if (table === 'nivaro_settings') return { lock_takeover_roles: state.takeover }
      if (table === 'nivaro_users') return { first_name: 'Amanda', last_name: 'B', email: 'a@x' }
      return undefined
    }
    b.delete = async () => {
      state.deleted.push(table)
      return 1
    }
    b.del = b.delete
    // biome-ignore lint/suspicious/noThenProperty: knex builders are awaitable
    b.then = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res)
    return b
  }
  return { db: (t: string) => builder(t) }
})
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'U1', role: 'CREATOR' }
    req.isAdmin = false
  },
  requireAuth: async () => undefined,
  requireAdmin: async () => undefined
}))
vi.mock('../../../services/help-videos.js', () => ({
  isAuthor: vi.fn(async () => true),
  isUuid: (v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/record-events.js', () => ({ announceRecordAspect: vi.fn() }))
vi.mock('../../../services/items.js', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  CollectionNotFoundError: class CollectionNotFoundError extends Error {},
  canUpdateItem: vi.fn(async () => true),
  idFitsCollection: async (_c: string, id: unknown) => /^\d+$/.test(String(id)),
  readItems: vi.fn(
    async (_u: unknown, _c: string, _q: unknown, req: { query: { conditions: string } }) => {
      state.readCalls++
      if (state.readThrows) throw state.readThrows
      const id = JSON.parse(req.query.conditions)[0].value
      return { data: state.readable ? [{ id }] : [] }
    }
  )
}))

import { itemLocksRoutes } from '../../../routes/item-locks.js'

async function app() {
  const a = Fastify()
  await a.register(itemLocksRoutes, { prefix: '/api/item-locks' })
  return a
}
const held = () => ({
  id: 9,
  collection: 'workflows',
  item: '372773',
  user: 'OTHER',
  locked_at: new Date(),
  expires_at: new Date(Date.now() + 60_000),
  note: null
})

describe('item-locks read gate', () => {
  beforeEach(() => {
    state.readable = true
    state.takeover = null
    state.lock = held()
    state.deleted = []
    state.readCalls = 0
    state.readThrows = null
  })

  it('404s the lock of a record the caller cannot read, without naming the editor', async () => {
    state.readable = false
    const a = await app()
    const get = await a.inject({ method: 'GET', url: '/api/item-locks/workflows/372773/lock' })
    expect(get.statusCode).toBe(404)
    expect(get.body).not.toContain('Amanda')
    const post = await a.inject({
      method: 'POST',
      url: '/api/item-locks/workflows/372774/lock',
      payload: {}
    })
    expect(post.statusCode).toBe(404)
  })

  it('404s an id the key cannot hold without reading', async () => {
    const res = await (await app()).inject({
      method: 'GET',
      url: '/api/item-locks/workflows/abc/lock'
    })
    expect(res.statusCode).toBe(404)
    expect(state.readCalls).toBe(0)
  })

  it('says whether the caller may take over', async () => {
    const a = await app()
    let res = await a.inject({ method: 'GET', url: '/api/item-locks/workflows/372775/lock' })
    expect(res.json().data.may_take_over).toBe(false)
    expect(res.json().data.locked_by_name).toBe('Amanda B')
    state.takeover = JSON.stringify(['creator'])
    res = await a.inject({ method: 'GET', url: '/api/item-locks/workflows/372775/lock' })
    expect(res.json().data.may_take_over).toBe(true)
    const busy = await a.inject({
      method: 'POST',
      url: '/api/item-locks/workflows/372775/lock',
      payload: {}
    })
    expect(busy.statusCode).toBe(409)
    expect(busy.json().may_take_over).toBe(true)
  })

  it('releases the caller’s own lock by POST, and never someone else’s', async () => {
    const a = await app()
    const other = await a.inject({
      method: 'POST',
      url: '/api/item-locks/workflows/372776/lock/release'
    })
    expect(other.statusCode).toBe(403)
    state.lock = { ...held(), user: 'U1' }
    state.readable = false // letting go never needs read access
    const mine = await a.inject({
      method: 'POST',
      url: '/api/item-locks/workflows/372776/lock/release'
    })
    expect(mine.statusCode).toBe(204)
    expect(state.deleted).toContain('nivaro_item_locks')
  })

  it("answers a non-reader releasing someone else's lock with a quiet 204", async () => {
    state.readable = false
    const res = await (await app()).inject({
      method: 'DELETE',
      url: '/api/item-locks/workflows/372777/lock'
    })
    expect(res.statusCode).toBe(204)
    expect(state.deleted).not.toContain('nivaro_item_locks')
  })

  it('answers a failing read check as a server error, never a 404', async () => {
    state.readThrows = new Error('pool exhausted')
    const res = await (await app()).inject({
      method: 'GET',
      url: '/api/item-locks/workflows/372778/lock'
    })
    expect(res.statusCode).toBe(500)
  })

  it("keeps the 403 for an author releasing another author's help-video lock", async () => {
    state.readable = false // the items API never answers for help videos
    state.lock = { ...held(), collection: 'nivaro_help_videos' }
    const res = await (await app()).inject({
      method: 'DELETE',
      url: '/api/item-locks/nivaro_help_videos/6f1c2b3a-1234-4abc-9def-0123456789ab/lock'
    })
    expect(res.statusCode).toBe(403)
    expect(state.readCalls).toBe(0)
  })
})
