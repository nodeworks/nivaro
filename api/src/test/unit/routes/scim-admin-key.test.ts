import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// SCIM sets the role, email and status of every account. It used to accept
// any nvk_ key whose scopes included the default `*`, whoever owned it — a
// key minted for a non-admin could make its owner an administrator through
// `groups`. Now: an explicit `scim` scope, a key owned by an administrator,
// and never a role that grants admin access from an IdP group.

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(
    async (req: {
      headers: Record<string, string | undefined>
      user?: unknown
      isAdmin?: boolean
      apiKeyScopes?: unknown
    }) => {
      const [, owner, scope] =
        /^Bearer nvk_(\w+)_(\w+)$/.exec(req.headers.authorization ?? '') ?? []
      if (!owner) throw new Error('bad key')
      req.user = { id: `${owner}-id` }
      req.isAdmin = owner === 'admin'
      req.apiKeyScopes = [{ collection: scope === 'star' ? '*' : scope, actions: ['*'] }]
    }
  )
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))

const USER = { id: 'U1', email: 'u1@example.com', status: 'active', role: 'r-basic' }
const sql = vi.hoisted(() => ({ ran: [] as FakeQuery[] }))
vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb((q) => {
      sql.ran.push(q)
      if (q.sql.includes('[nivaro_roles]'))
        return [
          { id: 'r-admin', name: 'Administrator', admin_access: true },
          { id: 'r-approver', name: 'Approver', admin_access: false }
        ].filter((r) => q.bindings.includes(r.name))
      if (q.method === 'update') return 1
      if (q.method === 'first') return { ...USER }
      if (q.sql.includes('count(')) return [{ count: 1 }]
      return [{ ...USER }]
    })
  }
})

import { scimRoutes } from '../../../routes/scim.js'

async function buildApp() {
  const app = Fastify()
  await app.register(scimRoutes, { prefix: '/scim/v2' })
  await app.ready()
  return app
}

beforeEach(() => {
  sql.ran.length = 0
})

describe('SCIM auth', () => {
  it('refuses a key that only carries the default * scope, even an admin one', async () => {
    const app = await buildApp()
    const res = await app.inject({
      url: '/scim/v2/Users',
      headers: { authorization: 'Bearer nvk_admin_star' }
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('refuses a scim-scoped key owned by a non-admin', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/scim/v2/Users/U1',
      headers: { authorization: 'Bearer nvk_person_scim' },
      payload: { groups: [{ display: 'Administrator' }] }
    })
    expect(res.statusCode).toBe(403)
    expect(sql.ran.some((q) => q.method === 'update')).toBe(false)
    await app.close()
  })

  it('lets an admin-owned scim key list users', async () => {
    const app = await buildApp()
    const res = await app.inject({
      url: '/scim/v2/Users',
      headers: { authorization: 'Bearer nvk_admin_scim' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().totalResults).toBe(1)
    await app.close()
  })
})

describe('SCIM groups → role', () => {
  it('never assigns a role that grants admin access; a plain role still maps', async () => {
    const app = await buildApp()
    const admin = await app.inject({
      method: 'PATCH',
      url: '/scim/v2/Users/U1',
      headers: { authorization: 'Bearer nvk_admin_scim' },
      payload: { groups: [{ display: 'Administrator' }] }
    })
    expect(admin.statusCode).toBe(200)
    expect(sql.ran.filter((q) => q.method === 'update').some((q) => q.sql.includes('[role]'))).toBe(
      false
    )

    sql.ran.length = 0
    const plain = await app.inject({
      method: 'PATCH',
      url: '/scim/v2/Users/U1',
      headers: { authorization: 'Bearer nvk_admin_scim' },
      payload: { groups: [{ display: 'Administrator' }, { display: 'Approver' }] }
    })
    expect(plain.statusCode).toBe(200)
    const update = sql.ran.find((q) => q.method === 'update')!
    expect(update.sql).toContain('[role]')
    expect(update.bindings).toContain('r-approver')
    expect(update.bindings).not.toContain('r-admin')
    await app.close()
  })
})
