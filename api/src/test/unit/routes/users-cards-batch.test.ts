import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /users/cards — the batched contact-card read lists use instead of one
// GET /users/:id/card per person. It must answer exactly what the single
// route answers, for a non-admin too.

const A = 'AAAAAAAA-0000-4000-8000-000000000001'
const B = 'BBBBBBBB-0000-4000-8000-000000000002'
const R = 'CCCCCCCC-0000-4000-8000-000000000003'

const who = vi.hoisted(() => ({ id: '', admin: false, authed: true }))
const store = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  whereIns: [] as string[][],
  avatars: new Map<string, { avatar: string | null; is_redacted: boolean }>()
}))

vi.mock('../../../middleware/authenticate.js', () => {
  const authenticate = async (
    req: { user?: unknown; isAdmin?: boolean },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } }
  ) => {
    if (!who.authed) return reply.code(401).send({ error: 'Unauthorized' })
    req.user = { id: who.id, role: 'R' }
    req.isAdmin = who.admin
  }
  return {
    authenticate,
    requireAdmin: async (req: { user?: unknown; isAdmin?: boolean }, reply: never) => {
      await authenticate(req, reply)
      if (!req.isAdmin) throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    }
  }
})

vi.mock('../../../db/index.js', () => {
  const db = (_table: string) => {
    let ids: string[] = []
    let whereId = ''
    const b: Record<string, unknown> = {
      leftJoin: () => b,
      whereIn: (_col: string, list: string[]) => {
        ids = list.map((i) => i.toUpperCase())
        store.whereIns.push(list)
        return b
      },
      where: (w: { id: string }) => {
        whereId = w.id.toUpperCase()
        return b
      },
      select: async () =>
        store.rows.filter((r) => ids.includes(String(r.id).toUpperCase())).map((r) => ({ ...r })),
      first: async () => store.avatars.get(whereId)
    }
    return b
  }
  db.raw = (sql: string) => sql
  return { db }
})

import { usersRoutes } from '../../../routes/users.js'

async function app() {
  const a = Fastify()
  await a.register(usersRoutes, { prefix: '/api/users' })
  return a
}

const card = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  first_name: `F${id.slice(0, 2)}`,
  last_name: 'L',
  email: `${id.slice(0, 2)}@x.test`,
  title: null,
  phone: null,
  department: null,
  company: null,
  avatar: 'data:image/jpeg;base64,AAA',
  status: 'active',
  last_access: null,
  is_out_of_office: false,
  role_name: 'Staff',
  manager_name: ' ',
  manager_id: null,
  is_redacted: false,
  ...extra
})

beforeEach(() => {
  who.id = A
  who.admin = false
  who.authed = true
  store.whereIns.length = 0
  store.rows = [card(A), card(B), card(R, { is_redacted: true, first_name: 'Redacted' })]
  store.avatars.clear()
})

