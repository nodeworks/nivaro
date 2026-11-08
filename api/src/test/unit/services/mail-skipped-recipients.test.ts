import { describe, expect, it, vi } from 'vitest'

// Army 4 (2026-11-05): suspended owners were dropped from a send with no mail-log
// row, so "why didn't X get it" had no answer. dropInactiveRecipients now says who
// and why; the senders log one 'dropped' row per skipped address.

const rows = [
  { email: 'Gone@x.com', status: 'suspended', is_redacted: 0 },
  { email: 'erased@x.com', status: 'active', is_redacted: 1 },
  { email: 'here@x.com', status: 'active', is_redacted: 0 },
  { email: 'nuvolo@x.com', status: 'active', is_redacted: 0, account_kind: 'integration' },
  { email: 'stand-in@x.com', status: 'active', is_redacted: 0, account_kind: 'placeholder' }
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
    const out = await dropInactiveRecipients(
      [
        'gone@x.com',
        'erased@x.com',
        'here@x.com',
        'vendor@y.com',
        'nuvolo@x.com',
        'stand-in@x.com'
      ],
      ['nuvolo@x.com']
    )
    expect(out.kept).toEqual(['here@x.com', 'vendor@y.com', 'stand-in@x.com'])
    expect(out.skipped).toEqual([
      { address: 'gone@x.com', reason: 'account suspended' },
      { address: 'erased@x.com', reason: 'account redacted' },
      // army 11: a machine identity is never mailed as a record's creator / owner
      { address: 'nuvolo@x.com', reason: 'machine account (not a person)' }
    ])
  })

  it('a machine account an admin typed in (not picked by role) still gets its mail (rev11-api)', async () => {
    const explicit = await dropInactiveRecipients(['nuvolo@x.com', 'here@x.com'])
    expect(explicit.kept).toEqual(['nuvolo@x.com', 'here@x.com'])
    const byRole = await dropInactiveRecipients(['nuvolo@x.com', 'here@x.com'], true)
    expect(byRole.kept).toEqual(['here@x.com'])
  })

  it('nothing to check → nothing skipped', async () => {
    expect(await dropInactiveRecipients([])).toEqual({ kept: [], skipped: [] })
  })
})
