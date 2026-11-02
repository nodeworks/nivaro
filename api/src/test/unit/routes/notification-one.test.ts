import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// GET /api/notifications/:id — the caller's own notification, shaped like one row of the list
// (the phone app opens the notification a push named). Another person's id or an unknown id
// → 404. A phone's device token signs in like a session, so it reaches this route too.

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  users: [] as Array<Record<string, unknown>>
}))

vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  const db = makeFakeDb((q) => {
    if (q.sql.includes('nivaro_notifications')) {
      // `where [id] = @p… and [recipient] = @p…` filter like the database; count/select for
      // the list.
      const hits = h.rows.filter(
        (r) =>
          (!/\[id\] = @p\d/.test(q.sql) || q.bindings.includes(r.id)) &&
          (!/\[recipient\] = @p\d/.test(q.sql) || q.bindings.includes(r.recipient))
      )
      if (/count\(\*\)/i.test(q.sql)) return q.method === 'first' ? { count: hits.length } : []
      return q.method === 'first' ? hits[0] : hits
    }
    if (q.sql.includes('nivaro_users'))
      return h.users.filter((u) => q.bindings.includes(u.id as string))
    return q.method === 'first' ? undefined : []
  })
  return { db }
})
vi.mock('../../../middleware/authenticate.js', () => {
  const sign = async (req: {
    headers: Record<string, string | undefined>
    user?: unknown
    authMethod?: string
    deviceGrantId?: string
  }) => {
    const id = req.headers['x-user']
    if (!id) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id, status: 'active' }
    // A phone: device token → authMethod 'device' + its grant.
    if (req.headers['x-device']) {
      req.authMethod = 'device'
      req.deviceGrantId = req.headers['x-device']
    } else req.authMethod = 'session'
  }
  return { requireAuth: vi.fn(sign), requireAdmin: vi.fn(sign), authenticate: vi.fn(sign) }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/notification-center.js', async (orig) => ({
  ...(await orig<object>()),
  autoCleanup: vi.fn(async () => {})
}))
vi.mock('../../../services/notification-target.js', async (orig) => ({
  ...(await orig<object>()),
  resolveTargetUrl: vi.fn(async () => '/collections/workflows/9')
}))

const { notificationsRoutes } = await import('../../../routes/notifications.js')

const PAT = 'AAAAAAAA-0000-4000-8000-000000000001'
const SAM = 'BBBBBBBB-0000-4000-8000-000000000002'
const row = (id: number, recipient: string, extra: Record<string, unknown> = {}) => ({
  id,
  recipient,
  sender: SAM,
  subject: 'Approve PO',
  message: 'CM26-1 waits',
  status: 'inbox',
  collection: 'workflows',
  item: '9',
  timestamp: '2026-11-01T12:00:00.000Z',
  ...extra
})

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(notificationsRoutes, { prefix: '/notifications' })
  await app.ready()
})
afterAll(() => app.close())
beforeEach(() => {
  h.rows = [row(5, PAT), row(6, SAM)]
  h.users = [{ id: SAM, first_name: 'Sam', last_name: 'Ray', email: 'sam@x' }]
})

const get = (url: string, headers: Record<string, string>) => app.inject({ url, headers })

describe('GET /notifications/:id', () => {
  it('answers my notification in the same shape as one row of the list', async () => {
    const one = await get('/notifications/5', { 'x-user': PAT })
    expect(one.statusCode).toBe(200)
    const list = await get('/notifications', { 'x-user': PAT })
    const fromList = (list.json().data as Array<{ id: number }>).find((r) => r.id === 5)
    expect(fromList).toBeTruthy()
    expect(one.json().data).toEqual(fromList)
    expect(one.json().data).toMatchObject({
      id: 5,
      title: 'Approve PO',
      sender_name: 'Sam Ray',
      url: '/collections/workflows/9'
    })
  })

  it('another person’s id, an unknown id or a junk id → 404', async () => {
    for (const id of ['6', '999', 'abc', '5.5'])
      expect([id, (await get(`/notifications/${id}`, { 'x-user': PAT })).statusCode]).toEqual([
        id,
        404
      ])
  })

  it('a phone signed in with its device token reads it too', async () => {
    const r = await get('/notifications/5', { 'x-user': PAT, 'x-device': 'grant-1' })
    expect(r.statusCode).toBe(200)
    expect(r.json().data.id).toBe(5)
  })
})
