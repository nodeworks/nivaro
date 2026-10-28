import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import { authenticate, resetAdminRecheckCache } from '../../../middleware/authenticate.js'

// A View-as (nvm_) token is only as good as the administrator who started it: a
// suspended or demoted admin's View-as ends on the next request, not when the 4 h
// token runs out, and the token is dropped from Redis.

const TARGET = { id: 'target-1', role: 'role-user', status: 'active', email: 't@x.test' }
const USER_ROLE = { id: 'role-user', admin_access: false, app_access: true }
const ADMIN_ROLE = { id: 'role-admin', admin_access: true, app_access: true }

type Row = Record<string, unknown>
function wireDb(users: Row[], roles: Row[]) {
  vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((table: string) => {
    const conds: Row = {}
    const chain: Record<string, unknown> = {}
    for (const m of ['whereNull', 'orWhere', 'select', 'orderBy']) chain[m] = () => chain
    chain.where = (arg: unknown) => {
      if (arg && typeof arg === 'object') Object.assign(conds, arg)
      return chain
    }
    chain.first = vi.fn().mockImplementation(async () => {
      const rows = table === 'nivaro_users' ? users : table === 'nivaro_roles' ? roles : []
      return rows.find((r) => Object.entries(conds).every(([k, v]) => r[k] === v)) ?? null
    })
    chain.update = vi.fn().mockReturnValue({ catch: () => undefined })
    return chain
  })
}

function buildApp(del: ReturnType<typeof vi.fn>) {
  const app = Fastify({ logger: false })
  // @ts-expect-error — test shim
  app.decorateRequest('session', null)
  // @ts-expect-error — test shim
  app.decorate('redis', {
    get: async (k: string) =>
      k === 'masq:nvm_x' ? JSON.stringify({ user_id: TARGET.id, admin_id: 'admin-1' }) : null,
    set: async () => 'OK',
    expire: async () => 1,
    del
  })
  app.addHook('onRequest', async (req) => {
    ;(req as unknown as { session: unknown }).session = { destroy: async () => {} }
  })
  app.get('/me', { preHandler: authenticate }, async (req) => ({
    id: req.user?.id,
    admin: req.masqueradeAdminId
  }))
  return app
}

async function call(admin: Row) {
  wireDb([TARGET, admin], [USER_ROLE, ADMIN_ROLE])
  const del = vi.fn().mockResolvedValue(1)
  const app = buildApp(del)
  await app.ready()
  const res = await app.inject({
    method: 'GET',
    url: '/me',
    headers: { authorization: 'Bearer nvm_x' }
  })
  return { res, del }
}

afterEach(() => {
  vi.clearAllMocks()
  resetAdminRecheckCache()
})

describe('View-as token re-checks the administrator', () => {
  it('works while the admin is active and still an admin', async () => {
    const { res, del } = await call({ id: 'admin-1', role: 'role-admin', status: 'active' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ id: TARGET.id, admin: 'admin-1' })
    expect(del).not.toHaveBeenCalled()
  })

  it('ends when the admin was demoted', async () => {
    const { res, del } = await call({ id: 'admin-1', role: 'role-user', status: 'active' })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).code).toBe('MASQUERADE_ADMIN_INACTIVE')
    expect(del).toHaveBeenCalledWith('masq:nvm_x')
  })

  it('ends when the admin was suspended', async () => {
    const { res, del } = await call({ id: 'admin-1', role: 'role-admin', status: 'suspended' })
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).code).toBe('MASQUERADE_ADMIN_INACTIVE')
    expect(del).toHaveBeenCalledWith('masq:nvm_x')
  })
})
