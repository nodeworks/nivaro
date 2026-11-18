import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setStoredExportLimitsForTests } from '../../../services/export-limits.js'

// H16 (security audit 2026-10-27): content export reads through the items
// service AS THE CALLER — never a raw table read.

const st = vi.hoisted(() => ({
  calls: [] as Array<{ user: unknown; collection: string; query: Record<string, unknown> }>,
  pages: [] as Array<Array<Record<string, unknown>>>,
  forbidden: false,
  rawReads: 0
}))
// Every page read takes a heavy-read slot as the caller (fix round 1).
const gate = vi.hoisted(() => ({ calls: [] as Array<string | null> }))
vi.mock('../../../services/read-gate.js', () => ({
  withReadGate: async (who: string | null, fn: () => Promise<unknown>) => {
    gate.calls.push(who)
    return fn()
  },
  clientGoneSignal: () => new AbortController().signal
}))
// Keyset paging needs an integer-keyed base table (services/export-paging.ts keysetEligible).
const paging = vi.hoisted(() => ({ eligible: true }))
vi.mock('../../../services/export-paging.js', async (orig) => ({
  ...(await orig<object>()),
  keysetEligible: async () => paging.eligible
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
  setStoredExportLimitsForTests({})
  st.calls = []
  st.pages = []
  st.forbidden = false
  st.rawReads = 0
  gate.calls = []
  paging.eligible = true
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
    // Keyset on id (fix round 1): the second page is `id > 2` on top of the caller's filter.
    expect(st.calls.map((c) => c.query.offset)).toEqual([0, 0])
    // Each page read went through the read gate, as the caller.
    expect(gate.calls).toEqual(['U1', 'U1'])
    expect(st.calls[1].query.filter).toEqual({
      _and: [{ team: { _eq: 'x' } }, { id: { _gt: 2 } }]
    })
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

  it('an answer made in the request holds request_rows and says so', async () => {
    process.env.EXPORT_REQUEST_MAX_ROWS = '1000'
    try {
      // 2-row pages (LIST_READ_MAX mocked to 2): 600 pages reach the 1,000-row request cap.
      st.pages = Array.from({ length: 600 }, (_, p) => [
        { id: p * 2 + 1, name: 'a' },
        { id: p * 2 + 2, name: 'b' }
      ])
      const r = await (await app()).inject({
        method: 'POST',
        url: '/api/content-export/staff',
        payload: { format: 'json' }
      })
      expect(r.json().data).toHaveLength(1000)
      expect(r.headers['x-nivaro-export-truncated']).toBe('1000')
    } finally {
      delete process.env.EXPORT_REQUEST_MAX_ROWS
    }
  })

  it('a collection without an integer key (a view) pages by OFFSET', async () => {
    paging.eligible = false
    st.pages = [
      [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' }
      ],
      [{ id: 'c', name: 'C' }]
    ]
    await (await app()).inject({
      method: 'POST',
      url: '/api/content-export/staff',
      payload: { format: 'json', filters: { team: 'x' } }
    })
    expect(st.calls.map((c) => c.query.offset)).toEqual([0, 2])
    expect(st.calls[1].query.filter).toEqual({ team: { _eq: 'x' } })
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
