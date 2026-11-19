import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Rob 2026-11-18: "when I resend an email we should show that in the log so I know it's been
// resent and the status of it". The resend route links the new row to the original, answers
// with the new row's status, and a failed resend answers 502 with a code — raw SMTP text only
// in `detail`. The list carries each original's resend summary; ?resent=1 narrows to them.

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
import { sendRawMail } from '../../../services/mail.js'
import {
  deliveredAfter,
  hasResendColumns,
  resendSummaries,
  resendsOf
} from '../../../services/mail-resends.js'

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

const original = {
  id: 12,
  to: 'x@y.com',
  subject: 'Invoice',
  template: 'workflow_transition',
  collection: 'workflows',
  item: '77',
  status: 'failed',
  error: '550 relay denied',
  body: '<html>x</html>',
  resend_of: null
}

describe('POST /mail-log/:id/resend', () => {
  it('links the new row to the original and answers its status', async () => {
    state.row = original
    vi.mocked(sendRawMail).mockResolvedValue({ status: 'sent', log_id: 40 })
    const res = await app().inject({ method: 'POST', url: '/mail-log/12/resend' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ resent: true, resend_of: 12, log_id: 40, status: 'sent' })
    expect(sendRawMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'x@y.com',
        resendOf: 12,
        resentBy: 'u-admin',
        template: 'workflow_transition',
        collection: 'workflows',
        item: '77',
        wrap: false,
        skipDigest: true
      })
    )
  })

  it('a resend of a resend points at the same original', async () => {
    state.row = { ...original, id: 40, resend_of: 12 }
    vi.mocked(sendRawMail).mockResolvedValue({ status: 'sent', log_id: 41 })
    const res = await app().inject({ method: 'POST', url: '/mail-log/40/resend' })
    expect(res.json().data.resend_of).toBe(12)
    expect(vi.mocked(sendRawMail).mock.calls[0][0].resendOf).toBe(12)
  })

  it('test mode: answers the dropped status of the new row', async () => {
    state.row = original
    vi.mocked(sendRawMail).mockResolvedValue({ status: 'dropped', log_id: 42 })
    const res = await app().inject({ method: 'POST', url: '/mail-log/12/resend' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({ status: 'dropped', log_id: 42 })
  })

  it('a failed resend answers 502 with a code; the raw SMTP text is only in detail', async () => {
    state.row = original
    vi.mocked(sendRawMail).mockRejectedValue(
      Object.assign(new Error('550 5.7.1 relay denied for <x@y.com>'), { mailLogId: 43 })
    )
    const res = await app().inject({ method: 'POST', url: '/mail-log/12/resend' })
    expect(res.statusCode).toBe(502)
    const body = res.json()
    expect(body.code).toBe('RESEND_FAILED')
    expect(body.error).not.toMatch(/550|relay/)
    expect(body.detail).toContain('550 5.7.1 relay denied')
    expect(body.data).toEqual({ resent: false, resend_of: 12, log_id: 43, status: 'failed' })
  })

  it('no SMTP host → 503 MAIL_UNCONFIGURED, not "resent"', async () => {
    state.row = original
    vi.mocked(sendRawMail).mockResolvedValue({ status: 'unconfigured', log_id: null })
    const res = await app().inject({ method: 'POST', url: '/mail-log/12/resend' })
    expect(res.statusCode).toBe(503)
    expect(res.json().code).toBe('MAIL_UNCONFIGURED')
  })

  it('a row without a stored body cannot be resent', async () => {
    state.row = { ...original, body: null }
    const res = await app().inject({ method: 'POST', url: '/mail-log/12/resend' })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('NO_STORED_BODY')
    expect(sendRawMail).not.toHaveBeenCalled()
  })

  it('before migration 534 (no resend_of on the row) the row itself is the original', async () => {
    const { resend_of: _drop, ...old } = original
    state.row = old
    vi.mocked(sendRawMail).mockResolvedValue({ status: 'sent', log_id: 44 })
    const res = await app().inject({ method: 'POST', url: '/mail-log/12/resend' })
    expect(res.json().data.resend_of).toBe(12)
  })
})

