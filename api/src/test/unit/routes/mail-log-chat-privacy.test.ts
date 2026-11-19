import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Review 2026-11-18: an email that quotes a DM / private channel (chat mention, unread-DM email,
// logged with collection '__chat__') opens in the Mail log only on an explicit, logged
// compliance view — like the chat admin reader.

const state = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  rows: [] as Array<Record<string, unknown>>,
  total: 0,
  calls: [] as Array<[string, unknown[]]>
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
          if (prop === 'first')
            return async () =>
              state.calls.some(([m]) => m === 'count') ? { c: state.total } : state.row
          return (...args: unknown[]) => {
            state.calls.push([prop, args])
            return q
          }
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
  resendsOf: vi.fn(async () => []),
  deliveredAfter: vi.fn(async () => null)
}))

import { mailLogRoutes } from '../../../routes/mail-log.js'
import { logActivity } from '../../../services/activity.js'

function app() {
  const a = Fastify({ logger: false })
  a.register(mailLogRoutes, { prefix: '/mail-log' })
  return a
}

afterEach(() => {
  vi.clearAllMocks()
  state.row = undefined
  state.rows = []
  state.total = 0
  state.calls = []
})

const chatMail = {
  id: 77,
  to: 'a@b.com',
  subject: 'Pat sent you a message',
  status: 'sent',
  template: 'chat_dm_fallback',
  collection: '__chat__',
  item: 'dm:1:2',
  body: '<p>the private text</p>',
  resend_of: null
}

describe('mail log — emails quoting a private chat', () => {
  it('withholds the body and logs nothing without reveal', async () => {
    state.row = chatMail
    const r = await app().inject({ method: 'GET', url: '/mail-log/77' })
    expect(r.statusCode).toBe(200)
    const d = r.json().data
    expect(d.body).toBeNull()
    expect(d.body_withheld).toBe(true)
    expect(d.private_chat).toBe(true)
    expect(JSON.stringify(d)).not.toContain('the private text')
    expect(logActivity).not.toHaveBeenCalled()
  })

  it('shows it on reveal=1 and writes a chat-admin-read row', async () => {
    state.row = chatMail
    const r = await app().inject({ method: 'GET', url: '/mail-log/77?reveal=1' })
    expect(r.json().data.body).toBe('<p>the private text</p>')
    expect(r.json().data.body_withheld).toBe(false)
    expect(vi.mocked(logActivity).mock.calls[0]?.[0]).toMatchObject({
      action: 'chat-admin-read',
      collection: 'nivaro_mail_log',
      item: '77',
      user: 'u-admin'
    })
  })

  it('leaves every other email as it was', async () => {
    state.row = { ...chatMail, collection: 'workflows', template: 'workflow_transition' }
    const r = await app().inject({ method: 'GET', url: '/mail-log/77' })
    expect(r.json().data.body).toBe('<p>the private text</p>')
    expect(r.json().data.body_withheld).toBe(false)
    expect(logActivity).not.toHaveBeenCalled()
  })
})
