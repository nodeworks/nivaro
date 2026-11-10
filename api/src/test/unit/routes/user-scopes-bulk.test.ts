import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// POST /api/user-scopes/bulk (Rob 2026-11-10): administrators add / remove
// people's RESTRICTED zones in one go.

const A = 'a0000000-0000-0000-0000-00000000000a'
const B = 'a0000000-0000-0000-0000-00000000000b'

vi.mock('../../../middleware/authenticate.js', () => {
  const who = (req: {
    headers: Record<string, string | undefined>
    user?: unknown
    isAdmin?: boolean
  }) => {
    const w = req.headers['x-test-user']
    if (!w) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id: 'f0000000-0000-0000-0000-00000000000f' }
    req.isAdmin = w === 'admin'
    return w
  }
  return {
    requireAuth: vi.fn(async (req: never) => {
      who(req)
    }),
    requireAdmin: vi.fn(async (req: never) => {
      if (who(req) !== 'admin') throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    })
  }
})

const h = vi.hoisted(() => {
  const ops: Array<[string, string, unknown]> = []
  const chain = (table: string) => {
    const c: Record<string, unknown> = {}
    const self = () => c
    for (const m of ['where', 'whereIn', 'select']) c[m] = vi.fn(self)
    c.first = vi.fn(async () => (table === 'nivaro_user_scopes' ? { id: 7 } : undefined))
    c.update = vi.fn(async (v: unknown) => {
      ops.push([table, 'update', v])
    })
    c.insert = vi.fn(async (v: unknown) => {
      ops.push([table, 'insert', v])
    })
    c.del = vi.fn(async () => {
      ops.push([table, 'del', null])
    })
    return c
  }
  const db = Object.assign(
    vi.fn((t: string) => chain(t)),
    { transaction: vi.fn(async (cb: (trx: unknown) => unknown) => cb((t: string) => chain(t))) }
  )
  return {
    ops,
    db,
    bust: vi.fn(),
    logActivity: vi.fn(async () => 1),
    run: vi.fn()
  }
})

vi.mock('../../../db/index.js', () => ({ db: h.db }))
vi.mock('../../../db/config-epoch.js', () => ({ runPersonalConfigWrite: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: h.logActivity }))
vi.mock('../../../services/user-scopes.js', () => ({
  bustScopeDimensionCache: vi.fn(),
  bustScopePathCache: vi.fn(),
  bustUserScopeCache: h.bust,
  describeHops: vi.fn(),
  describeUserScopes: vi.fn(),
  listScopeDimensions: vi.fn(async () => [
    {
      id: 1,
      name: 'division',
      label: 'Zone',
      target_collection: 'divisions',
      display_field: 'short_name'
    }
  ]),
  resolveScopeLabelsForUsers: vi.fn(),
  scopeHopsFor: vi.fn()
}))
vi.mock('../../../services/user-scopes-bulk.js', () => ({ runBulkScopeChange: h.run }))

import { userScopesRoutes } from '../../../routes/user-scopes.js'

async function call(who: string | null, body: unknown) {
  const app = Fastify()
  await app.register(userScopesRoutes)
  const res = await app.inject({
    method: 'POST',
    url: '/user-scopes/bulk',
    headers: who ? { 'x-test-user': who } : {},
    payload: body as Record<string, unknown>
  })
  await app.close()
  return res
}

const OK = { user_ids: [A, B], dimension: 'division', op: 'add', values: [3] }

afterEach(() => {
  h.run.mockReset()
  h.bust.mockClear()
  h.logActivity.mockClear()
  h.ops.length = 0
})

describe('POST /user-scopes/bulk', () => {
  it('administrators only', async () => {
    expect((await call('member', OK)).statusCode).toBe(403)
    expect(h.run).not.toHaveBeenCalled()
  })

  it('refuses a bad op, no people, no values, too many people, an unknown dimension', async () => {
    h.run.mockResolvedValue({ rows: [], counts: {}, unknown_values: [] })
    expect((await call('admin', { ...OK, op: 'set' })).statusCode).toBe(400)
    expect((await call('admin', { ...OK, user_ids: ['nope'] })).statusCode).toBe(400)
    expect((await call('admin', { ...OK, values: [] })).statusCode).toBe(400)
    const many = Array.from(
      { length: 501 },
      (_, i) => `a0000000-0000-0000-0000-${String(i).padStart(12, '0')}`
    )
    expect((await call('admin', { ...OK, user_ids: many })).statusCode).toBe(400)
    expect((await call('admin', { ...OK, dimension: 'nope' })).statusCode).toBe(404)
    expect(h.run).not.toHaveBeenCalled()
  })

  it('restrict mode only, preview passed through; an unknown value is a 400', async () => {
    h.run.mockResolvedValueOnce({ rows: [], counts: {}, unknown_values: [] })
    const res = await call('admin', { ...OK, preview: true })
    expect(res.statusCode).toBe(200)
    expect(h.run.mock.calls[0][0]).toMatchObject({
      userIds: [A, B],
      dimension: 'division',
      noun: 'zone',
      op: 'add',
      values: [3],
      preview: true,
      allowEmpty: false
    })
    h.run.mockResolvedValueOnce({ rows: [], counts: {}, unknown_values: [99] })
    const bad = await call('admin', { ...OK, values: [99] })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('UNKNOWN_VALUES')
  })

  it("a person's write touches only their restrict row, busts their scope cache and logs it", async () => {
    h.run.mockImplementationOnce(async (_input, deps) => {
      await deps.write(A, 'division', [1, 3], [1])
      await deps.write(B, 'division', [], [2])
      return { rows: [], counts: {}, unknown_values: [] }
    })
    expect((await call('admin', OK)).statusCode).toBe(200)
    expect(h.ops).toEqual([
      ['nivaro_user_scopes', 'update', expect.objectContaining({ values: '[1,3]' })],
      ['nivaro_user_scopes', 'del', null]
    ])
    expect(h.bust.mock.calls).toEqual([[A], [B]])
    expect(h.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ item: `${A}:division:restrict`, collection: 'nivaro_user_scopes' })
    )
  })
})
