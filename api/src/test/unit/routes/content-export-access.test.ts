import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// H16 (security audit 2026-10-27): content export reads through the items
// service AS THE CALLER — never a raw table read.

const st = vi.hoisted(() => ({
  calls: [] as Array<{ user: unknown; collection: string; query: Record<string, unknown> }>,
  pages: [] as Array<Array<Record<string, unknown>>>,
  forbidden: false,
  rawReads: 0
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown }) => {
    req.user = { id: 'U1', role: 'R1' }
  }
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/help-video-files.js', () => ({ isFilesCollection: () => false }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/items.js', () => {
  class ForbiddenError extends Error {}
  class CollectionNotFoundError extends Error {}
  return {
    ForbiddenError,
    CollectionNotFoundError,
    LIST_READ_MAX: 2,
    getActualColumns: vi.fn(async () => new Set(['id', 'name', 'salary'])),
    readItems: vi.fn(async (user: unknown, collection: string, query: Record<string, unknown>) => {
      st.calls.push({ user, collection, query })
      if (st.forbidden) throw new ForbiddenError()
      return { data: st.pages.shift() ?? [] }
    })
  }
})
vi.mock('../../../db/index.js', () => ({
  db: (table: string) => {
    if (table !== 'nivaro_collections') st.rawReads++
    const b: Record<string, unknown> = {}
    b.where = () => b
    b.first = async () => ({ collection: 'staff' })
    return b
  }
}))

import { contentExportRoutes } from '../../../routes/content-export.js'

async function app() {
  const a = Fastify()
  await a.register(contentExportRoutes, { prefix: '/api/content-export' })
  return a
}

beforeEach(() => {
  st.calls = []
  st.pages = []
  st.forbidden = false
  st.rawReads = 0
})

describe('POST /content-export/:collection', () => {
  it('pages through readItems as the caller with filters as _eq', async () => {
    // The caller's field policy hides `salary`: the service never returns it.
    st.pages = [
      [
        { id: 1, name: 'A' },
        { id: 2, name: 'B' }
      ],
      [{ id: 3, name: 'C' }]
    ]
    const r = await (await app()).inject({
      method: 'POST',
      url: '/api/content-export/staff',
      payload: { format: 'json', filters: { team: 'x' }, fields: ['id', 'name', 'salary'] }
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toHaveLength(3)
    expect(st.rawReads).toBe(0)
    expect(st.calls[0]).toMatchObject({
      user: { id: 'U1' },
      collection: 'staff',
      query: { filter: { team: { _eq: 'x' } }, fields: ['id', 'name', 'salary'], sort: ['id'] }
    })
    expect(st.calls.map((c) => c.query.offset)).toEqual([0, 2])
  })

  it('never names a column the caller could not read in the CSV header', async () => {
    st.pages = [[{ id: 1, name: 'A' }]]
    const r = await (await app()).inject({
      method: 'POST',
      url: '/api/content-export/staff',
      payload: { format: 'csv', fields: ['id', 'name', 'salary'] }
    })
    expect(r.body.split('\r\n')[0]).toBe('id,name')
  })

  it("answers 403 when the service refuses the caller's read", async () => {
    st.forbidden = true
    const r = await (await app()).inject({
      method: 'POST',
      url: '/api/content-export/staff',
      payload: { format: 'json', filters: { salary: 5 } }
    })
    expect(r.statusCode).toBe(403)
  })
})
