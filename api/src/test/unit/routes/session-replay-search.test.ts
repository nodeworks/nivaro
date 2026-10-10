import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GET /session-recordings/search (#1374, #1372): validation, the query it
 * builds against nivaro_replay_index, and recordings grouped one per hit.
 */

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  calls: [] as Array<[string, unknown[]]>,
  admin: true
}))

vi.mock('../../../db/index.js', () => {
  function chain(prefix = ''): Record<string, unknown> {
    const c: Record<string, unknown> = {}
    const rec =
      (name: string) =>
      (...args: unknown[]) => {
        h.calls.push([prefix + name, args])
        return c
      }
    for (const m of [
      'join',
      'leftJoin',
      'where',
      'from',
      'orderBy',
      'orderByRaw',
      'groupBy',
      'limit',
      'count'
    ]) {
      c[m] = rec(m)
    }
    c.modify = (fn: (qb: unknown) => void) => {
      fn(c)
      return c
    }
    c.whereExists = (fn: (this: unknown) => void) => {
      h.calls.push([`${prefix}whereExists`, []])
      fn.call(chain('exists.'))
      return c
    }
    c.select = (...args: unknown[]) => {
      h.calls.push([`${prefix}select`, args])
      if (prefix) return c
      // count() comes after select() in the keys query: stay chainable and awaitable.
      const p = Promise.resolve(h.rows) as Promise<unknown> & Record<string, unknown>
      p.count = () => Promise.resolve(h.rows)
      return p
    }
    return c
  }
  const db = vi.fn((table: string) => {
    h.calls.push(['table', [table]])
    return chain()
  })
  ;(db as unknown as Record<string, unknown>).raw = vi.fn((sql: string) => ({ sql }))
  ;(db as unknown as Record<string, unknown>).ref = vi.fn((col: string) => ({ ref: col }))
  return { db }
})
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async () => undefined,
  requireAuth: async () => undefined,
  requireAdmin: async (
    _req: unknown,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } }
  ) => {
    if (!h.admin) return reply.code(403).send({ error: 'Forbidden' })
  }
}))

import { sessionReplaySearchRoutes } from '../../../routes/session-replay-search.js'

async function get(url: string) {
  const app = Fastify()
  await app.register(sessionReplaySearchRoutes, { prefix: '/api/session-recordings' })
  return app.inject({ method: 'GET', url: `/api/session-recordings${url}` })
}

const row = (recording: string, kind: string, key: string, first: number, last: number) => ({
  recording,
  kind,
  key,
  first_ms: String(first), // SQL Server hands BIGINT back as a string
  last_ms: String(last),
  user: 'U1',
  user_name: 'Jane Doe',
  app: null,
  origin: 'https://admin.example.com',
  started_at: '2026-10-10T09:00:00.000Z',
  ended_at: null,
  last_event_at: '2026-10-10T09:10:00.000Z',
  event_count: 120,
  byte_size: 4096,
  truncated: 0
})

beforeEach(() => {
  h.rows = []
  h.calls = []
  h.admin = true
})

describe('GET /session-recordings/search', () => {
  it('needs something to search for', async () => {
    expect((await get('/search')).statusCode).toBe(400)
    expect((await get('/search?item=1042')).statusCode).toBe(400)
  })

  it('is admin-only', async () => {
    h.admin = false
    expect((await get('/search?collection=orders&item=1042')).statusCode).toBe(403)
  })

  it('finds the recordings that opened a record, one hit per recording', async () => {
    h.rows = [
      row('R2', 'record', 'orders/1042', 2000, 9000),
      row('R1', 'record', 'orders/1042', 100, 500)
    ]
    const res = await get('/search?collection=orders&item=1042')
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.map((d: { id: string }) => d.id)).toEqual(['R2', 'R1'])
    expect(data[0]).toMatchObject({
      user_name: 'Jane Doe',
      first_ms: 2000,
      last_ms: 9000,
      truncated: false,
      matches: [{ kind: 'record', key: 'orders/1042', first_ms: 2000, last_ms: 9000 }]
    })
    expect(h.calls).toContainEqual(['where', ['i.kind', 'record']])
    expect(h.calls).toContainEqual(['where', ['i.key', 'orders/1042']])
  })

  it('a collection alone matches any of its records, LIKE over-matches dropped', async () => {
    h.rows = [
      row('R1', 'record', 'order_items/5', 0, 1),
      row('R1', 'record', 'order_items/6', 5, 9),
      row('R3', 'record', 'orderXitems/1', 0, 1)
    ]
    const data = (await get('/search?collection=order_items')).json().data
    expect(data).toHaveLength(1)
    expect(data[0]).toMatchObject({ id: 'R1', first_ms: 0, last_ms: 9 })
    expect(data[0].matches).toHaveLength(2)
    expect(h.calls).toContainEqual(['where', ['i.key', 'like', 'order_items/%']])
  })

  it('ANDs extra criteria with EXISTS on the same recording', async () => {
    h.rows = [row('R1', 'field', 'orders.due_date', 0, 1)]
    await get(
      `/search?collection=orders&field=due_date&selector=${encodeURIComponent('#sidebar a')}`
    )
    expect(h.calls).toContainEqual(['where', ['i.kind', 'field']])
    expect(h.calls).toContainEqual(['where', ['i.key', 'orders.due_date']])
    expect(h.calls).toContainEqual(['exists.where', ['i2.recording', { ref: 'i.recording' }]])
    expect(h.calls).toContainEqual(['exists.where', ['i2.kind', 'selector']])
    expect(h.calls).toContainEqual(['exists.where', ['i2.key', '#sidebar a']])
  })
})

describe('GET /session-recordings/search/keys', () => {
  it('rejects an unknown kind', async () => {
    expect((await get('/search/keys?kind=values')).statusCode).toBe(400)
  })

  it('lists known keys by prefix', async () => {
    h.rows = [
      { key: 'due_date', recordings: '4' },
      { key: 'dueXdate', recordings: '1' }
    ]
    const res = await get('/search/keys?kind=field&q=due_')
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual([{ key: 'due_date', recordings: 4 }])
  })
})
