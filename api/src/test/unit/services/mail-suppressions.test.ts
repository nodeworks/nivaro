import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => null }))
vi.mock('../../../admin-base.js', () => ({ adminBaseUrl: () => null }))

import {
  classifyBounce,
  filterSuppressed,
  normalizeAddress,
  partitionSuppressed
} from '../../../services/mail-suppressions.js'

/** The shape nodemailer's SMTP transport rejects with. */
function smtpError(fields: Record<string, unknown>) {
  const e = new Error(String(fields.response ?? fields.message ?? 'send failed'))
  return Object.assign(e, fields)
}

describe('classifyBounce', () => {
  it('a 550 on RCPT with a rejected list is a hard bounce for exactly those addresses', () => {
    const v = classifyBounce(
      smtpError({
        code: 'EENVELOPE',
        responseCode: 550,
        command: 'RCPT TO',
        rejected: ['Nobody@Example.com'],
        response: '550 5.1.1 <nobody@example.com>: Recipient address rejected: User unknown'
      }),
      ['nobody@example.com', 'someone@example.com']
    )
    expect(v.kind).toBe('hard')
    expect(v.code).toBe(550)
    expect(v.addresses).toEqual(['nobody@example.com'])
    // the stored reason is the normalised head — no address, no session id
    expect(v.reason).not.toContain('nobody@')
    expect(v.reason).toContain('User unknown')
  })

  it('a 4xx is soft and never suppresses', () => {
    const v = classifyBounce(
      smtpError({
        responseCode: 452,
        command: 'RCPT TO',
        rejected: ['full@example.com'],
        response: '452 4.2.2 Mailbox full, try again later'
      }),
      ['full@example.com']
    )
    expect(v.kind).toBe('soft')
    expect(v.addresses).toEqual(['full@example.com'])
  })

  it('a connection error carries no verdict about the address', () => {
    const v = classifyBounce(
      smtpError({ code: 'ECONNECTION', message: 'connect ECONNREFUSED 10.0.0.5:587' }),
      ['a@example.com']
    )
    expect(v.kind).toBe('unknown')
    expect(v.code).toBeNull()
  })

  it('a hard-bounce phrase in the text is hard even without a rejected list', () => {
    const v = classifyBounce(
      smtpError({
        responseCode: 554,
        command: 'DATA',
        response: '554 5.7.1 <gone@example.com>: no such user here'
      }),
      ['gone@example.com', 'other@example.com']
    )
    expect(v.kind).toBe('hard')
    // the response named the address, so only it is blamed
    expect(v.addresses).toEqual(['gone@example.com'])
  })

  it('a 5xx that names nobody blames the single recipient only', () => {
    const one = classifyBounce(
      smtpError({ responseCode: 550, command: 'RCPT TO', response: '550 mailbox unavailable' }),
      ['only@example.com']
    )
    expect(one.kind).toBe('hard')
    expect(one.addresses).toEqual(['only@example.com'])
    const many = classifyBounce(
      smtpError({ responseCode: 550, command: 'RCPT TO', response: '550 mailbox unavailable' }),
      ['a@example.com', 'b@example.com']
    )
    expect(many.kind).toBe('hard')
    expect(many.addresses).toEqual([])
  })

  it('a 5xx about the sender or the connection is not a recipient bounce', () => {
    const v = classifyBounce(
      smtpError({
        responseCode: 530,
        command: 'MAIL FROM',
        response: '530 5.7.0 Authentication required'
      }),
      ['a@example.com']
    )
    expect(v.kind).toBe('unknown')
  })

  it('reads a status code off the response text when the transport gave none', () => {
    const v = classifyBounce(smtpError({ message: '550 5.1.1 User unknown' }), ['x@example.com'])
    expect(v.kind).toBe('hard')
    expect(v.code).toBe(550)
  })
})

describe('partitionSuppressed / filterSuppressed', () => {
  it('splits recipients case-insensitively and keeps the original spelling', () => {
    const map = new Map<string, string | null>([['dead@example.com', '550 User unknown']])
    const out = partitionSuppressed(['Dead@Example.com', 'live@example.com'], map)
    expect(out.kept).toEqual(['live@example.com'])
    expect(out.dropped).toEqual([{ address: 'Dead@Example.com', reason: '550 User unknown' }])
  })

  it('a suppression with no stored reason still explains the drop', () => {
    const map = new Map<string, string | null>([['dead@example.com', null]])
    expect(partitionSuppressed(['dead@example.com'], map).dropped[0].reason).toBe('address bounced')
  })

  it('filterSuppressed consults the lookup once and passes everything through when nothing matches', async () => {
    const lookup = vi.fn(async () => new Map<string, string | null>())
    const out = await filterSuppressed(['a@example.com', 'b@example.com'], lookup)
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(out).toEqual({ kept: ['a@example.com', 'b@example.com'], dropped: [] })
    expect(await filterSuppressed([], lookup)).toEqual({ kept: [], dropped: [] })
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('filterSuppressed drops the suppressed half', async () => {
    const lookup = async () => new Map<string, string | null>([['b@example.com', 'bounced']])
    const out = await filterSuppressed(['a@example.com', 'b@example.com'], lookup)
    expect(out.kept).toEqual(['a@example.com'])
    expect(out.dropped.map((d) => d.address)).toEqual(['b@example.com'])
  })

  it('normalizeAddress strips angle brackets and case', () => {
    expect(normalizeAddress(' <Rob@Example.COM> ')).toBe('rob@example.com')
  })
})
