import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Army 6 M48: bell rows named records by row id ("WORKFLOWS · 372960"). Every row about a
// record carries record_label (the friendly id) + record_collection_label, resolved only for
// collections the caller may read — never the row id.

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  users: [] as Array<Record<string, unknown>>
}))

vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  const db = makeFakeDb((q) => {
    if (q.sql.includes('nivaro_notifications')) {
      // An int column refuses anything past int32: the route must never send one.
      if (q.bindings.some((b) => typeof b === 'number' && b > 2147483647))
        throw new Error('Arithmetic overflow converting to int')
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

vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<object>()),
  can: vi.fn(async (_u: unknown, _a: string, collection: string) => collection !== 'secret_things')
}))
vi.mock('../../../services/record-headline.js', async (orig) => ({
  ...(await orig<object>()),
  collectionWord: vi.fn(async (c: string) =>
    c === 'workflows' ? 'Workflow' : c === 'inventory_request' ? 'Inventory request' : 'Thing'
  ),
  recordHeadlines: vi.fn(async (c: string, ids: string[]) => {
    const word = c === 'workflows' ? 'Workflow' : 'Inventory request'
    return new Map(
      ids.map((id) => [
        id,
        {
          // 9 has a friendly id; 10 has nothing naming it (the "<Word> #<id>" fallback)
          label: id === '9' ? 'CR26-81410' : id === '37806' ? 'CM26INV-37423' : `${word} #${id}`,
          deleted: false,
          collection_label: word
        }
      ])
    )
  })
}))

const { notificationsRoutes, isBareHeadline } = await import('../../../routes/notifications.js')

const PAT = 'AAAAAAAA-0000-4000-8000-000000000001'
const row = (id: number, collection: string, item: string) => ({
  id,
  recipient: PAT,
  sender: null,
  subject: 'Waiting on you',
  message: 'x',
  status: 'inbox',
  collection,
  item,
  timestamp: '2026-11-06T12:00:00.000Z'
})

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  await app.register(notificationsRoutes, { prefix: '/notifications' })
  await app.ready()
})
afterAll(() => app.close())
beforeEach(() => {
  h.rows = [
    row(1, 'workflows', '9'),
    row(2, 'inventory_request', '37806'),
    row(3, 'workflows', '10'),
    row(4, 'secret_things', '5')
  ]
  h.users = []
})

describe('notification rows name their record (M48)', () => {
  it('friendly id + collection word; never the row id', async () => {
    const r = await app.inject({ url: '/notifications', headers: { 'x-user': PAT } })
    expect(r.statusCode).toBe(200)
    const by = new Map((r.json().data as Array<Record<string, unknown>>).map((x) => [x.id, x]))
    expect(by.get(1)).toMatchObject({
      record_label: 'CR26-81410',
      record_collection_label: 'Workflow'
    })
    expect(by.get(2)).toMatchObject({
      record_label: 'CM26INV-37423',
      record_collection_label: 'Inventory request'
    })
    // nothing names record 10: no label, never "Workflow #10"
    expect(by.get(3)).toMatchObject({ record_label: null, record_collection_label: 'Workflow' })
    // a collection the caller may not read: no label resolved
    expect(by.get(4)).toMatchObject({ record_label: null })
  })

  it('isBareHeadline spots the row-id fallback', () => {
    expect(isBareHeadline('Workflow #10', 'Workflow', '10')).toBe(true)
    expect(isBareHeadline('10', 'Workflow', '10')).toBe(true)
    expect(isBareHeadline('CR26-81410', 'Workflow', '9')).toBe(false)
  })
})
