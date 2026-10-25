import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// Support tickets: an id like 1e99 or a 20-digit number answered 500 "Bigint
// must be safe integer"; it is now a plain 404. A double-click on Send request
// filed the ticket twice (two POSTs 64 ms apart); the same person sending the
// same request within the window now gets the first ticket back.

vi.mock('../../../middleware/authenticate.js', () => {
  const requireAuth = vi.fn(
    async (req: {
      headers: Record<string, string | undefined>
      user?: unknown
      isAdmin?: boolean
    }) => {
      req.user = { id: String(req.headers['x-test-user'] ?? 'u1').toUpperCase() }
      req.isAdmin = false
    }
  )
  return { requireAuth, requireAdmin: requireAuth }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => false) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/items.js', () => ({ readOne: vi.fn(async () => ({ id: 1 })) }))
vi.mock('../../../services/page-at.js', () => ({ cleanAppLabel: vi.fn(() => null) }))
vi.mock('../../../services/support-analytics.js', () => ({
  DEFAULT_TARGETS: {},
  loadSupportAnalytics: vi.fn()
}))
vi.mock('../../../services/workflow-transitions.js', () => ({
  resolveFriendlyId: vi.fn(async (_c: string, i: string) => i)
}))
vi.mock('../../../services/support-tickets.js', () => ({
  canSeeTicket: vi.fn(async () => true),
  canWorkDesk: vi.fn(async () => false),
  canWorkTicket: vi.fn(async () => false),
  logTicketEvent: vi.fn(async () => {}),
  nameOf: vi.fn(),
  notifyTicket: vi.fn(async () => {}),
  OPEN_STATUSES: ['open', 'in_progress'],
  parseAttachments: vi.fn(() => []),
  STATUS_LABELS: {},
  SUPPORT_KIND: 'support',
  supportAudience: vi.fn(async () => []),
  TICKET_STATUSES: ['open', 'in_progress', 'done', 'cancelled'],
  teamIdsOf: vi.fn(async () => []),
  userName: vi.fn(() => null),
  viewerOf: vi.fn((req: { user: { id: string } }) => ({ id: req.user.id, isAdmin: false }))
}))

const db = vi.hoisted(() => ({
  ran: [] as FakeQuery[],
  tasks: [] as Array<Record<string, unknown>>
}))
vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb(async (q) => {
      db.ran.push(q)
      if (q.method === 'insert' && q.sql.includes('[nivaro_tasks]')) {
        // A little latency, so the second click's request overlaps the first.
        await new Promise((r) => setTimeout(r, 50))
        const id = db.tasks.length + 1
        const [cols] = /\(([^)]*)\) output/.exec(q.sql)!.slice(1)
        const names = cols.split(',').map((c) => c.trim().replace(/[[\]]/g, ''))
        const row: Record<string, unknown> = { id }
        for (const [i, n] of names.entries()) row[n] = q.bindings[i]
        db.tasks.push(row)
        return [{ id }]
      }
      if (q.sql.includes('[nivaro_tasks]')) {
        if (q.method === 'first') return db.tasks.find((t) => t.id === q.bindings.at(-1))
        // The twin lookup: kind, created_by, title, created_at window.
        const [, , by, title] = q.bindings
        return db.tasks
          .filter((t) => t.created_by === by && t.title === title)
          .map((t) => ({ ...t }))
      }
      return []
    })
  }
})

import { supportRoutes } from '../../../routes/support.js'

async function buildApp() {
  const app = Fastify()
  await app.register(supportRoutes, { prefix: '/support' })
  await app.ready()
  return app
}

beforeEach(() => {
  db.ran.length = 0
  db.tasks.length = 0
})

describe('support ticket ids', () => {
  it.each(['1e99', '99999999999999999999', '-1', 'abc'])('GET /tickets/%s is a 404', async (id) => {
    const app = await buildApp()
    const res = await app.inject({ url: `/support/tickets/${id}` })
    expect(res.statusCode).toBe(404)
    expect(db.ran).toHaveLength(0)
    await app.close()
  })
})

describe('POST /support/tickets duplicates', () => {
  const send = (app: Awaited<ReturnType<typeof buildApp>>, title: string, who = 'u1') =>
    app.inject({
      method: 'POST',
      url: '/support/tickets',
      headers: { 'x-test-user': who },
      payload: { title, description: 'Details' }
    })

  it('files one ticket for a double-click and answers the second with it', async () => {
    const app = await buildApp()
    const [a, b] = await Promise.all([send(app, 'Help with PO'), send(app, 'Help with PO')])
    expect(db.tasks).toHaveLength(1)
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201])
    const dup = a.statusCode === 200 ? a : b
    expect(dup.json().duplicate).toBe(true)
    expect(dup.json().data.id).toBe(1)
    await app.close()
  })

  it('still files a different request, and the same request from someone else', async () => {
    const app = await buildApp()
    expect((await send(app, 'First question')).statusCode).toBe(201)
    expect((await send(app, 'Second question')).statusCode).toBe(201)
    expect((await send(app, 'First question', 'u2')).statusCode).toBe(201)
    expect(db.tasks).toHaveLength(3)
    await app.close()
  })
})
