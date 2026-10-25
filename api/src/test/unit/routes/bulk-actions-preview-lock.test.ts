import { describe, expect, it, vi } from 'vitest'

// army v3: the bulk bar's dry run said "1 of 1 would change" for an On Hold
// on an approval-locked record, then the run failed. The preview now judges
// the record write gates the run's updateOne applies.
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/edit-lock.js', () => ({
  recordWriteRefusal: vi.fn(async (_req: unknown, _c: string, id: string) =>
    id === '372703'
      ? {
          status: 403,
          body: { error: 'This record is at Waiting on Level 2 Approval', code: 'EDIT_LOCKED' }
        }
      : id === '9'
        ? { status: 404, body: { error: 'Not found' } }
        : null
  )
}))

import { refuseUnwritable } from '../../../routes/bulk-actions.js'

describe('bulk-action preview judges the write gates', () => {
  it('turns a locked or unreadable "would change" into a failure; leaves the writable one', async () => {
    const result = {
      succeeded: 3,
      failed: 0,
      skipped: 1,
      errors: [] as Array<{ item: string; error: string }>,
      skipped_items: ['4'],
      outcomes: [
        { item: '372703', outcome: 'change' as const, reason: 'is_on_hold → true' },
        { item: '9', outcome: 'change' as const, reason: 'is_on_hold → true' },
        { item: '5', outcome: 'change' as const, reason: 'is_on_hold → true' },
        { item: '4', outcome: 'skip' as const, reason: 'already there' }
      ]
    }
    await refuseUnwritable(result, 'workflows', {} as never)
    expect(result.outcomes.map((o) => [o.item, o.outcome])).toEqual([
      ['372703', 'fail'],
      ['9', 'fail'],
      ['5', 'change'],
      ['4', 'skip']
    ])
    expect(result.outcomes[0].reason).toContain('Level 2')
    expect(result).toMatchObject({ succeeded: 1, failed: 2, skipped: 1 })
  })
})
