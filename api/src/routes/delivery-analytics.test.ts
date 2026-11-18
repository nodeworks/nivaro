import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Delivery analytics routes: administrators only; opening an email body is logged. */

let admin = true
vi.mock('../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA' }
    req.isAdmin = admin
  },
  requireAdmin: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA' }
    req.isAdmin = admin
    if (!admin) throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
  }
}))
vi.mock('../db/index.js', () => ({ db: Object.assign(() => ({}), { raw: vi.fn() }) }))
vi.mock('../lib/column-probe.js', () => ({ hasColumn: async () => false }))
const logActivity = vi.fn().mockResolvedValue(1)
vi.mock('../services/activity.js', () => ({ logActivity: (...a: unknown[]) => logActivity(...a) }))
const mailLeaf = vi.fn()
const notificationLeaf = vi.fn()
vi.mock('../services/delivery-analytics/data.js', async (orig) => ({
  ...(await orig<typeof import('../services/delivery-analytics/data.js')>()),
  mailLeaf: (...a: unknown[]) => mailLeaf(...a),
  notificationLeaf: (...a: unknown[]) => notificationLeaf(...a),
  enrichRows: async (_k: unknown, _s: unknown, rows: unknown[]) => rows
}))
const runLongQuery = vi.fn(async (_sql: string, _b: unknown[], _o?: unknown) => [] as unknown[])
vi.mock('../services/run-long.js', () => ({
  runLongQuery: (sql: string, b: unknown[], o?: unknown) => runLongQuery(sql, b, o)
}))
vi.mock('../services/export-limits.js', () => ({
  readExportLimit: async () => Number.POSITIVE_INFINITY
}))

import { asofFor, deliveryAnalyticsRoutes } from './delivery-analytics.js'

async function build() {
  const app = Fastify()
  await app.register(deliveryAnalyticsRoutes, { prefix: '/delivery-analytics' })
  await app.ready()
  return app
}

beforeEach(() => {
  admin = true
  runLongQuery.mockReset()
  runLongQuery.mockResolvedValue([])
  logActivity.mockClear()
  mailLeaf.mockReset()
  notificationLeaf.mockReset()
})

describe('delivery analytics routes', () => {
  it('refuses everyone but administrators, on every route', async () => {
    admin = false
    const app = await build()
    const urls = [
      '/delivery-analytics/summary',
      '/delivery-analytics/breakdown?by=category',
      '/delivery-analytics/rows?source=n&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z',
      '/delivery-analytics/rows?source=m&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&format=csv',
      '/delivery-analytics/split?source=n&by=category&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z',
      '/delivery-analytics/dimensions',
      '/delivery-analytics/notifications/1',
      '/delivery-analytics/mail/1'
    ]
    for (const url of urls) {
      const r = await app.inject({ method: 'GET', url })
      expect(r.statusCode, url).toBe(403)
    }
    expect(mailLeaf).not.toHaveBeenCalled()
    expect(logActivity).not.toHaveBeenCalled()
  })

  it('logs an administrator opening an email body', async () => {
    mailLeaf.mockResolvedValue({ id: 7, subject: 'Hello', to: 'a@b.com', body: '<p>hi</p>' })
    const app = await build()
    const r = await app.inject({ method: 'GET', url: '/delivery-analytics/mail/7' })
    expect(r.statusCode).toBe(200)
    expect(r.json().data.body).toBe('<p>hi</p>')
    expect(logActivity).toHaveBeenCalledTimes(1)
    expect(logActivity.mock.calls[0]?.[0]).toMatchObject({
      action: 'delivery-analytics-drill',
      collection: 'nivaro_mail_log',
      item: '7',
      user: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'
    })
  })

  it('does not log a row with no stored body, and 404s a missing one', async () => {
    mailLeaf.mockResolvedValueOnce({ id: 8, subject: 'x', to: 'a@b.com', body: null })
    mailLeaf.mockResolvedValueOnce(null)
    const app = await build()
    expect(
      (await app.inject({ method: 'GET', url: '/delivery-analytics/mail/8' })).statusCode
    ).toBe(200)
    expect(
      (await app.inject({ method: 'GET', url: '/delivery-analytics/mail/9' })).statusCode
    ).toBe(404)
    expect(logActivity).not.toHaveBeenCalled()
  })

  it('opens a notification leaf with the acted window asked for', async () => {
    notificationLeaf.mockResolvedValue({ id: 3 })
    const app = await build()
    const r = await app.inject({
      method: 'GET',
      url: '/delivery-analytics/notifications/3?acted_hours=72&asof=2026-11-10T00:00:00.000Z'
    })
    expect(r.statusCode).toBe(200)
    expect(notificationLeaf.mock.calls[0]?.[1]).toBe(3)
    expect(notificationLeaf.mock.calls[0]?.[2]).toMatchObject({ ctx: { actedHours: 72 } })
    // the drill's asof travels to the leaf's verdict
    expect(notificationLeaf.mock.calls[0]?.[2].ctx.asof.toISOString()).toBe(
      '2026-11-10T00:00:00.000Z'
    )
    expect(logActivity).not.toHaveBeenCalled()
  })

  it('rejects bad drills before touching the database', async () => {
    const app = await build()
    const bad = [
      '/delivery-analytics/rows?source=q&from=2026-11-01&to=2026-11-02',
      '/delivery-analytics/rows?source=n&from=nope&to=2026-11-02',
      '/delivery-analytics/rows?source=n&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&w=nope:1',
      '/delivery-analytics/split?source=n&by=timed&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z',
      '/delivery-analytics/breakdown?by=subject',
      '/delivery-analytics/notifications/abc'
    ]
    for (const url of bad) {
      const r = await app.inject({ method: 'GET', url })
      expect(r.statusCode, url).toBe(400)
    }
  })
})

