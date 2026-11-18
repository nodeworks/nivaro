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
  notificationLeaf: (...a: unknown[]) => notificationLeaf(...a)
}))

import { deliveryAnalyticsRoutes } from './delivery-analytics.js'

async function build() {
  const app = Fastify()
  await app.register(deliveryAnalyticsRoutes, { prefix: '/delivery-analytics' })
  await app.ready()
  return app
}

beforeEach(() => {
  admin = true
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
      url: '/delivery-analytics/notifications/3?acted_hours=72'
    })
    expect(r.statusCode).toBe(200)
    expect(notificationLeaf.mock.calls[0]?.[1]).toBe(3)
    expect(notificationLeaf.mock.calls[0]?.[2]).toBe(72)
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
