import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// GET /api/activity (2026-10-24): administrators only (every row names who did what, from
// where, on which record, outside any User Scope); the page comes from a narrow id sort then
// those rows; the unfiltered total from partition row counts, not a COUNT over 12M rows.

const who = vi.hoisted(() => ({ admin: true }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'U-1', role: 'R' }
    req.isAdmin = who.admin
  },
  requireAdmin: async (
    _req: unknown,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } }
  ) => {
    if (!who.admin) return reply.code(403).send({ error: 'Forbidden' })
  }
}))
const logActivity = vi.hoisted(() => vi.fn(async () => 1))
vi.mock('../../../services/activity.js', () => ({ logActivity }))
vi.mock('../../../db/dialect.js', () => ({ isMssql: () => true }))
const visible = vi.hoisted(() => ({ yes: true }))
vi.mock('../../../services/revision-access.js', () => ({
  recordVisibleTo: vi.fn(async () => visible.yes)
}))

const calls = vi.hoisted(() => ({ list: [] as Array<{ kind: string; detail: unknown }> }))
vi.mock('../../../db/index.js', () => {
  const make = () => {
    const st = {
      select: [] as unknown[],
      whereIn: null as unknown,
      count: false,
      order: null as unknown
    }
    const b: Record<string, unknown> = {}
    for (const m of ['leftJoin', 'limit', 'offset', 'where', 'distinct']) b[m] = () => b
    b.select = (...cols: unknown[]) => {
      st.select.push(...cols)
      return b
    }
    b.orderBy = (o: unknown) => {
      st.order = o
      return b
    }
    b.whereIn = (_c: string, ids: unknown) => {
      st.whereIn = ids
      return b
    }
    b.count = () => {
      st.count = true
      return b
    }
    b.offset = (n: unknown) => {
      calls.list.push({ kind: 'offset', detail: n })
      return b
    }
    b.first = async () => ({ id: 7, action: 'update' })
    const answer = async () => {
      if (st.count) {
        calls.list.push({ kind: 'count', detail: null })
        return [{ count: 5 }]
      }
      if (st.whereIn) {
        calls.list.push({ kind: 'rows', detail: st.whereIn })
        // Unordered on purpose: the route restores the id order.
        return [
          { id: 1, action: 'create', first_name: 'Ann' },
          { id: 3, action: 'update', first_name: 'Bob' },
          { id: 2, action: 'delete', first_name: null }
        ]
      }
      calls.list.push({ kind: 'ids', detail: { select: st.select, order: st.order } })
      return [{ id: 3 }, { id: 1 }, { id: 2 }]
    }
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is awaited as a thenable
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => answer().then(res, rej)
    return b
  }
  const db = Object.assign(() => make(), {
    raw: async (sql: string) => {
      calls.list.push({ kind: 'raw', detail: sql })
      return [{ n: 12726469 }]
    }
  })
  return { db }
})

import { activityRoutes } from '../../../routes/activity.js'

async function app() {
  const a = Fastify()
  await a.register(activityRoutes, { prefix: '/api/activity' })
  return a
}

beforeEach(() => {
  who.admin = true
  calls.list.length = 0
  logActivity.mockClear()
})

describe('GET /api/activity', () => {
  it('refuses anyone who is not an administrator — list, actions and one entry', async () => {
    who.admin = false
    const a = await app()
    for (const url of ['/api/activity?limit=10', '/api/activity/actions', '/api/activity/7'])
      expect((await a.inject({ method: 'GET', url })).statusCode).toBe(403)
    expect(calls.list).toEqual([])
  })

  it('keeps the writes open to anyone signed in (their own export / entry)', async () => {
    who.admin = false
    const a = await app()
    const r = await a.inject({
      method: 'POST',
      url: '/api/activity/export-log',
      payload: { collection: 'workflows', row_count: 3, format: 'csv' }
    })
    expect(r.statusCode).toBe(200)
    expect(logActivity).toHaveBeenCalledTimes(1)
  })

  it('pages by a narrow (timestamp, id) sort, then loads those rows in that order', async () => {
    const a = await app()
    const r = await a.inject({ method: 'GET', url: '/api/activity?limit=10&sort=-timestamp' })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.data.map((x: { id: number }) => x.id)).toEqual([3, 1, 2])
    expect(body.data[0].first_name).toBe('Bob')
    const ids = calls.list.find((c) => c.kind === 'ids')?.detail as {
      select: unknown[]
      order: unknown
    }
    expect(ids.select).toEqual(['a.id'])
    expect(ids.order).toEqual([
      { column: 'a.timestamp', order: 'desc' },
      { column: 'a.id', order: 'desc' }
    ])
    expect(calls.list.find((c) => c.kind === 'rows')?.detail).toEqual([3, 1, 2])
  })

  it('reads the first page for a negative or non-numeric offset / limit, never a 500', async () => {
    const a = await app()
    for (const q of ['offset=-1', 'offset=abc', 'limit=-5&offset=-2', 'offset=2.5']) {
      calls.list.length = 0
      const r = await a.inject({ method: 'GET', url: `/api/activity?${q}` })
      expect(r.statusCode, q).toBe(200)
      const offsets = calls.list.filter((c) => c.kind === 'offset').map((c) => c.detail)
      expect(
        offsets.every((o) => Number.isInteger(o) && (o as number) >= 0),
        q
      ).toBe(true)
    }
  })

  it('takes the unfiltered total from the partition row counts, a filtered one from COUNT', async () => {
    const a = await app()
    const whole = (await a.inject({ method: 'GET', url: '/api/activity?limit=10' })).json()
    expect(whole.total).toBe(12726469)
    expect(
      calls.list.some((c) => c.kind === 'raw' && String(c.detail).includes('dm_db_partition_stats'))
    ).toBe(true)
    expect(calls.list.some((c) => c.kind === 'count')).toBe(false)

    calls.list.length = 0
    const one = (
      await a.inject({ method: 'GET', url: '/api/activity?limit=10&collection=workflows' })
    ).json()
    expect(one.total).toBe(5)
    expect(calls.list.some((c) => c.kind === 'raw')).toBe(false)
  })
})

// M3 (security audit 2026-10-27): POST /activity is not a way to plant audit rows.
describe('POST /api/activity', () => {
  const post = async (payload: Record<string, unknown>) =>
    (await app()).inject({ method: 'POST', url: '/api/activity', payload })

  it('refuses a non-admin any action outside the client allow-list (empty today)', async () => {
    who.admin = false
    for (const action of ['delete', 'transition', 'login', 'update']) {
      const r = await post({ action, collection: 'workflows', item: '7', comment: 'x' })
      expect(r.statusCode).toBe(403)
    }
    expect(logActivity).not.toHaveBeenCalled()
  })

  it('wants a well-formed action', async () => {
    for (const action of ['', 'a b', 'x'.repeat(51), "'; DROP"]) {
      expect((await post({ action })).statusCode).toBe(400)
    }
    expect(logActivity).not.toHaveBeenCalled()
  })

  it('lets an administrator record an entry, comment capped', async () => {
    const r = await post({ action: 'note', collection: 'workflows', comment: 'y'.repeat(5000) })
    expect(r.statusCode).toBe(201)
    const opts = (logActivity.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(opts.action).toBe('note')
    expect(opts.user).toBe('U-1')
    expect(String(opts.comment)).toHaveLength(2000)
  })
})
