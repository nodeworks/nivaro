import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { moveNote } from '../../../services/workflow-transitions.js'

// Army 11 a1 F-9 / o3: in-app texts say who sent a record back and why, and a
// resubmission says it follows a send back.
describe('moveNote', () => {
  it('a send back names who and why', () => {
    expect(moveNote('send_back', 'Timothy Desrosiers', 'please re-check the vendor', null)).toBe(
      ' Sent back by Timothy Desrosiers: “please re-check the vendor”.'
    )
    expect(moveNote('send_back', null, null, null)).toBe(' Sent back by someone.')
  })
  it('a resubmission names the send back it answers', () => {
    expect(
      moveNote('resubmit', 'Kristina Davison', null, {
        sent_back_by: 'Bernard Kelly',
        sent_back_from: 'Waiting on Level 2 Approval',
        reason: 'add the <b>2026</b> forecast',
        at: null
      })
    ).toBe(
      ' Resubmitted after Bernard Kelly sent it back from Waiting on Level 2 Approval (“add the 2026 forecast”).'
    )
  })
  it('plain progress adds nothing', () => {
    expect(moveNote('forward', 'Lee', 'ok', null)).toBe('')
  })
})
