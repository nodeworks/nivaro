import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

const { pickBulkTransition } = await import('../../../routes/items.js')

const T = 'TPL-1'
const sendBack = [
  { id: 'sb-l2', template: T, from_state: 'L2' },
  { id: 'sb-l3', template: T, from_state: 'L3' }
]

describe('pickBulkTransition', () => {
  it('picks the Send Back that starts at the record state', () => {
    expect(pickBulkTransition(sendBack, { template: T, current_state: 'l3' })?.id).toBe('sb-l3')
  })
  it('falls back to a from-any transition, else none', () => {
    const anyFrom = [...sendBack, { id: 'cancel', template: T, from_state: null }]
    expect(pickBulkTransition(anyFrom, { template: T, current_state: 'X' })?.id).toBe('cancel')
    expect(pickBulkTransition(sendBack, { template: T, current_state: 'X' })).toBeNull()
  })
  it('never crosses templates; one named transition keeps the old behaviour', () => {
    expect(pickBulkTransition(sendBack, { template: 'OTHER', current_state: 'L2' })).toBeNull()
    expect(pickBulkTransition([sendBack[0]], { template: T, current_state: 'L9' })?.id).toBe(
      'sb-l2'
    )
  })
  it('refuses when two moves from this state go to different steps', () => {
    const twoTargets = [
      { id: 'sb-start', template: T, from_state: 'L3', to_state: 'STARTED' },
      { id: 'sb-l1', template: T, from_state: 'L3', to_state: 'L1' }
    ]
    expect(pickBulkTransition(twoTargets, { template: T, current_state: 'L3' })).toBeNull()
    expect(pickBulkTransition([twoTargets[1]], { template: T, current_state: 'L3' })?.id).toBe(
      'sb-l1'
    )
  })
})