describe('POST /mail-log/:id/resend — already delivered since the person looked', () => {
  // Realtime safety 2026-11-18: an automatic retry (or another admin) delivered the email while
  // the detail panel showed it failed; Resend must not send it a second time unasked.
  const retryDelivery = {
    id: 51,
    at: '2026-11-18T19:05:00.000Z',
    how: 'automatic' as const,
    by: null,
    by_name: null
  }

  it('refuses 409 ALREADY_DELIVERED with when/how it went out, and sends nothing', async () => {
    state.row = original
    vi.mocked(deliveredAfter).mockResolvedValueOnce(retryDelivery)
    const res = await app().inject({
      method: 'POST',
      url: '/mail-log/12/resend',
      payload: { seen_last_id: 12 }
    })
    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.code).toBe('ALREADY_DELIVERED')
    expect(body.hint).toMatch(/automatic retry/)
    expect(body.data).toEqual({ delivered: retryDelivery, resend_of: 12 })
    expect(deliveredAfter).toHaveBeenCalledWith(12, 12)
    expect(sendRawMail).not.toHaveBeenCalled()
  })

  it('judges against the newest row the person saw, on the ORIGINAL of a resend row', async () => {
    state.row = { ...original, id: 40, resend_of: 12 }
    vi.mocked(sendRawMail).mockResolvedValue({ status: 'sent', log_id: 52 })
    await app().inject({
      method: 'POST',
      url: '/mail-log/40/resend',
      payload: { seen_last_id: 47 }
    })
    expect(deliveredAfter).toHaveBeenCalledWith(12, 47)
    expect(sendRawMail).toHaveBeenCalledTimes(1)
  })

  it('an older page that sends no seen id is judged from the row it resends', async () => {
    state.row = original
    vi.mocked(sendRawMail).mockResolvedValue({ status: 'sent', log_id: 53 })
    await app().inject({ method: 'POST', url: '/mail-log/12/resend' })
    expect(deliveredAfter).toHaveBeenCalledWith(12, 12)
  })

  it('names the person who resent it', async () => {
    state.row = original
    vi.mocked(deliveredAfter).mockResolvedValueOnce({
      ...retryDelivery,
      how: 'resend',
      by: 'u-ann',
      by_name: 'Ann Lee'
    })
    const res = await app().inject({ method: 'POST', url: '/mail-log/12/resend', payload: {} })
    expect(res.json().hint).toMatch(/^Ann Lee resent it/)
  })

  it('force: true ("Send again anyway") skips the check and sends', async () => {
    state.row = original
    vi.mocked(deliveredAfter).mockResolvedValue(retryDelivery)
    vi.mocked(sendRawMail).mockResolvedValue({ status: 'sent', log_id: 54 })
    const res = await app().inject({
      method: 'POST',
      url: '/mail-log/12/resend',
      payload: { seen_last_id: 12, force: true }
    })
    expect(res.statusCode).toBe(200)
    expect(deliveredAfter).not.toHaveBeenCalled()
    expect(sendRawMail).toHaveBeenCalledTimes(1)
    vi.mocked(deliveredAfter).mockResolvedValue(null)
  })

  it('a truthy but non-boolean force is not a confirmation', async () => {
    state.row = original
    vi.mocked(deliveredAfter).mockResolvedValueOnce(retryDelivery)
    const res = await app().inject({
      method: 'POST',
      url: '/mail-log/12/resend',
      payload: { force: 'yes' }
    })
    expect(res.statusCode).toBe(409)
  })
})

describe('GET /mail-log', () => {
  it('each original carries its resend summary from one batched read', async () => {
    state.rows = [
      { id: 50, status: 'sent', resend_of: 12 },
      { id: 12, status: 'failed', resend_of: null },
      { id: 11, status: 'sent', resend_of: null }
    ]
    state.total = 3
    const summary = {
      count: 2,
      last_status: 'sent',
      last_at: '2026-11-18T19:00:00.000Z',
      last_by: 'u-admin',
      last_by_name: 'Rob Lee'
    }
    vi.mocked(resendSummaries).mockResolvedValue(new Map([[12, summary]]))
    const res = await app().inject({ method: 'GET', url: '/mail-log' })
    expect(res.statusCode).toBe(200)
    // Only originals are asked about, once.
    expect(resendSummaries).toHaveBeenCalledTimes(1)
    expect(resendSummaries).toHaveBeenCalledWith([12, 11])
    const rows = res.json().data
    expect(rows[0]).toMatchObject({ id: 50, resend_of: 12, resends: null })
    expect(rows[1]).toMatchObject({ id: 12, resend_of: null, resends: summary })
    expect(rows[2]).toMatchObject({ id: 11, resends: null })
    expect(state.calls.find(([m]) => m === 'select')?.[1][0]).toContain('resend_of')
  })

  it('?resent=1 narrows to originals with a resend (EXISTS on resend_of)', async () => {
    await app().inject({ method: 'GET', url: '/mail-log?resent=1' })
    expect(state.calls.filter(([m]) => m === 'whereExists')).toHaveLength(2) // list + count
  })

  it('before migration 534: no resend_of column read, no summaries, ?resent=1 matches nothing', async () => {
    vi.mocked(hasResendColumns).mockResolvedValue(false)
    state.rows = [{ id: 12, status: 'failed' }]
    const res = await app().inject({ method: 'GET', url: '/mail-log?resent=1' })
    expect(res.statusCode).toBe(200)
    expect(resendSummaries).not.toHaveBeenCalled()
    expect(state.calls.find(([m]) => m === 'select')?.[1][0]).not.toContain('resend_of')
    expect(state.calls.filter(([m]) => m === 'whereRaw').map(([, a]) => a[0])).toContain('1 = 0')
    expect(res.json().data[0]).toMatchObject({ id: 12, resend_of: null, resends: null })
  })
})

describe('GET /mail-log/:id', () => {
  it('an original lists its resends; a resend does not ask', async () => {
    vi.mocked(resendsOf).mockResolvedValue([
      {
        id: 50,
        status: 'sent',
        error: null,
        created_at: '2026-11-18T19:00:00.000Z',
        resent_by: 'u-admin',
        resent_by_name: 'Rob Lee'
      }
    ])
    state.row = original
    const res = await app().inject({ method: 'GET', url: '/mail-log/12' })
    expect(res.json().data.resends).toHaveLength(1)
    expect(resendsOf).toHaveBeenCalledWith(12)

    vi.mocked(resendsOf).mockClear()
    state.row = { ...original, id: 50, resend_of: 12 }
    const res2 = await app().inject({ method: 'GET', url: '/mail-log/50' })
    expect(res2.json().data).toMatchObject({ resend_of: 12, resends: [] })
    expect(resendsOf).not.toHaveBeenCalled()
  })
})
