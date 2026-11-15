import { describe, expect, it, vi } from 'vitest'

// The receipt line under a comment says what the Delivery panel says (design review
// 2026-11-15): seen / in their inbox / won't be told; "muted" + why only for administrators.

const rows = [{ recipient: 'U-MARK', timestamp: new Date('2026-11-15T10:00:01Z') }]
vi.mock('../../../db/index.js', () => {
  const builder = () => {
    const b: Record<string, unknown> = {}
    for (const k of ['where', 'whereIn']) b[k] = () => b
    b.select = async () => rows
    return b
  }
  return { db: Object.assign(vi.fn(builder), { schema: {} }) }
})
vi.mock('../../../services/notification-channels.js', () => ({
  parseDelivery: (v: unknown) => v,
  decideDelivery: vi.fn(async () => ({
    dropped: false,
    inapp: false,
    reasons: [
      { code: 'always_inbox', channel: 'inapp', text: 'Sender asked for the inbox row.' },
      { code: 'matrix_inapp_off', channel: 'inapp', text: 'In-app alerts for Mentions are off.' }
    ]
  }))
}))

import { mentionStatuses, plainSilenceReason } from '../../../services/mention-delivery.js'
import { receiptKey } from '../../../services/mention-receipts.js'

const at = '2026-11-15T10:00:00Z'
const mentions = [
  { comment: 'c1', user: 'U-BETH', at, author: 'U-ME' },
  { comment: 'c1', user: 'U-MARK', at, author: 'U-ME' },
  { comment: 'c1', user: 'U-KIM', at, author: 'U-ME' },
  { comment: 'c1', user: 'U-ME', at, author: 'U-ME' }
]
const receipts = new Map([[receiptKey('c1', 'U-BETH'), '2026-11-15T10:05:00Z']])

describe('mention statuses for the receipt line', () => {
  it('a non-admin author: seen, in inbox, and a muted person simply "not told"', async () => {
    const s = await mentionStatuses('ideas', '1', mentions, receipts, false)
    expect(s.get(receiptKey('c1', 'U-BETH'))).toEqual({ status: 'seen' })
    expect(s.get(receiptKey('c1', 'U-MARK'))).toEqual({ status: 'in_inbox' })
    expect(s.get(receiptKey('c1', 'U-KIM'))).toEqual({ status: 'not_told' })
    expect(s.has(receiptKey('c1', 'U-ME'))).toBe(false)
  })

  it('an administrator: muted, with the rule in plain words', async () => {
    const s = await mentionStatuses('ideas', '1', mentions, receipts, true)
    expect(s.get(receiptKey('c1', 'U-KIM'))).toEqual({
      status: 'muted',
      reason: 'turned off in-app alerts for Mentions'
    })
  })

  it('plain reasons', () => {
    expect(plainSilenceReason('suspended', 'x')).toBe('the account is suspended')
    expect(plainSilenceReason('other', 'Something happened.')).toBe('Something happened')
  })
})
