import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Migration 536: a failed ORIGINAL send that OPTED IN (autoRetry: true) and whose mail-server
// error is temporary is logged with its first automatic retry (retry_at ≈ now + 1 min,
// retry_count 0). No opt-in, permanent errors, resends, test-mode diversions, attachments, a text
// alternative, an over-long body or recipient list, MAIL_RETRY=off and a database behind 536 never
// get one. No real mail is sent: nodemailer is mocked.

const inserts = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const columns = vi.hoisted(() => ({ present: true }))
const smtp = vi.hoisted(() => ({
  error: null as Error | null,
  catchError: null as Error | null,
  transports: [] as Array<Record<string, unknown>>
}))
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
    createTransport: (o: Record<string, unknown>) => {
      smtp.transports.push(o)
      return {
        sendMail: async () => {
          if (o.host === 'catch.test' && smtp.catchError) throw smtp.catchError
          if (o.host !== 'catch.test' && smtp.error) throw smtp.error
        }
      }
    }
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

import { SMTP_TIMEOUTS, sendRawMail } from '../../../services/mail.js'
import { resetResendColumnProbe } from '../../../services/mail-resends.js'
import { SEND_LOCK_TTL_S } from '../../../services/mail-retry.js'
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
  sendRawMail({
    to: 'x@y.com',
    subject: 'Invoice',
    html: '<p>x</p>',
    skipDigest: true,
    autoRetry: true,
    ...extra
  })

beforeEach(() => {
  inserts.length = 0
  columns.present = true
  smtp.error = null
  smtp.catchError = null
  smtp.transports.length = 0
  delete process.env.MAIL_RETRY
  process.env.MAIL_TEST_MODE = ''
  process.env.MAIL_CATCH_HOST = ''
  resetResendColumnProbe()
  resetRetryColumnProbe()
})
afterEach(() => {
  delete process.env.MAIL_RETRY
  process.env.MAIL_TEST_MODE = ''
  process.env.MAIL_CATCH_HOST = ''
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

  it('no opt-in (the default) → no retry', async () => {
    smtp.error = temporary()
    await expect(send({ autoRetry: undefined })).rejects.toThrow()
    expect('retry_at' in inserts[0]).toBe(false)
  })

  it('a send diverted to the catch inbox by test mode is never stamped', async () => {
    process.env.MAIL_TEST_MODE = 'true'
    process.env.MAIL_CATCH_HOST = 'catch.test'
    smtp.catchError = temporary()
    await expect(send()).rejects.toThrow()
    expect(inserts).toHaveLength(1)
    expect(inserts[0].status).toBe('failed')
    expect('retry_at' in inserts[0]).toBe(false)
  })

  it('attachments or a text alternative (not stored) → no retry', async () => {
    smtp.error = temporary()
    await expect(
      send({ attachments: [{ filename: 'a.pdf', content: Buffer.from('x') }] })
    ).rejects.toThrow()
    await expect(send({ text: 'plain copy' })).rejects.toThrow()
    expect(inserts).toHaveLength(2)
    for (const r of inserts) expect('retry_at' in r).toBe(false)
  })

  it('a body over the stored 200,000 characters or recipients over 1,000 → no retry', async () => {
    smtp.error = temporary()
    await expect(send({ html: `<html>${'x'.repeat(200_001)}</html>` })).rejects.toThrow()
    const many = Array.from({ length: 60 }, (_, i) => `person${i}@example-company.test`)
    await expect(send({ to: many })).rejects.toThrow()
    expect(inserts).toHaveLength(2)
    for (const r of inserts) expect('retry_at' in r).toBe(false)
  })

  it('the SMTP transport has bounded time limits (below the send lock)', async () => {
    await send()
    expect(smtp.transports[0]).toMatchObject({
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 60_000
    })
    const sum =
      SMTP_TIMEOUTS.connectionTimeout + SMTP_TIMEOUTS.greetingTimeout + SMTP_TIMEOUTS.socketTimeout
    // The per-original send lock clearly outlives one send.
    expect(SEND_LOCK_TTL_S * 1000).toBeGreaterThanOrEqual(4 * sum)
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
