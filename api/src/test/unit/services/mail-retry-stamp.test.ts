import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Migration 536: a failed ORIGINAL send whose mail-server error is temporary is logged with its
// first automatic retry (retry_at ≈ now + 1 min, retry_count 0). Permanent errors, resends, test
// sends that opt out, MAIL_RETRY=off and a database behind 536 never get one. No real mail is
// sent: nodemailer is mocked.

const inserts = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const columns = vi.hoisted(() => ({ present: true }))
const smtp = vi.hoisted(() => ({ error: null as Error | null }))
vi.hoisted(() => {
  process.env.SMTP_HOST = 'relay.example.test'
  process.env.SMTP_PORT = '25'
  for (const k of [
    'SMTP_USER',
    'SMTP_PASSWORD',
    'NIVARO_SETTINGS_OVERRIDES',
    'MAIL_TEST_MODE',
    'MAIL_TEST_RECIPIENT',
    'MAIL_CATCH_HOST',
    'MAIL_CATCH_PORT',
    'CLOUD_META_DB_URL'
  ])
    process.env[k] = ''
})
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async () => {
        if (smtp.error) throw smtp.error
      }
    })
  }
}))
vi.mock('../../../db/index.js', () => ({
  db: Object.assign(
    vi.fn((table: string) => {
      if (table === 'nivaro_mail_log')
        return {
          insert: (row: Record<string, unknown>) => {
            inserts.push(row)
            return { returning: async () => [{ id: 900 + inserts.length }] }
          }
        }
      if (table !== 'nivaro_settings') throw new Error('no db in test')
      const q = { select: () => q, orderBy: () => q, first: async () => ({}) }
      return q
    }),
    {
      raw: vi.fn(),
      schema: { hasColumn: vi.fn(async () => columns.present) }
    }
  )
}))
vi.mock('../../../services/mail-suppressions.js', () => ({
  filterSuppressed: async (to: string[]) => ({ kept: to, dropped: [] }),
  recordBouncesFromError: async () => undefined
}))

import { sendRawMail } from '../../../services/mail.js'
import { resetResendColumnProbe } from '../../../services/mail-resends.js'
import { resetRetryColumnProbe } from '../../../services/mail-retry-state.js'

const temporary = () =>
  Object.assign(new Error('Data command failed: 451 4.3.0 try again later'), {
    code: 'EENVELOPE',
    responseCode: 451,
    response: '451 4.3.0 try again later'
  })
const permanent = () =>
  Object.assign(new Error('Can’t send mail: 550 5.1.1 no such user'), {
    code: 'EENVELOPE',
    responseCode: 550,
    response: '550 5.1.1 no such user'
  })

const send = (extra: Record<string, unknown> = {}) =>
  sendRawMail({ to: 'x@y.com', subject: 'Invoice', html: '<p>x</p>', skipDigest: true, ...extra })

beforeEach(() => {
  inserts.length = 0
  columns.present = true
  smtp.error = null
  delete process.env.MAIL_RETRY
  resetResendColumnProbe()
  resetRetryColumnProbe()
})
afterEach(() => {
  delete process.env.MAIL_RETRY
})

describe('a failed send is stamped for an automatic retry', () => {
  it('temporary error → retry_at about a minute out, retry_count 0', async () => {
    smtp.error = temporary()
    const before = Date.now()
    await expect(send()).rejects.toThrow()
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({ status: 'failed', retry_count: 0 })
    const at = (inserts[0].retry_at as Date).getTime()
    expect(at).toBeGreaterThanOrEqual(before + 60_000)
    expect(at).toBeLessThan(before + 65_000)
  })

  it('permanent error → no retry', async () => {
    smtp.error = permanent()
    await expect(send()).rejects.toThrow()
    expect('retry_at' in inserts[0]).toBe(false)
  })

  it('a resend that fails is never stamped (the runner moves the ORIGINAL along)', async () => {
    smtp.error = temporary()
    await expect(send({ resendOf: 12, resentBy: null })).rejects.toThrow()
    expect('retry_at' in inserts[0]).toBe(false)
  })

  it('autoRetry: false (notifications, test sends) → no retry', async () => {
    smtp.error = temporary()
    await expect(send({ autoRetry: false })).rejects.toThrow()
    expect('retry_at' in inserts[0]).toBe(false)
  })

  it('MAIL_RETRY=off → no retry', async () => {
    process.env.MAIL_RETRY = 'off'
    smtp.error = temporary()
    await expect(send()).rejects.toThrow()
    expect('retry_at' in inserts[0]).toBe(false)
  })

  it('before migration 536 the failed row is still written, without the columns', async () => {
    columns.present = false
    smtp.error = temporary()
    await expect(send()).rejects.toThrow()
    expect(inserts).toHaveLength(1)
    expect(inserts[0].status).toBe('failed')
    expect('retry_at' in inserts[0]).toBe(false)
    expect('retry_count' in inserts[0]).toBe(false)
  })

  it('a sent row never carries the columns', async () => {
    await send()
    expect(inserts[0].status).toBe('sent')
    expect('retry_at' in inserts[0]).toBe(false)
  })
})
