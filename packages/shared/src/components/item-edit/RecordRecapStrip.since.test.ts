import { describe, expect, it } from 'vitest'
import { emailSinceFromSearch, emailSinceParts } from './RecordRecapStrip'

describe('since-this-email strip', () => {
  it('reads a usable since from the address', () => {
    expect(emailSinceFromSearch('?since=2026-11-10T12%3A00%3A00.000Z&tab=x')).toBe(
      '2026-11-10T12:00:00.000Z'
    )
    expect(emailSinceFromSearch('?since=nope')).toBeNull()
    expect(emailSinceFromSearch('')).toBeNull()
  })

  it('says the move first, then fields and comments', () => {
    expect(
      emailSinceParts({
        since: '2026-11-10T12:00:00.000Z',
        moved_to: { label: 'Approved', color: null },
        transitions: 1,
        field_changes: 2,
        fields: ['Status', 'Amount'],
        comments: 1
      })
    ).toEqual(['moved to Approved', '2 fields changed', '1 new comment'])
  })
})
