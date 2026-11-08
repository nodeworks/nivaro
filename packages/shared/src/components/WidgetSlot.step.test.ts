import { describe, expect, it } from 'vitest'
import { hostStepChange } from './WidgetSlot'

// Army9 b06 N-AB: a record-header widget (EFP Committed) re-renders past the
// cache when the host record's pipeline step moves — and only then.
describe('hostStepChange', () => {
  const read = (state: string | null) => ({ instance: { current_state: state } })
  it('a first read is not a move', () => {
    expect(hostStepChange(undefined, read('L1'))).toEqual({ next: 'L1', moved: false })
  })
  it('a refetch on the same step is not a move', () => {
    expect(hostStepChange('L1', read('L1')).moved).toBe(false)
  })
  it('a different step is a move', () => {
    expect(hostStepChange('L1', read('started'))).toEqual({ next: 'started', moved: true })
  })
  it('a failed read (null) says nothing about the step', () => {
    expect(hostStepChange('L1', null)).toEqual({ next: 'L1', moved: false })
    expect(hostStepChange(undefined, null)).toEqual({ next: undefined, moved: false })
  })
})
