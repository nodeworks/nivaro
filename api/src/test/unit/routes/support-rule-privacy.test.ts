import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// An assignment rule's name can echo record values ("Vendor changes — Zone East"). The
// requester's history says only "Assigned to <person>"; the rule detail is a separate
// 'support-rule' row only people who work the ticket see.

const SECRET = 'Zone East vendor rule'
const REQ = 'REQ'
const WORKER = 'WORKER'
const ASSIGNEE = 'BBBBBBBB-0000-0000-0000-000000000002'

vi.mock('../../../middleware/authenticate.js', () => {
  const requireAuth = vi.fn(
    async (req: { headers: Record<string, string | undefined>; user?: unknown }) => {
      req.user = { id: String(req.headers['x-test-user'] ?? REQ).toUpperCase() }
    }
  )
  return { requireAuth, requireAdmin: requireAuth }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => false) }))
vi.mock('../../../services/activity.js', () => ({
  logActivity: vi.fn(async () => {}),
  logActivityThrottled: vi.fn()
}))
vi.mock('../../../services/items.js', () => ({ readOne: vi.fn(async () => ({ id: 1 })) }))
vi.mock('../../../services/page-at.js', () => ({ cleanAppLabel: vi.fn(() => null) }))
vi.mock('../../../services/record-help.js', () => ({
  announceRecordHelp: vi.fn(),
  loadRecordHelp: vi.fn()
}))
vi.mock('../../../routes/support-screen-share.js', () => ({
  screenShareTicketChanged: vi.fn(async () => {}),
  supportScreenShareRoutes: async () => {}
}))
vi.mock('../../../routes/support-assign-rules.js', () => ({
  supportAssignRuleRoutes: async () => {}
}))
vi.mock('../../../services/support-analytics.js', () => ({
  DEFAULT_TARGETS: {},
  loadSupportAnalytics: vi.fn()
}))
vi.mock('../../../services/workflow-transitions.js', () => ({
  resolveFriendlyId: vi.fn(async (_c: string, i: string) => i),
  resolveFriendlyIds: vi.fn(async () => new Map())
}))
vi.mock('../../../services/support-assign.js', () => ({
  loadRuleSet: vi.fn(async () => ({ rules: [{ active: true }], hours: {} })),
  decideAssignment: vi.fn(async () => ({
    trace: [],
    pick: null,
    outcome: {
      kind: 'person',
      user: { id: ASSIGNEE, name: 'Beth Lawson' },
      via: 'rule',
      rule: { id: 'r', name: SECRET },
      note: ''
    }
  })),
  noteAssignment: vi.fn()
}))
const logged = vi.hoisted(() => [] as Array<{ text: string; action: string }>)
vi.mock('../../../services/support-tickets.js', () => ({
  canSeeTicket: vi.fn(async () => true),
  canWorkDesk: vi.fn(async (v: { id: string }) => v.id === WORKER),
  canWorkTicket: vi.fn(async (v: { id: string }) => v.id === WORKER),
  logTicketEvent: vi.fn(
    async (_id: number, _u: string | null, text: string, _req: unknown, action = 'update') => {
      logged.push({ text, action })
    }
  ),
  nameOf: vi.fn(async () => 'Someone'),
  notifyTicket: vi.fn(async () => {}),
  OPEN_STATUSES: ['open', 'in_progress'],
  parseAttachments: vi.fn(() => []),
  STATUS_LABELS: { open: 'Open', in_progress: 'In progress' },
  SUPPORT_KIND: 'support',
  supportAudience: vi.fn(async () => []),
  TICKET_STATUSES: ['open', 'in_progress', 'done', 'cancelled'],
  teamIdsOf: vi.fn(async () => []),
  userName: vi.fn(() => null),
  viewerOf: vi.fn((req: { user: { id: string } }) => ({ id: req.user.id, isAdmin: false }))
}))

const store = vi.hoisted(() => ({ tasks: [] as Array<Record<string, unknown>> }))
vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb(async (q) => {
      if (q.method === 'insert' && q.sql.includes('[nivaro_tasks]')) {
        store.tasks.push({
          id: 1,
          kind: 'support',
          title: 'Help',
          status: 'in_progress',
          created_by: REQ,
          assignee: ASSIGNEE,
          priority: 'normal'
        })
        return [{ id: 1 }]
      }
      if (/from \[nivaro_activity\]/.test(q.sql))
        return logged.map((l, i) => ({
          id: i + 1,
          action: l.action,
          comment: l.text,
          user: null,
          timestamp: new Date()
        }))
      if (q.sql.includes('[nivaro_tasks]')) {
        if (q.method === 'first') return store.tasks[0] ? { ...store.tasks[0] } : undefined
        return []
      }
      return q.method === 'first' ? undefined : []
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
  logged.length = 0
  store.tasks.length = 0
})

describe('assignment rule names stay with the desk', () => {
  it('logs a neutral line for everyone and the rule detail as its own row', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/support/tickets',
      headers: { 'x-test-user': REQ },
      payload: { title: 'Help' }
    })
    expect(res.statusCode).toBe(201)
    expect(logged).toEqual([
      { text: 'Raised the request', action: 'create' },
      { text: 'Assigned to Beth Lawson', action: 'update' },
      { text: `Assigned to Beth Lawson by rule '${SECRET}'`, action: 'support-rule' }
    ])
    await app.close()
  })

  it('the requester’s ticket read never contains the rule name; a desk worker’s does', async () => {
    const app = await buildApp()
    await app.inject({
      method: 'POST',
      url: '/support/tickets',
      headers: { 'x-test-user': REQ },
      payload: { title: 'Help again' }
    })
    const mine = await app.inject({ url: '/support/tickets/1', headers: { 'x-test-user': REQ } })
    expect(mine.statusCode).toBe(200)
    expect(mine.body).not.toContain(SECRET)
    expect(mine.json().data.history.map((h: { text: string }) => h.text)).toContain(
      'Assigned to Beth Lawson'
    )
    const desk = await app.inject({ url: '/support/tickets/1', headers: { 'x-test-user': WORKER } })
    expect(desk.body).toContain(SECRET)
    await app.close()
  })
})
