import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Record merge rewrote every inbound reference with raw SQL for any
// update+delete holder (army 2026-10-25, critical) → admin-only. The approval
// chain list named every instance company-wide → only records the caller sees.

const who = vi.hoisted(() => ({ admin: false, hidden: new Set<string>() }))

vi.mock('../../../middleware/authenticate.js', () => {
  const set = async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'u-paul', role: 'role-approver' }
    req.isAdmin = who.admin
  }
  const admin = async (
    req: { user?: unknown; isAdmin?: boolean },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } }
  ) => {
    await set(req)
    if (!who.admin) return reply.code(403).send({ error: 'Forbidden' })
  }
  return { authenticate: vi.fn(set), requireAuth: vi.fn(set), requireAdmin: vi.fn(admin) }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser: vi.fn(async () => {}) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/items.js', () => ({
  deleteOne: vi.fn(async () => {}),
  updateOne: vi.fn(async () => ({}))
}))
vi.mock('../../../routes/message-actions.js', () => ({ sendApprovalCard: vi.fn(async () => {}) }))
vi.mock('../../../services/record-access.js', () => ({
  compileAccessGates: vi.fn(async () => ({})),
  visibleIds: vi.fn(
    async (_g: unknown, ids: string[]) => new Set(ids.filter((i) => !who.hidden.has(i)))
  )
}))
vi.mock('../../../db/index.js', () => {
  const db = vi.fn((t: string) => {
    const rows: Record<string, unknown[]> = {
      'nivaro_approval_instances as i': [
        { id: 1, chain: 7, collection: 'workflows', item: '10', status: 'pending' },
        { id: 2, chain: 7, collection: 'workflows', item: '20', status: 'pending' }
      ],
      workflows: [{ id: 10 }, { id: 20 }]
    }
    const r = rows[t] ?? []
    const c: Record<string, unknown> = {}
    for (const m of [
      'where',
      'whereIn',
      'join',
      'leftJoin',
      'select',
      'orderBy',
      'groupBy',
      'count'
    ])
      c[m] = vi.fn(() => c)
    c.first = vi.fn(async () => r[0])
    c.update = vi.fn(async () => 0)
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(r).then(res, rej)
    return c
  })
  ;(db as unknown as { raw: unknown }).raw = vi.fn(async () => [])
  return { db }
})

import { approvalsRoutes } from '../../../routes/approvals.js'
import { mergeRoutes } from '../../../routes/merge.js'

async function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const app = Fastify({ logger: false })
  await app.register(mergeRoutes, { prefix: '/merge' })
  await app.register(approvalsRoutes, { prefix: '/approvals' })
  return app.inject({ method, url, payload: payload as object })
}

beforeEach(() => {
  who.admin = false
  who.hidden.clear()
})

describe('/merge', () => {
  it('refuses a non-admin preview and merge', async () => {
    expect((await call('GET', '/merge/preview?collection=workflows&ids=10,20')).statusCode).toBe(
      403
    )
    const res = await call('POST', '/merge', {
      collection: 'workflows',
      survivor_id: '10',
      loser_ids: ['20']
    })
    expect(res.statusCode).toBe(403)
  })

  it('lets an admin merge', async () => {
    who.admin = true
    const res = await call('POST', '/merge', {
      collection: 'workflows',
      survivor_id: '10',
      loser_ids: ['20']
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('GET /approvals/instances', () => {
  it('lists only chains on records the non-admin can see', async () => {
    who.hidden.add('20')
    const res = await call('GET', '/approvals/instances?status=pending')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).data.map((i: { item: string }) => i.item)).toEqual(['10'])
  })

  it('lists everything for an admin', async () => {
    who.admin = true
    who.hidden.add('20')
    const res = await call('GET', '/approvals/instances')
    expect(JSON.parse(res.body).data).toHaveLength(2)
  })
})
