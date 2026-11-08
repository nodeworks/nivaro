import { describe, expect, it } from 'vitest'
import { type QueueReturnStash, queueReturnApplies } from './QueueReturnChip'

// army 10: only the chip restored a worklist; Back and the record's back arrow showed page 1.
const stash = (over: Partial<QueueReturnStash> = {}): QueueReturnStash => ({
  queue_id: 'q1',
  name: 'Approvals',
  path: '/queues/q1',
  at: Date.now(),
  scroll: 0,
  state: { page: 3 },
  entry: 'entry-a',
  ...over
})

describe('queueReturnApplies', () => {
  it('the chip asked for it', () => {
    expect(queueReturnApplies(stash({ restore: true }), 'q1', 'other', false)).toBe(true)
  })
  it('Back to the entry the record was opened from', () => {
    expect(queueReturnApplies(stash(), 'q1', 'entry-a', false)).toBe(true)
  })
  it("the record's back arrow (a return navigation)", () => {
    expect(queueReturnApplies(stash(), 'q1', 'entry-new', true)).toBe(true)
  })
  it('a plain new visit, or another queue, starts clean', () => {
    expect(queueReturnApplies(stash(), 'q1', 'entry-new', false)).toBe(false)
    expect(queueReturnApplies(stash({ entry: null }), 'q1', null, false)).toBe(false)
    expect(queueReturnApplies(stash({ restore: true }), 'q2', 'entry-a', true)).toBe(false)
  })
})
