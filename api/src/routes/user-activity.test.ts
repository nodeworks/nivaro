import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../test/fake-sql.js'

/** Profile Activity feed: the person's own rows plus access changes made TO them. */

const ADMIN = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'
const PAT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const seen: FakeQuery[] = []

vi.mock('../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: ADMIN }
    req.isAdmin = true
  },
  requireAdmin: async () => {}
}))
vi.mock('../services/collections.js', () => ({
  getCollection: async (c: string) => (c === 'workflows' ? { display_name: 'Workflows' } : null)
}))
vi.mock('../services/event-path/record-labels.js', () => ({
  labelPathRecords: async (steps: Array<{ record: { item: string; label?: string } | null }>) => {
    for (const s of steps) if (s.record?.item === '365984') s.record.label = 'CM26-365984 · Splice'
  }
}))
vi.mock('../services/junction-map.js', async (orig) => {
  const real = await orig<typeof import('../services/junction-map.js')>()
  const map = real.buildJunctionMap([
    {
      many_collection: 'workflows_divisions',
      many_field: 'workflows_id',
      one_collection: 'workflows',
      one_field: 'divisions',
      junction_field: 'divisions_id'
    },
    {
      many_collection: 'workflows_divisions',
      many_field: 'divisions_id',
      one_collection: 'divisions',
      one_field: null,
      junction_field: 'workflows_id'
    }
  ])
  return { ...real, loadJunctionMap: async () => map }
})
vi.mock('../db/index.js', async () => {
  const { makeFakeDb } = await import('../test/fake-sql.js')
  const db = makeFakeDb((q) => {
    seen.push(q)
    if (q.sql.includes('nivaro_access_requests'))
      return [{ collection: 'workflows', item: '365984' }]
    if (q.sql.includes('nivaro_users') && q.sql.includes('first_name'))
      return [{ id: ADMIN, first_name: 'Rob', last_name: 'Lee', email: null }]
    if (q.sql.includes('nivaro_activity') && q.bindings.includes('access-request-grant'))
      return [{ id: 501, timestamp: '2026-11-12T15:02:00.000Z' }]
    if (q.sql.includes('nivaro_activity') && /group by \[collection\]/i.test(q.sql))
      return [
        { collection: 'workflows', count: 10 },
        { collection: 'workflows_divisions', count: 8 },
        { collection: 'invoices', count: 12 }
      ]
    if (q.sql.includes('nivaro_activity') && /count\(/i.test(q.sql)) return [{ count: 2 }]
    if (q.sql.includes('nivaro_activity') && q.sql.includes('[ip]'))
      return [
        {
          id: 501,
          action: 'access-request-grant',
          user: ADMIN,
          timestamp: '2026-11-12T15:02:00.000Z',
          ip: null,
          collection: 'workflows',
          item: '365984',
          comment: `for user ${PAT} (Add CHI to their Region filter)`
        },
        {
          id: 470,
          action: 'update',
          user: PAT,
          timestamp: '2026-11-12T14:31:00.000Z',
          ip: null,
          collection: 'workflows',
          item: '372916',
          comment: null
        }
      ]
    return []
  })
  return { db }
})

import { userActivityRoutes } from './user-activity.js'

async function build() {
  const app = Fastify()
  await app.register(userActivityRoutes)
  await app.ready()
  return app
}

afterEach(() => {
  seen.length = 0
})

describe('profile activity feed', () => {
  it('lists a grant made to the person beside their own rows, in words', async () => {
    const app = await build()
    const r = await app.inject({ method: 'GET', url: `/${PAT}` })
    expect(r.statusCode).toBe(200)
    const feed = seen.find((q) => q.sql.includes('[ip]'))!
    // Their own rows OR the access changes found for them — one page, one total.
    expect(feed.sql).toMatch(/\[user\] = @p\d+ or \[id\] in \(@p\d+\)/i)
    expect(feed.bindings).toContain(501)
    const [grant, own] = r.json().data
    expect(grant).toMatchObject({
      id: 501,
      about_them: true,
      summary: 'Access granted to Workflow CM26-365984 · Splice by Rob Lee',
      detail: 'Added CHI to their Region filter',
      by: 'Rob Lee'
    })
    expect(own.about_them).toBeUndefined()
    await app.close()
  })

  it('finds grants through the person’s own requests, on the record and naming them', async () => {
    const app = await build()
    await app.inject({ method: 'GET', url: `/${PAT}/summary` })
    const q = seen.find((x) => x.bindings.includes('access-request-grant'))!
    expect(q.sql).toMatch(/\[collection\] = @p\d+ and \[item\] = @p\d+/)
    expect(q.bindings).toContain(`%for user ${PAT}%`)
    await app.close()
  })

  it('folds link tables into their parent in the collection filter, and filters with them', async () => {
    const app = await build()
    const sum = await app.inject({ method: 'GET', url: `/${PAT}/summary` })
    expect(
      sum
        .json()
        .data.collections.map((c: { collection: string; count: number }) => [c.collection, c.count])
    ).toEqual([
      ['workflows', 18],
      ['invoices', 12]
    ])
    seen.length = 0
    await app.inject({ method: 'GET', url: `/${PAT}?collection=workflows` })
    const feed = seen.find((q) => q.sql.includes('[ip]'))!
    expect(feed.bindings).toEqual(expect.arrayContaining(['workflows', 'workflows_divisions']))
    await app.close()
  })

  it('leaves them out with access=0', async () => {
    const app = await build()
    await app.inject({ method: 'GET', url: `/${PAT}?access=0` })
    expect(seen.some((q) => q.sql.includes('nivaro_access_requests'))).toBe(false)
    expect(seen.find((q) => q.sql.includes('[ip]'))!.sql).not.toMatch(/\[id\] in/)
    await app.close()
  })
})
