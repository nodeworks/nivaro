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
})
