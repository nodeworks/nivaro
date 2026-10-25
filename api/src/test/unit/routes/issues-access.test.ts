import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// The issue log answered every signed-in person with every issue — server
// errors with SQL text and request context, reporter emails — and
// POST /bulk-status changed any issue's status. Non-admins now see the issues
// they raised or are assigned (plus manual issues on a record they can open),
// server-issue `details` are cleared for them, and bulk status applies the
// single PATCH's rule (assignee, raiser or admin).

vi.mock('../../../middleware/authenticate.js', () => {
  const requireAuth = vi.fn(
    async (req: {
      headers: Record<string, string | undefined>
      user?: unknown
      isAdmin?: boolean
    }) => {
      const who = req.headers['x-test-user'] ?? 'nobody'
      req.user = { id: who.toUpperCase() }
      req.isAdmin = who === 'admin'
    }
  )
  return { requireAuth, requireAdmin: requireAuth, authenticate: requireAuth }
})
vi.mock('../../../plugins/socketio.js', () => ({ emitNotification: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/client-version.js', () => ({
  CLIENT_HEADER: 'x-nivaro-client',
  parseClientHeader: vi.fn(() => null)
}))
vi.mock('../../../services/error-tracking.js', () => ({ trackError: vi.fn(async () => 1) }))
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser: vi.fn(async () => {}) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
const visible = vi.hoisted(() => ({ ids: new Set<string>() }))
vi.mock('../../../services/items.js', () => ({
  readOne: vi.fn(async (_u: unknown, _c: string, id: string) =>
    visible.ids.has(String(id)) ? { id } : null
  )
}))

const ISSUES: Record<number, Record<string, unknown>> = {
  1: {
    id: 1,
    source: 'server',
    raised_by: 'PAUL',
    assigned_to: null,
    details: 'select top (@p0) …'
  },
  2: { id: 2, source: 'server', raised_by: 'NICK', assigned_to: null, details: 'stack' },
  3: {
    id: 3,
    source: 'manual',
    raised_by: 'NICK',
    collection: 'workflows',
    item: '42',
    details: 'n'
  }
}
const sql = vi.hoisted(() => ({ ran: [] as FakeQuery[] }))
vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb((q) => {
      sql.ran.push(q)
      if (q.method === 'update') return 1
      if (q.method === 'first') return ISSUES[Number(q.bindings.at(-1))]
      return Object.values(ISSUES).map((r) => ({ ...r }))
    })
  }
})

import { issuesRoutes } from '../../../routes/issues.js'

async function buildApp() {
  const app = Fastify()
  await app.register(issuesRoutes, { prefix: '/issues' })
  await app.ready()
  return app
}

beforeEach(() => {
  sql.ran.length = 0
  visible.ids.clear()
})

const own = /\(\[i\]\.\[raised_by\] = @p\d+ or \[i\]\.\[assigned_to\] = @p\d+\)/

describe('GET /issues', () => {
  it('limits a non-admin to their own issues and clears server details', async () => {
    const app = await buildApp()
    const res = await app.inject({ url: '/issues', headers: { 'x-test-user': 'paul' } })
    expect(res.statusCode).toBe(200)
    const list = sql.ran.find((q) => q.sql.includes('from [nivaro_issues]'))!
    expect(list.sql).toMatch(own)
    expect(list.bindings).toContain('PAUL')
    for (const r of res.json().data) if (r.source === 'server') expect(r.details).toBeNull()
    await app.close()
  })

  it('adds manual issues on a record the caller can open', async () => {
    const app = await buildApp()
    visible.ids.add('42')
    await app.inject({
      url: '/issues?collection=workflows&item=42',
      headers: { 'x-test-user': 'paul' }
    })
    const list = sql.ran.find((q) => q.sql.includes('from [nivaro_issues]'))!
    expect(list.sql).toContain('or [i].[source] = @p')
    await app.close()
  })

  it('gives an admin everything with details', async () => {
    const app = await buildApp()
    const res = await app.inject({ url: '/issues', headers: { 'x-test-user': 'admin' } })
    const list = sql.ran.find((q) => q.sql.includes('from [nivaro_issues]'))!
    expect(list.sql).not.toMatch(own)
    expect(res.json().data.find((r: { id: number }) => r.id === 1).details).toContain('select')
    await app.close()
  })
})

describe('GET /issues/:id', () => {
  it("hides someone else's issue, shows your own without server details", async () => {
    const app = await buildApp()
    expect(
      (await app.inject({ url: '/issues/2', headers: { 'x-test-user': 'paul' } })).statusCode
    ).toBe(404)
    const mine = await app.inject({ url: '/issues/1', headers: { 'x-test-user': 'paul' } })
    expect(mine.statusCode).toBe(200)
    expect(mine.json().data.details).toBeNull()
    await app.close()
  })

  it('shows a manual issue on a record the caller can open', async () => {
    const app = await buildApp()
    expect(
      (await app.inject({ url: '/issues/3', headers: { 'x-test-user': 'paul' } })).statusCode
    ).toBe(404)
    visible.ids.add('42')
    expect(
      (await app.inject({ url: '/issues/3', headers: { 'x-test-user': 'paul' } })).statusCode
    ).toBe(200)
    await app.close()
  })

  it('answers 1e99 with a 404, not a driver error', async () => {
    const app = await buildApp()
    const res = await app.inject({ url: '/issues/1e99', headers: { 'x-test-user': 'admin' } })
    expect(res.statusCode).toBe(404)
    expect(sql.ran).toHaveLength(0)
    await app.close()
  })
})

describe('POST /issues/bulk-status', () => {
  it('applies the assignee/raiser rule for a non-admin, not for an admin', async () => {
    const app = await buildApp()
    await app.inject({
      method: 'POST',
      url: '/issues/bulk-status',
      headers: { 'x-test-user': 'paul' },
      payload: { ids: [1, 2], status: 'acknowledged' }
    })
    const upd = sql.ran.find((q) => q.method === 'update')!
    expect(upd.sql).toMatch(/\(\[raised_by\] = @p\d+ or \[assigned_to\] = @p\d+\)/)
    expect(upd.bindings).toContain('PAUL')

    sql.ran.length = 0
    await app.inject({
      method: 'POST',
      url: '/issues/bulk-status',
      headers: { 'x-test-user': 'admin' },
      payload: { ids: [1, 2], status: 'acknowledged' }
    })
    expect(sql.ran.find((q) => q.method === 'update')!.sql).not.toContain('[raised_by]')
    await app.close()
  })
})