describe('POST /users/cards', () => {
  it('answers each card exactly as GET /users/:id/card does, for a non-admin', async () => {
    const a = await app()
    const batch = await a.inject({
      method: 'POST',
      url: '/api/users/cards',
      payload: { ids: [A, B, R] }
    })
    expect(batch.statusCode).toBe(200)
    const cards = (batch.json() as { data: Array<Record<string, unknown>> }).data
    expect(cards).toHaveLength(3)
    for (const id of [A, B, R]) {
      const single = await a.inject({ method: 'GET', url: `/api/users/${id}/card` })
      expect(single.statusCode).toBe(200)
      expect(cards.find((c) => c.id === id)).toEqual((single.json() as { data: unknown }).data)
    }
  })

  it('never carries is_redacted or a redacted person’s photo', async () => {
    const a = await app()
    const r = await a.inject({ method: 'POST', url: '/api/users/cards', payload: { ids: [R, A] } })
    const cards = (r.json() as { data: Array<Record<string, unknown>> }).data
    const red = cards.find((c) => c.id === R)!
    expect(red.avatar).toBeNull()
    expect('is_redacted' in red).toBe(false)
    expect(cards.find((c) => c.id === A)!.avatar).toBe('data:image/jpeg;base64,AAA')
  })

  it('leaves unknown and malformed ids out, and dedupes repeats', async () => {
    const a = await app()
    const unknown = 'DDDDDDDD-0000-4000-8000-000000000009'
    const r = await a.inject({
      method: 'POST',
      url: '/api/users/cards',
      payload: { ids: [A, unknown, "1' OR 1=1 --", A.toLowerCase(), 'me'] }
    })
    expect(r.statusCode).toBe(200)
    expect((r.json() as { data: Array<{ id: string }> }).data.map((c) => c.id)).toEqual([A])
    // Only well-formed, de-duplicated ids ever reach the query.
    expect(store.whereIns.at(-1)).toEqual([A, unknown])
  })

  it('caps the batch at 100 ids and rejects a bad body', async () => {
    const a = await app()
    const ids = Array.from(
      { length: 101 },
      (_, i) => `AAAAAAAA-0000-4000-8000-${String(i).padStart(12, '0')}`
    )
    const big = await a.inject({ method: 'POST', url: '/api/users/cards', payload: { ids } })
    expect(big.statusCode).toBe(400)
    expect((big.json() as { code: string }).code).toBe('TOO_MANY_IDS')
    const ok = await a.inject({
      method: 'POST',
      url: '/api/users/cards',
      payload: { ids: ids.slice(0, 100) }
    })
    expect(ok.statusCode).toBe(200)
    for (const payload of [{}, { ids: 'x' }, { ids: [1, 2] }]) {
      const bad = await a.inject({ method: 'POST', url: '/api/users/cards', payload })
      expect(bad.statusCode).toBe(400)
    }
    const empty = await a.inject({ method: 'POST', url: '/api/users/cards', payload: { ids: [] } })
    expect(empty.json()).toEqual({ data: [] })
  })

  it('requires a signed-in caller, like the single route', async () => {
    who.authed = false
    const a = await app()
    const r = await a.inject({ method: 'POST', url: '/api/users/cards', payload: { ids: [A] } })
    expect(r.statusCode).toBe(401)
    const s = await a.inject({ method: 'GET', url: `/api/users/${A}/card` })
    expect(s.statusCode).toBe(401)
  })

  it('the single route still 404s an unknown person', async () => {
    const a = await app()
    const r = await a.inject({
      method: 'GET',
      url: '/api/users/DDDDDDDD-0000-4000-8000-000000000009/card'
    })
    expect(r.statusCode).toBe(404)
  })
})

describe('GET /users/:id/avatar caching', () => {
  it('sends an ETag and answers a matching If-None-Match with a body-less 304', async () => {
    store.avatars.set(A, { avatar: 'data:image/jpeg;base64,AAA', is_redacted: false })
    const a = await app()
    const first = await a.inject({ method: 'GET', url: `/api/users/${A}/avatar` })
    expect(first.statusCode).toBe(200)
    expect(first.headers['cache-control']).toBe('private, max-age=1800')
    const etag = String(first.headers.etag)
    expect(etag).toMatch(/^W\/"a/)
    const again = await a.inject({
      method: 'GET',
      url: `/api/users/${A}/avatar`,
      headers: { 'if-none-match': etag }
    })
    expect(again.statusCode).toBe(304)
    expect(again.body).toBe('')
    // A changed photo changes the tag.
    store.avatars.set(A, { avatar: 'data:image/jpeg;base64,BBB', is_redacted: false })
    const changed = await a.inject({
      method: 'GET',
      url: `/api/users/${A}/avatar`,
      headers: { 'if-none-match': etag }
    })
    expect(changed.statusCode).toBe(200)
    expect(changed.headers.etag).not.toBe(etag)
  })

  it('caches "no photo" too and never serves a redacted photo', async () => {
    store.avatars.set(R, { avatar: 'data:image/jpeg;base64,SECRET', is_redacted: true })
    const a = await app()
    const r = await a.inject({ method: 'GET', url: `/api/users/${R}/avatar` })
    expect(r.json()).toEqual({ data: { avatar: null } })
    expect(r.headers['cache-control']).toBe('private, max-age=1800')
  })
})
