import { beforeEach, describe, expect, it, vi } from 'vitest'

// Migration 534: a resend's mail-log rows name the original (resend_of) and who pressed
// Resend (resent_by) — including the FAILED attempt, whose row id rides the thrown error.
// A database behind 534 keeps logging, just without the two columns.

const inserts = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const columns = vi.hoisted(() => ({ present: true }))
const smtpFails = vi.hoisted(() => ({ value: false }))
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
    'MAIL_CATCH_PORT'
  ])
    process.env[k] = ''
})
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async () => {
        if (smtpFails.value) throw new Error('550 5.7.1 relay denied for <x@y.com>')
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

beforeEach(() => {
  inserts.length = 0
  columns.present = true
  smtpFails.value = false
  resetResendColumnProbe()
})

const resend = {
  to: 'x@y.com',
  subject: 'Invoice',
  html: '<html><body>x</body></html>',
  wrap: false,
  skipDigest: true,
  resendOf: 12,
  resentBy: 'u-admin'
}

describe('sendRawMail as a resend', () => {
  it('the sent row names the original and who resent it', async () => {
    const r = await sendRawMail(resend)
    expect(r.status).toBe('sent')
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({ status: 'sent', resend_of: 12, resent_by: 'u-admin' })
  })

  it('a failed resend still writes its row (with the link) and the error carries its id', async () => {
    smtpFails.value = true
    const err = await sendRawMail(resend).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({ status: 'failed', resend_of: 12, resent_by: 'u-admin' })
    expect((err as { mailLogId?: number }).mailLogId).toBe(901)
  })

  it('before migration 534 the row is still written, without the two columns', async () => {
    columns.present = false
    await sendRawMail(resend)
    expect(inserts).toHaveLength(1)
    expect(inserts[0].status).toBe('sent')
    expect('resend_of' in inserts[0]).toBe(false)
    expect('resent_by' in inserts[0]).toBe(false)
  })

  it('an ordinary send never carries the columns', async () => {
    await sendRawMail({ to: 'x@y.com', subject: 'Hi', html: '<p>x</p>' })
    expect(inserts).toHaveLength(1)
    expect('resend_of' in inserts[0]).toBe(false)
  })
})
