import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  locks: [] as Array<{ item: string; user: string }>,
  readable: [] as string[],
  readThrows: false,
  locking: true,
  readCalls: [] as unknown[]
}))

// A chainable stand-in for knex: every builder method returns itself, and
// awaiting it yields the rows the route asked for.
vi.mock('../../../db/index.js', () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['where', 'whereIn', 'whereRaw', 'select', 'orderBy', 'leftJoin']) b[m] = chain
    b.first = async () =>
      table === 'nivaro_collections'
        ? { item_locking_enabled: state.locking ? 1 : 0 }
        : { first_name: 'Beth', last_name: 'Lee', email: 'b@x.test' }
    // biome-ignore lint/suspicious/noThenProperty: knex builders are awaitable; the route awaits this one
    b.then = (res: (v: unknown) => unknown) =>
      Promise.resolve(table === 'nivaro_item_locks' ? state.locks : []).then(res)
    return b
  }
  return { db: Object.assign((t: string) => builder(t), {}) }
})
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown }) => {
    req.user = { id: 'U1', role: 'R1' }
  },
  requireAuth: async () => undefined,
  requireAdmin: async () => undefined
}))
vi.mock('../../../services/help-videos.js', () => ({
  isAuthor: vi.fn(async () => false),
  isUuid: () => false
}))
vi.mock('../../../services/items.js', () => ({
  readItems: vi.fn(async (_u: unknown, _c: string, q: unknown, req: unknown) => {
    state.readCalls.push({ q, req })
    if (state.readThrows) throw new Error('nope')
    return { data: state.readable.map((id) => ({ id })) }
  })
}))
vi.mock('../../../services/record-events.js', () => ({ announceRecordAspect: vi.fn() }))

import { itemLocksRoutes } from '../../../routes/item-locks.js'

async function ask(ids: unknown, collection = 'articles') {
  const a = Fastify()
  await a.register(itemLocksRoutes, { prefix: '/api/item-locks' })
  return a.inject({
    method: 'POST',
    url: `/api/item-locks/${collection}/active`,
    payload: { ids }
  })
}

beforeEach(() => {
  state.locks = []
  state.readable = []
  state.readThrows = false
  state.locking = true
  state.readCalls = []
})

describe('POST /item-locks/:collection/active (#1872)', () => {
  it('answers only for records the caller can read', async () => {
    state.locks = [
      { item: '1', user: 'U2' },
      { item: '2', user: 'U1' },
      { item: '3', user: 'U2' }
    ]
    state.readable = ['1', '2']
    const res = await ask(['1', '2', '3'])
    expect(res.statusCode).toBe(200)
    const data = res.json().data as Array<{
      item: string
      is_mine: boolean
      locked_by_name: string
    }>
    expect(data.map((d) => d.item)).toEqual(['1', '2'])
    expect(data[0].is_mine).toBe(false)
    expect(data[1].is_mine).toBe(true)
    expect(data[0].locked_by_name).toBe('Beth Lee')
  })

  it('reads through the items service as the caller, with an id filter', async () => {
    state.locks = [{ item: '1', user: 'U2' }]
    state.readable = ['1']
    await ask(['1'])
    const call = state.readCalls[0] as {
      q: { fields: string[] }
      req: { query: { conditions: string } }
    }
    expect(call.q.fields).toEqual(['id'])
    expect(JSON.parse(call.req.query.conditions)).toEqual([
      { path: ['id'], op: '_in', value: ['1'] }
    ])
  })

  it('answers nothing when the read fails, locking is off, or no ids are asked', async () => {
    state.locks = [{ item: '1', user: 'U2' }]
    state.readThrows = true
    expect((await ask(['1'])).json().data).toEqual([])
    state.readThrows = false
    state.locking = false
    expect((await ask(['1'])).json().data).toEqual([])
    state.locking = true
    expect((await ask([])).json().data).toEqual([])
    expect((await ask('nope')).json().data).toEqual([])
  })

  it('refuses system tables like every lock route', async () => {
    expect((await ask(['1'], 'nivaro_users')).statusCode).toBe(403)
  })
})
