import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Every send is recorded with the host it went to; no database (each read fails open).
const sent = vi.hoisted(() => [] as Array<Record<string, unknown> & { host: string }>)
const failHost = vi.hoisted(() => ({ value: null as string | null }))
// Set before config.ts loads .env (dotenv never overrides), so a developer's .env cannot leak in.
vi.hoisted(() => {
  process.env.SMTP_HOST = 'relay.example.test'
  process.env.SMTP_PORT = '25'
  for (const k of ['SMTP_USER', 'SMTP_PASSWORD', 'NIVARO_SETTINGS_OVERRIDES', 'MAIL_TEST_MODE', 'MAIL_TEST_RECIPIENT', 'MAIL_CATCH_HOST', 'MAIL_CATCH_PORT'])
    process.env[k] = ''
})
// The settings row's test allowlist; every other table read fails open.
const allowlist = vi.hoisted(() => ({ value: '' }))
vi.mock('nodemailer', () => ({
  default: {
    createTransport: (o: { host: string }) => ({
      sendMail: async (m: Record<string, unknown>) => {
        if (o.host === failHost.value) throw new Error(`connect ECONNREFUSED ${o.host}`)
        sent.push({ host: o.host, ...m })
      }
    })
  }
}))
vi.mock('../../../db/index.js', () => ({
  db: Object.assign(
    vi.fn((table: string) => {
      if (table !== 'nivaro_settings') throw new Error('no db in test')
      const q = {
        select: () => q,
        orderBy: () => q,
        first: async () => ({ mail_test_allowlist: allowlist.value })
      }
      return q
    }),
    { raw: vi.fn() }
  )
}))
vi.mock('../../../services/mail-suppressions.js', () => ({
  filterSuppressed: async (to: string[]) => ({ kept: to, dropped: [] }),
  recordBouncesFromError: async () => undefined
}))

import { applyMailTestMode, sendRawMail } from '../../../services/mail.js'

const ENV = ['MAIL_TEST_MODE', 'MAIL_TEST_RECIPIENT', 'MAIL_CATCH_HOST', 'MAIL_CATCH_PORT']
beforeEach(() => {
  sent.length = 0
  failHost.value = null
  allowlist.value = ''
})
afterEach(() => {
  for (const k of ENV) process.env[k] = ''
})

describe('applyMailTestMode with a catch host', () => {
  const base = { testMode: true, testRecipient: 'qa@example.com', testAllowlist: ['@nivaro.dev'] }

  it('keeps allowlisted recipients and catches the rest unchanged, never redirecting or dropping', () => {
    expect(
      applyMailTestMode({ ...base, catchHost: 'mailpit' }, ['ana@nivaro.dev', 'cust@acme.com'], 'Hi')
    ).toEqual({ to: ['ana@nivaro.dev'], subject: 'Hi', redirected: [], caught: ['cust@acme.com'] })
    expect(
      applyMailTestMode({ ...base, testRecipient: null, catchHost: 'mailpit' }, 'cust@acme.com', 'Hi')
    ).toEqual({ to: [], subject: 'Hi', redirected: [], caught: ['cust@acme.com'] })
  })

  it('without a catch host, test mode redirects as before; with test mode off nothing is caught', () => {
    expect(applyMailTestMode(base, ['cust@acme.com'], 'Hi')).toEqual({
      to: ['qa@example.com'],
      subject: '[TEST — was: cust@acme.com] Hi',
      redirected: ['cust@acme.com'],
      caught: []
    })
    expect(
      applyMailTestMode({ ...base, testMode: false, catchHost: 'mailpit' }, ['cust@acme.com'], 'Hi')
    ).toEqual({ to: ['cust@acme.com'], subject: 'Hi', redirected: [], caught: [] })
  })
})

describe('sendRawMail with MAIL_CATCH_HOST', () => {
  it('catches non-allowlisted mail in the catch inbox, addressed as it was, tagged caught', async () => {
    process.env.MAIL_TEST_MODE = 'true'
    process.env.MAIL_CATCH_HOST = 'mailpit'
    const r = await sendRawMail({ to: 'cust@acme.com', subject: 'Invoice', html: '<p>x</p>' })
    expect(r.status).toBe('dropped')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ host: 'mailpit', to: ['cust@acme.com'], subject: 'Invoice' })
    expect(sent[0].headers).toEqual({ 'X-Tags': 'caught' })
  })

  it('allowlisted mail goes out for real, then a copy tagged delivered lands in the catch inbox', async () => {
    process.env.MAIL_TEST_MODE = 'true'
    process.env.MAIL_CATCH_HOST = 'mailpit'
    allowlist.value = '@nivaro.dev'
    const r = await sendRawMail({
      to: ['ana@nivaro.dev', 'cust@acme.com'],
      subject: 'Invoice',
      html: '<p>x</p>'
    })
    expect(r.status).toBe('sent')
    expect(sent.map((m) => [m.host, m.to, m.headers])).toEqual([
      ['mailpit', ['cust@acme.com'], { 'X-Tags': 'caught' }],
      ['relay.example.test', ['ana@nivaro.dev'], undefined],
      ['mailpit', ['ana@nivaro.dev'], { 'X-Tags': 'delivered' }]
    ])
  })

  it('a catch inbox that is down only warns about the copy once the real mail went out', async () => {
    process.env.MAIL_TEST_MODE = 'true'
    process.env.MAIL_CATCH_HOST = 'mailpit'
    allowlist.value = '@nivaro.dev'
    failHost.value = 'mailpit'
    const r = await sendRawMail({ to: 'ana@nivaro.dev', subject: 'Invoice', html: '<p>x</p>' })
    expect(r.status).toBe('sent')
    expect(sent.map((m) => m.host)).toEqual(['relay.example.test'])
  })

  it('a catch inbox that is down fails the send before anything goes out for real', async () => {
    process.env.MAIL_TEST_MODE = 'true'
    process.env.MAIL_CATCH_HOST = 'mailpit'
    failHost.value = 'mailpit'
    await expect(
      sendRawMail({ to: 'cust@acme.com', subject: 'Invoice', html: '<p>x</p>' })
    ).rejects.toThrow(/ECONNREFUSED mailpit/)
    expect(sent).toEqual([])
  })

  it('with test mode off the catch host changes nothing: real send only', async () => {
    process.env.MAIL_CATCH_HOST = 'mailpit'
    const r = await sendRawMail({ to: 'cust@acme.com', subject: 'Invoice', html: '<p>x</p>' })
    expect(r.status).toBe('sent')
    expect(sent.map((m) => m.host)).toEqual(['relay.example.test'])
  })
})
