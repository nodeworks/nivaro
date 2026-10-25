import { describe, expect, it } from 'vitest'
import { restoreSkippedNote } from './restore-skipped'

describe('restoreSkippedNote', () => {
  it('names the fields a rollback could not write, in either answer shape', () => {
    expect(restoreSkippedNote({ data: { skipped_fields: ['vendor_contact'] } })).toBe(
      "Not restored (you can't change it): vendor contact"
    )
    expect(restoreSkippedNote({ skipped_fields: ['a', 'b'] })).toBe(
      "Not restored (you can't change them): a, b"
    )
    expect(restoreSkippedNote({ data: { skipped_fields: [] } })).toBeNull()
    expect(restoreSkippedNote(null)).toBeNull()
  })
})
