import { beforeEach, describe, expect, it, vi } from 'vitest'

// #3232 — comments left on one field: stored on the record's own thread with `field`,
// mentions notify only people who may open the record and read the field, and the
// notification opens the record on that field (?field=<name>).

type Row = Record<string, any>
const tables: Record<string, Row[]> = {}
const gate = vi.hoisted(() => ({
  writerMayComment: true,
  mayRead: new Set<string>()
}))
const sent = vi.hoisted(() => ({ calls: [] as Array<{ to: string; opts: any }> }))

vi.mock('../../../services/socket-access.js', () => ({
  canSeeRecordRoom: vi.fn(async () => true),
  visibleRecordIds: vi.fn(async (_u: unknown, _c: string, ids: string[]) => ids)
}))
vi.mock('../../../services/file-access.js', () => ({
  assertFileIdsReadable: vi.fn(async () => {})
}))
vi.mock('../../../services/record-notes.js', () => ({ loadRecordNotes: vi.fn(async () => []) }))
vi.mock('../../../config.js', () => ({
  config: { NODE_ENV: 'test', DB_DATABASE: 'testdb', DB_HOST: 'localhost', ENCRYPTION_KEY: null }
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async () => {}),
  authenticate: vi.fn(async () => {})
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn().mockResolvedValue(1) }))
vi.mock('../../../services/record-events.js', () => ({ announceRecordAspect: vi.fn() }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn().mockResolvedValue(true) }))
vi.mock('../../../services/pipeline-engine.js', () => ({
  resolveStateOwners: vi.fn(async () => [])
}))
vi.mock('../../../services/branch-instances.js', () => ({
  findRecordInstance: vi.fn(async () => null)
}))
vi.mock('../../../services/auto-watch.js', () => ({ ensureAutoWatch: vi.fn(async () => {}) }))
vi.mock('../../../services/mcp-attribution.js', () => ({
  agentBadgesForComments: vi.fn(async () => new Map())
}))
vi.mock('../../../services/microsoft.js', () => ({ sendTeamsNotification: vi.fn(async () => {}) }))
vi.mock('../../../services/notification-templates.js', () => ({
  renderNotificationTemplate: vi.fn(async () => null)
}))
vi.mock('../../../services/notification-channels.js', () => ({
  notifyUser: vi.fn(async (_app: unknown, to: string, opts: unknown) => {
    sent.calls.push({ to, opts })
    return { id: 1 }
  })
}))
vi.mock('../../../hooks/field-watches.js', () => ({
  subscribersWhoMayRead: vi.fn(async (subs: Array<{ id: string }>) =>
    subs.filter((s) => gate.mayRead.has(s.id))
  )
}))
vi.mock('../../../services/field-comments.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/field-comments.js')>()),
  hasFieldCommentColumns: vi.fn(async () => true),
  fieldMayBeCommented: vi.fn(async () => gate.writerMayComment)
}))

vi.mock('../../../db/index.js', () => {
  function builder(rawName: string) {
    const name = rawName.split(' as ')[0]
    const t = () => (tables[name] ??= [])
    const filters: Array<(r: Row) => boolean> = []
    const strip = (c: string) => c.split('.').pop()!
    const rows = () => t().filter((x) => filters.every((f) => f(x)))
    const b: any = {
      where(c: any, v?: any) {
        if (typeof c === 'object')
          for (const [k, val] of Object.entries(c)) filters.push((r) => r[strip(k)] === val)
        else filters.push((r) => r[strip(c)] === v)
        return b
      },
      // The handle match (email prefix / first name) is not modelled: every active user matches.
      andWhere: () => b,
      whereIn(c: string, vs: unknown[]) {
        filters.push((r) => vs.includes(r[strip(c)]))
        return b
      },
      whereNull(c: string) {
        filters.push((r) => r[strip(c)] == null)
        return b
      },
      whereRaw: () => b,
      leftJoin: () => b,
      orderBy: () => b,
      groupBy: () => b,
      count: () => Promise.resolve([]),
      catch: () => Promise.resolve([]),
      first: () => Promise.resolve(rows()[0]),
      select: () => Object.assign(Promise.resolve(rows()), { count: () => Promise.resolve([]) }),
      insert(v: Row) {
        t().push({ ...v })
        return Promise.resolve([v.id])
      },
      update(v: Row) {
        for (const r of rows()) Object.assign(r, v)
        return Promise.resolve(1)
      }
    }
    return b
  }
  const db: any = vi.fn((n: string) => builder(n))
  db.transaction = async (fn: any) => fn(db)
  db.raw = vi.fn()
  return { db }
})

