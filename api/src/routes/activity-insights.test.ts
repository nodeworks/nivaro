import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** #13 "What they did": admin or the person themself; the export is itself logged. */

const ME = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
let who: { id: string; admin: boolean } = { id: ME, admin: false }

vi.mock('../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: who.id }
    req.isAdmin = who.admin
  },
  requireAdmin: async (req: { isAdmin?: boolean }) => {
    if (!req.isAdmin) throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
  }
}))
const logActivity = vi.fn().mockResolvedValue(1)
vi.mock('../services/activity.js', () => ({ logActivity: (...a: unknown[]) => logActivity(...a) }))
const fetchActivityRows = vi.fn()
vi.mock('../services/activity-export.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/activity-export.js')>()),
  fetchActivityRows: (...a: unknown[]) => fetchActivityRows(...a)
}))

const personDidLabels = vi.fn()
vi.mock('../services/person-did.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/person-did.js')>()
  return {
    ...real,
    loadJunctionMap: async () =>
      real.buildJunctionMap([
        {
          many_collection: 'invoices_tags',
          many_field: 'invoices_id',
          one_collection: 'invoices',
          one_field: 'tags',
          junction_field: 'tags_id'
        },
        {
          many_collection: 'invoices_tags',
          many_field: 'tags_id',
          one_collection: 'tags',
          one_field: null,
          junction_field: 'invoices_id'
        }
      ]),
    readChangedFields: async () => new Map([[2, ['amount']]]),
    personDidLabels: (...a: unknown[]) => personDidLabels(...a)
  }
})

import { activityInsightRoutes } from './activity-insights.js'

const rows = [
  {
    id: 2,
    action: 'update',
    user: ME,
    timestamp: '2026-10-29T12:00:00.000Z',
    collection: 'invoices',
    item: '5',
    comment: null
  },
  {
    id: 1,
    action: 'create',
    user: ME,
    timestamp: '2026-10-28T12:00:00.000Z',
    collection: 'invoices',
    item: '5',
    comment: null
  }
]

async function build() {
  const app = Fastify()
  await app.register(activityInsightRoutes)
  await app.ready()
  return app
}

afterEach(() => {
  who = { id: ME, admin: false }
  logActivity.mockClear()
  fetchActivityRows.mockReset()
})
beforeEach(() => {
  personDidLabels.mockReset()
  personDidLabels.mockResolvedValue({
    records: { 'invoices:5': 'INV-0005 · Acme' },
    collections: { invoices: { singular: 'Invoice', plural: 'Invoices' } },
    fields: { 'invoices.amount': 'Amount', 'invoices.tags': 'Tags' },
    junctions: {
      'invoices_tags:9': {
        parent_collection: 'invoices',
        parent_id: '5',
        noun: 'Tag',
        value: 'Urgent'
      }
    }
  })
})

describe('person activity', () => {
  it('lets a person read their own summary, grouped by day', async () => {
    fetchActivityRows.mockResolvedValue({ rows, truncated: false })
    const app = await build()
    const r = await app.inject({ method: 'GET', url: `/people/${ME}/summary?tz=UTC` })
    expect(r.statusCode).toBe(200)
    expect(r.json().data.days.map((d: { day: string }) => d.day)).toEqual([
      '2026-10-29',
      '2026-10-28'
    ])
    expect(fetchActivityRows.mock.calls[0][0]).toMatchObject({ user: ME })
    await app.close()
  })

  it('refuses someone else’s trail to a non-admin, allows it to an admin', async () => {
    fetchActivityRows.mockResolvedValue({ rows: [], truncated: false })
    const app = await build()
    expect((await app.inject({ method: 'GET', url: `/people/${OTHER}/summary` })).statusCode).toBe(
      403
    )
    expect((await app.inject({ method: 'POST', url: `/people/${OTHER}/export` })).statusCode).toBe(
      403
    )
    who = { id: ME, admin: true }
    expect((await app.inject({ method: 'GET', url: `/people/${OTHER}/summary` })).statusCode).toBe(
      200
    )
    await app.close()
  })

  it('logs the export as activity-export and returns the CSV', async () => {
    fetchActivityRows.mockResolvedValue({ rows, truncated: false })
    who = { id: ME, admin: true }
    const app = await build()
    const r = await app.inject({
      method: 'POST',
      url: `/people/${OTHER}/export`,
      payload: { days: 7 }
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().data.rows).toBe(2)
    expect(r.json().data.csv.split('\r\n')[0]).toContain('Time (UTC)')
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'activity-export',
        user: ME,
        collection: 'nivaro_users',
        item: OTHER,
        comment: 'csv · 2 rows · last 7 days'
      })
    )
    await app.close()
  })

  it('returns one day’s entries in the viewer’s zone, as readable lines', async () => {
    fetchActivityRows.mockResolvedValue({ rows, truncated: false })
    const app = await build()
    const r = await app.inject({
      method: 'GET',
      url: `/people/${ME}/entries?day=2026-10-28&collection=invoices&tz=UTC`
    })
    expect(r.json().data).toEqual([
      expect.objectContaining({
        ids: [1],
        verb: 'Created',
        target: 'Invoice INV-0005 · Acme',
        record: { collection: 'invoices', id: '5' }
      })
    ])
    // A parent's group reads its link tables too; labels are read as the caller.
    expect(fetchActivityRows.mock.calls[0][0].collections).toEqual(['invoices', 'invoices_tags'])
    expect(personDidLabels.mock.calls[0][0]).toMatchObject({ id: ME })
    await app.close()
  })

  it('folds link-table writes into the parent edit and speaks plain verbs', async () => {
    fetchActivityRows.mockResolvedValue({
      rows: [
        { ...rows[0], id: 3, collection: 'invoices_tags', item: '9', action: 'create' },
        rows[0],
        { ...rows[0], id: 4, action: 'read', timestamp: '2026-10-29T11:00:00.000Z' },
        { ...rows[0], id: 5, action: 'read', timestamp: '2026-10-29T10:00:00.000Z' }
      ],
      truncated: false
    })
    const app = await build()
    const sum = await app.inject({ method: 'GET', url: `/people/${ME}/summary?tz=UTC` })
    const g = sum.json().data.days[0].collections
    expect(g).toEqual([
      expect.objectContaining({
        collection: 'invoices',
        label: 'Invoices',
        parts: [
          { verb: 'Edited', count: 1 },
          { verb: 'Opened', count: 1 }
        ]
      })
    ])
    const r = await app.inject({
      method: 'GET',
      url: `/people/${ME}/entries?day=2026-10-29&collection=invoices&tz=UTC`
    })
    const lines = r.json().data
    expect(
      lines.map((l: { verb: string; count: number; detail: string | null }) => [
        l.verb,
        l.count,
        l.detail
      ])
    ).toEqual([
      ['Edited', 1, 'Changed Amount · added Tag Urgent'],
      ['Opened', 2, null]
    ])
    expect(JSON.stringify(lines)).not.toContain('#5')
    await app.close()
  })

  it('keeps the search parse for administrators', async () => {
    const app = await build()
    const r = await app.inject({ method: 'POST', url: '/parse', payload: { text: 'x' } })
    expect(r.statusCode).toBe(403)
    await app.close()
  })
})
