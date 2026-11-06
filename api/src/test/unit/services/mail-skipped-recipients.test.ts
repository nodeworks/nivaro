import { describe, expect, it, vi } from 'vitest'

// Army 4 (2026-11-05): suspended owners were dropped from a send with no mail-log
// row, so "why didn't X get it" had no answer. dropInactiveRecipients now says who
// and why; the senders log one 'dropped' row per skipped address.

const rows = [
  { email: 'Gone@x.com', status: 'suspended', is_redacted: 0 },
  { email: 'erased@x.com', status: 'active', is_redacted: 1 },
  { email: 'here@x.com', status: 'active', is_redacted: 0 }
]
vi.mock('../../../db/index.js', () => {
  const db = Object.assign(
    () => ({
      whereIn: () => ({ select: async () => rows })
    }),
    { raw: (s: string) => s }
  )
  return { db }
})

import { dropInactiveRecipients } from '../../../services/mail.js'

describe('dropInactiveRecipients', () => {
  it('keeps active people and names everyone it left out', async () => {
    const out = await dropInactiveRecipients([
      'gone@x.com',
      'erased@x.com',
      'here@x.com',
      'vendor@y.com'
    ])
    expect(out.kept).toEqual(['here@x.com', 'vendor@y.com'])
    expect(out.skipped).toEqual([
      { address: 'gone@x.com', reason: 'account suspended' },
      { address: 'erased@x.com', reason: 'account redacted' }
    ])
  })

  it('nothing to check → nothing skipped', async () => {
    expect(await dropInactiveRecipients([])).toEqual({ kept: [], skipped: [] })
  })
})
