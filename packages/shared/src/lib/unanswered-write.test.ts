import { describe, expect, it } from 'vitest'
import { isUnansweredWrite, recordOfWritePath } from './unanswered-write'

describe('recordOfWritePath (rt-fix C, L4)', () => {
  it('names the record of an item write or a pipeline move', () => {
    expect(recordOfWritePath('/items/workflows/372787')).toEqual({
      collection: 'workflows',
      id: '372787'
    })
    expect(recordOfWritePath('/api/items/workflows/12?dry_run=0')).toEqual({
      collection: 'workflows',
      id: '12'
    })
    expect(recordOfWritePath('/pipelines/instance/workflows/12/transition')).toEqual({
      collection: 'workflows',
      id: '12'
    })
  })
  it('ignores creates, batches and other routes', () => {
    expect(recordOfWritePath('/items/workflows')).toBeNull()
    expect(recordOfWritePath('/items/workflows/12/extra')).toBeNull()
    expect(recordOfWritePath('/comments')).toBeNull()
  })
})

describe('isUnansweredWrite', () => {
  it('only a write that gave up on IDEMPOTENCY_IN_PROGRESS', () => {
    expect(
      isUnansweredWrite({ type: 'gave-up', write: true, code: 'IDEMPOTENCY_IN_PROGRESS' })
    ).toBe(true)
    expect(isUnansweredWrite({ type: 'gave-up', write: true })).toBe(false)
    expect(
      isUnansweredWrite({ type: 'gave-up', write: false, code: 'IDEMPOTENCY_IN_PROGRESS' })
    ).toBe(false)
    expect(
      isUnansweredWrite({ type: 'recovered', write: true, code: 'IDEMPOTENCY_IN_PROGRESS' })
    ).toBe(false)
  })
})
