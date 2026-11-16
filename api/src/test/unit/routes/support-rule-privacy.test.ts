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
// The activity table as rows: the ticket's own lines (logTicketEvent → nivaro_tasks) and the
// rule detail (logActivity under its own collection).
const activity = vi.hoisted(
  () => [] as Array<{ collection: string; item: string; action: string; comment: string }>
)
/** A read of nivaro_activity honours the collection(s) the route bound. */
const activityRows = vi.hoisted(() => (bindings: unknown[]) => {
  const cols: unknown[] = bindings.filter(
    (b) => b === 'nivaro_tasks' || b === 'nivaro_support_rules'
  )
  return activity
    .filter((a) => cols.includes(a.collection))
    .map((a, i) => ({
      id: i + 1,
      action: a.action,
      comment: a.comment,
      user: null,
      timestamp: new Date()
    }))
})
vi.mock('../../../services/activity.js', () => ({
  logActivity: vi.fn(
    async (o: { collection: string; item: string; action: string; comment: string }) => {
      activity.push({
        collection: o.collection,
        item: o.item,
        action: o.action,
        comment: o.comment
      })
    }
  ),
  logActivityThrottled: vi.fn()
}))
vi.mock('../../../services/mcp-calls.js', () => ({ mcpConnOf: vi.fn(() => null) }))
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser: vi.fn() }))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => false),
  getAllowedFields: vi.fn(async () => [])
}))
vi.mock('../../../services/record-access.js', () => ({
  compileAccessGates: vi.fn(),
  visibleIds: vi.fn(async () => [])
}))
vi.mock('../../../services/record-events.js', () => ({ announceRecordAspect: vi.fn() }))
vi.mock('../../../services/task-agents.js', () => ({
  listAssignableAgents: vi.fn(),
  resolveTaskAgent: vi.fn(),
  TaskAgentError: class extends Error {}
}))
vi.mock('../../../services/user-scopes.js', () => ({ seesAllRecords: vi.fn(async () => false) }))
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
    async (id: number, _u: string | null, text: string, _req: unknown, action = 'update') => {
      logged.push({ text, action })
      activity.push({ collection: 'nivaro_tasks', item: String(id), action, comment: text })
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
      if (/from \[nivaro_activity\]/.test(q.sql)) return activityRows(q.bindings)
      if (q.sql.includes('[nivaro_tasks]')) {
        if (q.method === 'first') return store.tasks[0] ? { ...store.tasks[0] } : undefined
        return []
      }
      return q.method === 'first' ? undefined : []
    })
  }
})

import { db } from '../../../db/index.js'
import { supportRoutes } from '../../../routes/support.js'
import { tasksRoutes } from '../../../routes/tasks.js'
import { whereInRecordSet } from '../../../services/overview/my-records.js'

async function buildApp() {
  const app = Fastify()
  await app.register(supportRoutes, { prefix: '/support' })
  await app.register(tasksRoutes, { prefix: '/tasks' })
  await app.ready()
  return app
}

beforeEach(() => {
  logged.length = 0
  activity.length = 0
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
      { text: 'Assigned to Beth Lawson', action: 'update' }
    ])
    // The rule detail is stored apart from the ticket's own rows (never under nivaro_tasks).
    expect(activity.filter((a) => a.comment.includes(SECRET))).toEqual([
      {
        collection: 'nivaro_support_rules',
        item: '1',
        action: 'support-rule',
        comment: `Assigned to Beth Lawson by rule “${SECRET}”`
      }
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

  it('the tasks history route (keyed on nivaro_tasks) never returns the rule detail', async () => {
    const app = await buildApp()
    await app.inject({
      method: 'POST',
      url: '/support/tickets',
      headers: { 'x-test-user': REQ },
      payload: { title: 'Help a third time' }
    })
    const res = await app.inject({ url: '/tasks/1/history', headers: { 'x-test-user': REQ } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Assigned to Beth Lawson')
    expect(res.body).not.toContain(SECRET)
    await app.close()
  })

  it('the activity list’s personal scopes cannot reach the rule detail', async () => {
    const app = await buildApp()
    await app.inject({
      method: 'POST',
      url: '/support/tickets',
      headers: { 'x-test-user': REQ },
      payload: { title: 'Help once more' }
    })
    const rule = activity.find((a) => a.action === 'support-rule')
    // scope=mine reads rows whose user is the caller: the rule detail has no user.
    const { logActivity } = await import('../../../services/activity.js')
    const call = vi
      .mocked(logActivity)
      .mock.calls.map((c) => c[0] as { action: string; user: unknown })
      .find((c) => c.action === 'support-rule')
    expect(call?.user).toBeNull()
    // scope=my_records reads (collection, item) pairs of the caller's records — a ticket is
    // (nivaro_tasks, id); the rule detail lives under another collection, so it never matches.
    const sql = whereInRecordSet(
      db('nivaro_activity as a').select('a.id'),
      new Map([['nivaro_tasks', new Set(['1'])]])
    ).toSQL()
    expect(sql.bindings).toContain('nivaro_tasks')
    expect(sql.bindings).not.toContain(rule?.collection)
    expect(rule?.collection).toBe('nivaro_support_rules')
    await app.close()
  })
})
