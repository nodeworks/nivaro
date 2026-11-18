import { describe, expect, it } from 'vitest'
import {
  classifyMailError,
  isRetryableMailError,
  MAIL_RETRY_MAX,
  nextRetryDelayMs
} from '../../../services/mail-retry-policy.js'

// Rob 2026-11-18: failed sends retry when the mail server has a TEMPORARY error. What counts as
// temporary is decided from the error alone; anything that might already have delivered
// (a socket timeout or a dropped connection mid-conversation) never retries.

const smtpErr = (code: string, responseCode: number, command = 'RCPT TO') =>
  Object.assign(new Error(`Message failed: ${responseCode} x`), {
    code,
    responseCode,
    response: `${responseCode} x`,
    command
  })
const sysErr = (code: string, originalCode?: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error('boom'), { code, originalCode, command: 'CONN', ...extra })

describe('classifyMailError — temporary (retry)', () => {
  it.each([421, 450, 451, 452, 454])('SMTP %i', (n) => {
    expect(classifyMailError(smtpErr('EENVELOPE', n))).toEqual({
      kind: 'temporary',
      reason: `smtp-${n}`
    })
  })

  it('a 451 to the final dot (after DATA) — the server said it did NOT take it', () => {
    expect(classifyMailError(smtpErr('EMESSAGE', 451, 'DATA')).kind).toBe('temporary')
  })

  it('an enhanced 4.x.x code in the text with no reply code', () => {
    expect(classifyMailError(new Error('Greylisted 4.7.1 try later')).kind).toBe('temporary')
  })

  it('a refused / unreachable connection (nodemailer ESOCKET over a system code)', () => {
    for (const c of ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'])
      expect(classifyMailError(sysErr('ESOCKET', c))).toEqual({
        kind: 'temporary',
        reason: 'connect'
      })
  })

  it('setup-phase timeouts: connect, greeting, TLS upgrade', () => {
    for (const t of ['CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT'])
      expect(classifyMailError(sysErr('ETIMEDOUT', undefined, { timeoutType: t })).kind).toBe(
        'temporary'
      )
  })

  it('a temporary DNS failure', () => {
    expect(classifyMailError(sysErr('EDNS', 'EAI_AGAIN')).kind).toBe('temporary')
  })

  it('a TLS handshake the server reset', () => {
    const e = sysErr('ETLS', 'ECONNRESET')
    e.message = 'Connection closed unexpectedly'
    expect(classifyMailError(e)).toEqual({ kind: 'temporary', reason: 'tls-handshake' })
  })
})

describe('classifyMailError — never retried', () => {
  it.each([550, 553, 554, 552])('SMTP %i is permanent', (n) => {
    expect(classifyMailError(smtpErr('EENVELOPE', n)).kind).toBe('permanent')
  })

  it('535 authentication failed is permanent (the settings are wrong)', () => {
    expect(classifyMailError(smtpErr('EAUTH', 535, 'AUTH PLAIN'))).toEqual({
      kind: 'permanent',
      reason: 'auth'
    })
    expect(classifyMailError(sysErr('EAUTH')).kind).toBe('permanent')
  })

  it('an invalid recipient / sender (no server reply)', () => {
    expect(classifyMailError(sysErr('EENVELOPE')).kind).toBe('permanent')
  })

  it('a host name that does not exist', () => {
    expect(classifyMailError(sysErr('EDNS', 'ENOTFOUND')).kind).toBe('permanent')
  })

  it('a certificate the TLS check rejects', () => {
    const e = sysErr('ESOCKET', 'CERT_HAS_EXPIRED')
    e.message = 'certificate has expired'
    expect(classifyMailError(Object.assign(e, { code: 'ETLS' })).kind).toBe('permanent')
  })

  it('timeout after the conversation started is AMBIGUOUS — may have delivered', () => {
    expect(
      classifyMailError(sysErr('ETIMEDOUT', undefined, { timeoutType: 'SOCKET_TIMEOUT' }))
    ).toEqual({ kind: 'ambiguous', reason: 'socket-timeout' })
    expect(isRetryableMailError(sysErr('ETIMEDOUT'))).toBe(false)
  })

  it('a connection closed / reset mid-way is AMBIGUOUS', () => {
    expect(classifyMailError(sysErr('ECONNECTION')).kind).toBe('ambiguous')
    expect(classifyMailError(sysErr('ESOCKET', 'ECONNRESET')).kind).toBe('ambiguous')
  })

  it('unknown errors and template / render errors', () => {
    expect(classifyMailError(new Error('Template "x" not found')).kind).toBe('unknown')
    expect(classifyMailError(null).kind).toBe('unknown')
    expect(classifyMailError('nope').kind).toBe('unknown')
  })
})

describe('retry schedule', () => {
  it('1 min, 5 min, 15 min, 1 h — then nothing', () => {
    expect(MAIL_RETRY_MAX).toBe(4)
    expect([0, 1, 2, 3, 4].map(nextRetryDelayMs)).toEqual([
      60_000,
      300_000,
      900_000,
      3_600_000,
      null
    ])
  })

  it('a nonsense count starts at the first step', () => {
    expect(nextRetryDelayMs(-1)).toBe(60_000)
    expect(nextRetryDelayMs(Number.NaN)).toBe(60_000)
  })
})
