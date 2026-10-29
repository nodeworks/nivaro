import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

  it('returns one day’s entries in the viewer’s zone', async () => {
    fetchActivityRows.mockResolvedValue({ rows, truncated: false })
    const app = await build()
    const r = await app.inject({
      method: 'GET',
      url: `/people/${ME}/entries?day=2026-10-28&collection=invoices&tz=UTC`
    })
    expect(r.json().data.map((e: { id: number }) => e.id)).toEqual([1])
    await app.close()
  })

  it('keeps the search parse for administrators', async () => {
    const app = await build()
    const r = await app.inject({ method: 'POST', url: '/parse', payload: { text: 'x' } })
    expect(r.statusCode).toBe(403)
    await app.close()
  })
})