import Fastify from 'fastify'
import { commentsRoutes } from '../../../routes/comments.js'

async function app(user: string, admin = false) {
  const a = Fastify()
  a.addHook('onRequest', async (req: any) => {
    req.user = { id: user, first_name: 'Ann', last_name: 'Author' }
    req.isAdmin = admin
  })
  await a.register(commentsRoutes, { prefix: '/comments' })
  return a
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  tables.nivaro_users = [
    { id: 'bob', email: 'bob@x.test', first_name: 'Bob', status: 'active', role: 'r' },
    { id: 'carol', email: 'carol@x.test', first_name: 'Carol', status: 'active', role: 'r' }
  ]
  tables.nivaro_comments = [
    { id: 'plain', collection: 'orders', item: '7', user: 'ann', text: 'hi', field: null },
    { id: 'onamt', collection: 'orders', item: '7', user: 'ann', text: 'x', field: 'amount' }
  ]
  gate.writerMayComment = true
  gate.mayRead = new Set(['bob'])
  sent.calls = []
})

describe('field comments (#3232)', () => {
  it('stores the field and notifies only mentioned people who may read the record and field', async () => {
    const a = await app('ann')
    const r = await a.inject({
      method: 'POST',
      url: '/comments',
      payload: {
        collection: 'orders',
        item: '7',
        text: '@bob @carol please check',
        field: 'amount',
        field_label: 'Order amount'
      }
    })
    expect(r.statusCode).toBe(201)
    const stored = tables.nivaro_comments.find((c) => c.text === '@bob @carol please check')
    expect(stored?.field).toBe('amount')
    // Both mentions are kept; only Bob (who may read) hears about it.
    expect(tables.nivaro_comment_mentions.map((m) => m.user).sort()).toEqual(['bob', 'carol'])
    expect(sent.calls.map((c) => c.to)).toEqual(['bob'])
    expect(sent.calls[0].opts).toMatchObject({
      subject: 'You were mentioned on Order amount',
      category: 'mentions',
      target: { kind: 'record', collection: 'orders', id: '7', query: 'field=amount' }
    })
    expect(sent.calls[0].opts.message).toMatch(/^On Order amount: @bob/)
  })

  it('a whole-record comment keeps notifying as before (no field gate, no field link)', async () => {
    const a = await app('ann')
    await a.inject({
      method: 'POST',
      url: '/comments',
      payload: { collection: 'orders', item: '7', text: '@bob @carol' }
    })
    expect(sent.calls.map((c) => c.to).sort()).toEqual(['bob', 'carol'])
    expect(sent.calls[0].opts.target.query).toBeUndefined()
  })

  it('refuses a field that is not a plain name, or one the writer may not read', async () => {
    const a = await app('ann')
    const bad = await a.inject({
      method: 'POST',
      url: '/comments',
      payload: { collection: 'orders', item: '7', text: 'x', field: 'vendor.name' }
    })
    expect(bad.statusCode).toBe(400)
    gate.writerMayComment = false
    const hidden = await a.inject({
      method: 'POST',
      url: '/comments',
      payload: { collection: 'orders', item: '7', text: 'x', field: 'salary' }
    })
    expect(hidden.statusCode).toBe(404)
    expect(tables.nivaro_comments).toHaveLength(2)
  })

  it('lists the field on each comment', async () => {
    const a = await app('ann')
    const r = await a.inject({ method: 'GET', url: '/comments?collection=orders&item=7' })
    expect(r.json().data.map((c: any) => [c.id, c.field, c.resolved_at])).toEqual([
      ['plain', null, null],
      ['onamt', 'amount', null]
    ])
  })

  it('resolves and reopens field comments only', async () => {
    const a = await app('ann')
    const r = await a.inject({ method: 'POST', url: '/comments/onamt/resolve', payload: {} })
    expect(r.json().data).toEqual({ id: 'onamt', resolved: true })
    const row = tables.nivaro_comments.find((c) => c.id === 'onamt')!
    expect(row.resolved_at).toBeInstanceOf(Date)
    expect(row.resolved_by).toBe('ann')
    await a.inject({ method: 'POST', url: '/comments/onamt/resolve', payload: { resolved: false } })
    expect(row.resolved_at).toBeNull()
    const plain = await a.inject({ method: 'POST', url: '/comments/plain/resolve', payload: {} })
    expect(plain.statusCode).toBe(400)
  })
})
