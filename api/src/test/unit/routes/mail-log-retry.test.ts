import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Migration 536: a person's Resend takes over from a pending automatic retry (it is cleared
// before the send), and while an automatic retry is sending the same email the Resend answers
// 409 MAIL_SENDING_NOW instead of sending it a second time. List + detail rows carry retry_at.

const state = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  rows: [] as Array<Record<string, unknown>>
}))

vi.mock('../../../middleware/authenticate.js', () => {
  const sign = vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'u-admin', role: 'admin' }
    req.isAdmin = true
  })
  return { authenticate: sign, requireAuth: sign, requireAdmin: sign }
})
vi.mock('../../../db/index.js', () => {
  const builder = (): Record<string, unknown> => {
    const q: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then')
            return (ok: (r: unknown) => unknown, fail?: (e: unknown) => unknown) =>
              Promise.resolve(state.rows).then(ok, fail)
          if (prop === 'first') return async () => (state.row ? state.row : { c: 1 })
          return () => q
        }
      }
    )
    return q
  }
  return {
    db: Object.assign(
      vi.fn(() => builder()),
      { raw: vi.fn((s: string) => s) }
    )
  }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: vi.fn() }))
vi.mock('../../../services/mail.js', () => ({ sendRawMail: vi.fn() }))
vi.mock('../../../services/mail-resends.js', () => ({
  hasResendColumns: vi.fn(async () => true),
  resendSummaries: vi.fn(async () => new Map()),
  resendsOf: vi.fn(async () => [])
}))
vi.mock('../../../services/mail-retry-state.js', () => ({
  hasRetryColumns: vi.fn(async () => true),
  mailRetryEnabled: vi.fn(() => true),
  clearPendingRetry: vi.fn(async () => undefined)
}))

import { mailLogRoutes } from '../../../routes/mail-log.js'
import { sendRawMail } from '../../../services/mail.js'
import { clearPendingRetry } from '../../../services/mail-retry-state.js'

const held = new Set<string>()
const redis = {
  set: vi.fn(async (k: string) => {
    if (held.has(k)) return null
    held.add(k)
    return 'OK'
  }),
  del: vi.fn(async (k: string) => held.delete(k))
}

function app() {
  const a = Fastify({ logger: false })
  a.decorate('redis', redis as never)
  a.register(mailLogRoutes, { prefix: '/mail-log' })
  return a
}

afterEach(() => {
  vi.clearAllMocks()
  held.clear()
  state.row = undefined
  state.rows = []
})

const original = {
  id: 12,
  to: 'x@y.com',
  subject: 'Invoice',
  template: 'workflow_transition',
  status: 'failed',
  error: '421 try later',
  body: '<html>x</html>',
  resend_of: null,
  retry_at: new Date('2026-11-18T21:15:00Z'),
  retry_count: 1
}

describe('Resend vs automatic retry', () => {
  it('a manual Resend clears the pending retry before it sends', async () => {
    state.row = original
    const order: string[] = []
    vi.mocked(clearPendingRetry).mockImplementation(async () => {
      order.push('clear')
    })
    vi.mocked(sendRawMail).mockImplementation(async () => {
      order.push('send')
      return { status: 'sent', log_id: 40 }
    })
    const res = await app().inject({ method: 'POST', url: '/mail-log/12/resend' })
    expect(res.statusCode).toBe(200)
    expect(clearPendingRetry).toHaveBeenCalledWith(12)
    expect(order).toEqual(['clear', 'send'])
    expect(vi.mocked(sendRawMail).mock.calls[0][0]).toMatchObject({
      resendOf: 12,
      resentBy: 'u-admin'
    })
    // The lock is let go afterwards.
    expect(held.size).toBe(0)
  })

  it('a Resend of a resend clears the ORIGINAL’s retry', async () => {
    state.row = { ...original, id: 40, resend_of: 12 }
    vi.mocked(sendRawMail).mockResolvedValue({ status: 'sent', log_id: 41 })
    await app().inject({ method: 'POST', url: '/mail-log/40/resend' })
    expect(clearPendingRetry).toHaveBeenCalledWith(12)
  })

  it('while an automatic retry is sending it, Resend answers 409 and sends nothing', async () => {
    state.row = original
    held.add('nvr:mail-send:-:12')
    const res = await app().inject({ method: 'POST', url: '/mail-log/12/resend' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('MAIL_SENDING_NOW')
    expect(sendRawMail).not.toHaveBeenCalled()
    expect(clearPendingRetry).not.toHaveBeenCalled()
  })

  it('a failed Resend still lets the lock go', async () => {
    state.row = original
    vi.mocked(sendRawMail).mockRejectedValue(new Error('550 nope'))
    const res = await app().inject({ method: 'POST', url: '/mail-log/12/resend' })
    expect(res.statusCode).toBe(502)
    expect(held.size).toBe(0)
  })
})

describe('retry state on the rows', () => {
  it('the detail answers retry_at as ISO and retry_count', async () => {
    state.row = original
    const res = await app().inject({ method: 'GET', url: '/mail-log/12' })
    expect(res.json().data).toMatchObject({
      retry_at: '2026-11-18T21:15:00.000Z',
      retry_count: 1
    })
  })

  it('list rows carry retry_at / retry_count', async () => {
    state.rows = [{ ...original }, { ...original, id: 13, retry_at: null, retry_count: null }]
    const res = await app().inject({ method: 'GET', url: '/mail-log' })
    const data = res.json().data
    expect(data[0]).toMatchObject({ retry_at: '2026-11-18T21:15:00.000Z', retry_count: 1 })
    expect(data[1]).toMatchObject({ retry_at: null, retry_count: null })
  })
})
