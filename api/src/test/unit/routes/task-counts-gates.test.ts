import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Task helpers (army 2026-10-25): open/overdue counts came back for records
// the caller cannot see, and a bad due_date reached SQL as a 500.

const who = vi.hoisted(() => ({ hidden: new Set<string>() }))
const whereIns = vi.hoisted(() => [] as unknown[][])
const updates = vi.hoisted(() => [] as unknown[])

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'u-paul', role: 'role-approver' }
    req.isAdmin = false
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser: vi.fn(async () => {}) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/record-events.js', () => ({ announceRecordAspect: vi.fn() }))
vi.mock('../../../services/record-access.js', () => ({
  compileAccessGates: vi.fn(async () => ({})),
  visibleIds: vi.fn(
    async (_g: unknown, ids: string[]) => new Set(ids.filter((i) => !who.hidden.has(i)))
  )
}))
vi.mock('../../../services/tasks.js', () => ({
  ACTIVE_STATUSES: ['open', 'in_progress'],
  TASK_PRIORITIES: ['low', 'normal', 'urgent'],
  TASK_STATUSES: ['open', 'in_progress', 'done', 'cancelled'],
  TaskInputError: class extends Error {},
  isTaskParty: vi.fn(() => true),
  taskColumns: vi.fn(async () => ({ reminders: false, completedBy: false })),
  bustDoneWhenCache: vi.fn(),
  canReadTaskRecord: vi.fn(async () => true),
  completeTask: vi.fn(),
  createTask: vi.fn(),
  describeTaskChange: vi.fn(() => ''),
  emitTaskEvent: vi.fn(),
  logTaskEvent: vi.fn(async () => {}),
  namesOf: vi.fn(async () => new Map()),
  normalizeDoneWhen: vi.fn(),
  notifyAssignee: vi.fn(async () => {}),
  shortDate: vi.fn(() => '')
}))
vi.mock('../../../db/index.js', () => {
  const db = vi.fn((t: string) => {
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'whereNot', 'orWhereNot', 'whereNull', 'groupBy', 'select'])
      c[m] = vi.fn((arg?: unknown) => {
        if (typeof arg === 'function') (arg as (q: unknown) => void)(c)
        return c
      })
    c.whereIn = vi.fn((...args: unknown[]) => {
      whereIns.push(args)
      return c
    })
    c.first = vi.fn(async () =>
      t === 'nivaro_tasks' ? { id: 1, title: 't', status: 'open', assignee: 'u-paul' } : undefined
    )
    c.update = vi.fn(async (row: unknown) => {
      updates.push(row)
      return 1
    })
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve([]).then(res, rej)
    return c
  })
  ;(db as unknown as { raw: unknown }).raw = vi.fn((s: string) => s)
  return { db }
})

import { tasksRoutes } from '../../../routes/tasks.js'

async function call(method: 'POST' | 'PATCH', url: string, payload: unknown) {
  const app = Fastify({ logger: false })
  app.decorate('io', { to: () => ({ emit: () => true }) } as never)
  await app.register(tasksRoutes)
  return app.inject({ method, url, payload: payload as object })
}

beforeEach(() => {
  who.hidden.clear()
  whereIns.length = 0
  updates.length = 0
})

describe('POST /counts', () => {
  it('counts only records the caller can see', async () => {
    who.hidden.add('372797')
    const res = await call('POST', '/counts', { collection: 'workflows', ids: ['1', '372797'] })
    expect(res.statusCode).toBe(200)
    expect(whereIns.find((a) => a[0] === 'item')?.[1]).toEqual(['1'])
  })
  it('answers empty without a query when none is visible', async () => {
    who.hidden.add('372797')
    const res = await call('POST', '/counts', { collection: 'workflows', ids: ['372797'] })
    expect(JSON.parse(res.body)).toEqual({ data: {} })
    expect(whereIns.find((a) => a[0] === 'item')).toBeUndefined()
  })
})

describe('PATCH /:id', () => {
  it('400s a due_date that is not a date (was a SQL 500)', async () => {
    const res = await call('PATCH', '/1', { due_date: 'x' })
    expect(res.statusCode).toBe(400)
    expect(updates).toHaveLength(0)
  })
  it('400s a non-uuid assignee before it reaches SQL', async () => {
    expect((await call('PATCH', '/1', { assignee: 'not-a-user' })).statusCode).toBe(400)
  })
})
