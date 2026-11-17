import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// POST /support/tickets/bulk: every id goes through PATCH's own path, and the answer says per
// id what happened. Assignment asks for email for the new assignee only.

vi.mock('../../../middleware/authenticate.js', () => {
  const requireAuth = vi.fn(
    async (req: { headers: Record<string, string | undefined>; user?: unknown }) => {
      req.user = { id: String(req.headers['x-test-user'] ?? 'WORKER').toUpperCase() }
    }
  )
  return { requireAuth, requireAdmin: requireAuth }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => false) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/items.js', () => ({ readOne: vi.fn(async () => ({ id: 1 })) }))
vi.mock('../../../services/page-at.js', () => ({ cleanAppLabel: vi.fn(() => null) }))
vi.mock('../../../services/record-help.js', () => ({
  announceRecordHelp: vi.fn(),
  loadRecordHelp: vi.fn()
}))
vi.mock('../../../services/tasks.js', () => ({
  taskColumns: vi.fn(async () => ({ completedBy: false }))
}))
const resolved = vi.hoisted(() => [] as unknown[])
vi.mock('../../../services/notification-resolve.js', () => ({
  resolveNotifications: vi.fn(async (o: unknown) => {
    resolved.push(o)
  })
}))
vi.mock('../../../routes/support-screen-share.js', () => ({
  screenShareTicketChanged: vi.fn(async () => {}),
  supportScreenShareRoutes: async () => {}
}))
vi.mock('../../../services/support-analytics.js', () => ({
  DEFAULT_TARGETS: {},
  loadSupportAnalytics: vi.fn()
}))
vi.mock('../../../services/workflow-transitions.js', () => ({
  resolveFriendlyId: vi.fn(async (_c: string, i: string) => i),
  resolveFriendlyIds: vi.fn(async () => new Map())
}))
const sent = vi.hoisted(
  () =>
    [] as Array<{
      to: string[]
      subject: string
      email?: boolean
      emailRequester?: boolean
      ticket: number
    }>
)
vi.mock('../../../services/support-tickets.js', () => ({
  // WORKER works team 1; REQ raised every ticket and works none.
  canSeeTicket: vi.fn(async () => true),
  canWorkDesk: vi.fn(async (v: { id: string }) => v.id === 'WORKER'),
  canWorkTicket: vi.fn(
    async (v: { id: string }, t: { team_id: number | null }) => v.id === 'WORKER' && t.team_id === 1
  ),
  logTicketEvent: vi.fn(async () => {}),
  nameOf: vi.fn(async (id: string) => (id ? `Name of ${id}` : null)),
  notifyTicket: vi.fn(
    async (
      _app: unknown,
      t: { id: number },
      to: Array<string | null>,
      o: { subject: string; email?: boolean; emailRequester?: boolean }
    ) => {
      sent.push({
        to: to.filter(Boolean) as string[],
        subject: o.subject,
        email: o.email,
        emailRequester: o.emailRequester,
        ticket: t.id
      })
    }
  ),
  OPEN_STATUSES: ['open', 'in_progress'],
  parseAttachments: vi.fn(() => []),
  STATUS_LABELS: { open: 'Open', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' },
  SUPPORT_KIND: 'support',
  supportAudience: vi.fn(async () => []),
  TICKET_STATUSES: ['open', 'in_progress', 'done', 'cancelled'],
  teamIdsOf: vi.fn(async () => [1]),
  userName: vi.fn(() => null),
  viewerOf: vi.fn((req: { user: { id: string } }) => ({ id: req.user.id, isAdmin: false }))
}))

const db = vi.hoisted(() => ({
  ran: [] as FakeQuery[],
  tasks: new Map<number, Record<string, unknown>>()
}))
vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb(async (q) => {
      db.ran.push(q)
      if (/from \[nivaro_users\]/.test(q.sql) && q.method === 'first')
        return q.bindings.includes('NOBODY') ? undefined : { id: q.bindings[0] }
      if (q.sql.includes('[nivaro_tasks]')) {
        if (q.method === 'update') {
          const id = Number(q.bindings.at(-1))
          const row = db.tasks.get(id)
          const cols = [...q.sql.matchAll(/\[(\w+)\] = \?/g)].map((m) => m[1])
          if (row) for (const [i, c] of cols.entries()) if (c !== 'id') row[c] = q.bindings[i]
          return 1
        }
        if (q.method === 'first') {
          const row = db.tasks.get(Number(q.bindings.at(-1)))
          return row ? { ...row } : undefined
        }
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

const ticket = (id: number, team_id: number | null, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'support',
  title: `Ticket ${id}`,
  status: 'open',
  priority: 'normal',
  assignee: null,
  created_by: 'REQ',
  team_id,
  category_id: null,
  ...extra
})

beforeEach(() => {
  db.ran.length = 0
  db.tasks.clear()
  sent.length = 0
  resolved.length = 0
  db.tasks.set(1, ticket(1, 1))
  db.tasks.set(2, ticket(2, 1))
  db.tasks.set(3, ticket(3, 2)) // another team's: WORKER may see but not work it
  db.tasks.set(4, ticket(4, 1, { status: 'done' }))
})

const bulk = (app: Awaited<ReturnType<typeof buildApp>>, payload: unknown, who = 'WORKER') =>
  app.inject({
    method: 'POST',
    url: '/support/tickets/bulk',
    headers: { 'x-test-user': who },
    payload: payload as Record<string, unknown>
  })

describe('POST /support/tickets/bulk', () => {
  it('closes what the caller works and names each refusal', async () => {
    const app = await buildApp()
    const res = await bulk(app, { ids: [1, 2, 3, 4, 99], status: 'done' })
    expect(res.statusCode).toBe(200)
    const { results, updated, refused, unchanged } = res.json().data
    expect(updated).toBe(2)
    expect(unchanged).toBe(1)
    expect(refused).toBe(2)
    expect(results).toEqual([
      { id: 1, outcome: 'updated' },
      { id: 2, outcome: 'updated' },
      { id: 3, outcome: 'refused', code: 'FORBIDDEN', reason: 'You do not work this request' },
      { id: 4, outcome: 'unchanged' },
      { id: 99, outcome: 'refused', code: 'NOT_FOUND', reason: 'Not found' }
    ])
    // Closing settles each request's notifications, exactly as PATCH does.
    expect(resolved).toHaveLength(2)
    await app.close()
  })

  it('refuses a bad status per id, never half-applies', async () => {
    const app = await buildApp()
    const res = await bulk(app, { ids: [1], status: 'archived' })
    expect(res.json().data.results[0]).toMatchObject({ outcome: 'refused', code: 'INVALID' })
    expect(db.ran.some((q) => q.method === 'update')).toBe(false)
    await app.close()
  })

  it('a requester can only cancel their own, never assign', async () => {
    const app = await buildApp()
    const assign = await bulk(app, { ids: [1], assignee: 'me' }, 'REQ')
    expect(assign.json().data.results[0]).toMatchObject({
      outcome: 'refused',
      reason: 'You can only cancel or reopen your own request'
    })
    const cancel = await bulk(app, { ids: [1], status: 'cancelled' }, 'REQ')
    expect(cancel.json().data.results[0]).toEqual({ id: 1, outcome: 'updated' })
    await app.close()
  })

  it('an unknown assignee is refused', async () => {
    const app = await buildApp()
    const res = await bulk(app, { ids: [1], assignee: 'NOBODY' })
    expect(res.json().data.results[0]).toMatchObject({ code: 'UNKNOWN_ASSIGNEE' })
    await app.close()
  })

  it('assigning tells the new assignee "Assigned to you" with email; others without', async () => {
    const app = await buildApp()
    const res = await bulk(app, { ids: [1], assignee: 'BETH' })
    expect(res.json().data.updated).toBe(1)
    const toBeth = sent.filter((s) => s.to.includes('BETH'))
    expect(toBeth).toEqual([
      { to: ['BETH'], subject: 'Assigned to you: Ticket 1', email: true, ticket: 1 }
    ])
    const general = sent.find((s) => !s.to.includes('BETH'))
    expect(general?.to).toEqual(['REQ'])
    expect(general?.email).toBeUndefined()
    await app.close()
  })

  it('taking it yourself sends no "Assigned to you"', async () => {
    const app = await buildApp()
    await bulk(app, { ids: [1], assignee: 'me' })
    expect(sent.some((s) => s.subject.startsWith('Assigned to you'))).toBe(false)
    await app.close()
  })

  it('400 on no ids, too many ids, or nothing to change', async () => {
    const app = await buildApp()
    expect((await bulk(app, { ids: [], status: 'done' })).statusCode).toBe(400)
    expect(
      (await bulk(app, { ids: Array.from({ length: 201 }, (_, i) => i + 1), status: 'done' }))
        .statusCode
    ).toBe(400)
    expect((await bulk(app, { ids: [1] })).statusCode).toBe(400)
    await app.close()
  })
})

describe('PATCH /support/tickets/:id shares the path', () => {
  it('403 with the reason for a ticket the caller cannot work', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'PATCH',
      url: '/support/tickets/3',
      headers: { 'x-test-user': 'WORKER' },
      payload: { status: 'done' }
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('FORBIDDEN')
    await app.close()
  })
})

// The requester's email opt-in (preferences.support_email_updates): notices that are news for
// the requester are marked `emailRequester` (notifyTicket reads the pref and asks for email on
// the requester's copy only — support-email-optin.test.ts); the desk's notices are not.
describe('support notices marked for the requester email opt-in', () => {
  it('a status change marks the notice to the requester', async () => {
    const app = await buildApp()
    await bulk(app, { ids: [1], status: 'done' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ to: ['REQ'], emailRequester: true, ticket: 1 })
    expect(sent[0].email).toBeUndefined()
    await app.close()
  })

  it('picking it up marks "Your request is in progress"', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/support/tickets/1/claim',
      headers: { 'x-test-user': 'WORKER' }
    })
    expect(res.statusCode).toBe(200)
    expect(sent).toEqual([
      {
        to: ['REQ'],
        subject: 'Your request is in progress: Ticket 1',
        emailRequester: true,
        ticket: 1
      }
    ])
    await app.close()
  })

  it('a desk reply is marked; the requester’s own reply to the desk is not', async () => {
    const app = await buildApp()
    const reply = (who: string) =>
      app.inject({
        method: 'POST',
        url: '/support/tickets/1/comments',
        headers: { 'x-test-user': who },
        payload: { text: 'Any news?' }
      })
    expect((await reply('WORKER')).statusCode).toBe(201)
    expect(sent.at(-1)).toMatchObject({ to: ['REQ'], emailRequester: true })
    expect((await reply('REQ')).statusCode).toBe(201)
    expect(sent.at(-1)?.emailRequester).toBe(false)
    expect(sent.at(-1)?.email).toBeUndefined()
    await app.close()
  })
})