describe('delivery analytics routes — review fixes', () => {
  it('asof never runs past now', () => {
    const now = new Date('2026-11-18T12:00:00.000Z')
    const past = new Date('2026-11-10T00:00:00.000Z')
    expect(asofFor(past, now)).toBe(past)
    expect(asofFor(new Date('2026-11-19T00:00:00.000Z'), now)).toBe(now)
  })

  it('an email quoting a private chat opens only on reveal, logged as chat-admin-read', async () => {
    mailLeaf.mockResolvedValueOnce({
      id: 5,
      to: 'a@b.com',
      body: null,
      body_withheld: true,
      private_chat: true
    })
    mailLeaf.mockResolvedValueOnce({ id: 5, to: 'a@b.com', body: '<p>x</p>', private_chat: true })
    const app = await build()
    const a = await app.inject({ method: 'GET', url: '/delivery-analytics/mail/5' })
    expect(a.json().data.body).toBeNull()
    expect(mailLeaf.mock.calls[0]?.[2]).toEqual({ reveal: false })
    expect(logActivity).not.toHaveBeenCalled()
    await app.inject({ method: 'GET', url: '/delivery-analytics/mail/5?reveal=1' })
    expect(mailLeaf.mock.calls[1]?.[2]).toEqual({ reveal: true })
    expect(logActivity).toHaveBeenCalledTimes(1)
    expect(logActivity.mock.calls[0]?.[0]).toMatchObject({ action: 'chat-admin-read', item: '5' })
  })

  it('refuses a drill span over a year', async () => {
    const app = await build()
    const r = await app.inject({
      method: 'GET',
      url: '/delivery-analytics/rows?source=n&from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z'
    })
    expect(r.statusCode).toBe(400)
  })

  it('CSV: one keyset pass, no COUNT, ISO dates, formula-safe cells, its own statement timeout', async () => {
    const at = new Date('2026-11-17T10:30:00.123Z')
    runLongQuery.mockResolvedValueOnce([
      { id: 9, created_at: at, to: '=cmd', subject: 'Hi', status: 'sent', error: null }
    ])
    const app = await build()
    const r = await app.inject({
      method: 'GET',
      url: '/delivery-analytics/rows?source=m&from=2026-11-11T00:00:00Z&to=2026-11-18T00:00:00Z&format=csv'
    })
    expect(r.statusCode).toBe(200)
    expect(r.body).toContain('"2026-11-17T10:30:00.123Z"')
    expect(r.body).toContain(`"'=cmd"`)
    const sqls = runLongQuery.mock.calls.map((c) => c[0])
    expect(sqls.some((q) => /COUNT\(\*\)/.test(q))).toBe(false)
    expect(sqls.every((q) => !/OFFSET/.test(q))).toBe(true)
    expect(runLongQuery.mock.calls[0]?.[2]).toEqual({ timeoutMs: 60_000 })
    expect(logActivity.mock.calls[0]?.[0]).toMatchObject({ action: 'delivery-analytics-export' })
  })
})
