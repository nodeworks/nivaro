import { describe, expect, it } from 'vitest'
import { landingState } from './landing-state'

const states = [
  { id: 'L1', label: 'Waiting on Level 1 Approval', sort: 2 },
  { id: 'L2', label: 'Waiting on Level 2 Approval', sort: 3 },
  { id: 'L3', label: 'Waiting on Level 3 Approval', sort: 4 },
  { id: 'L4', label: 'Waiting on Level 4 Approval', sort: 5 },
  { id: 'L5', label: 'Waiting on Level 5 Approval', sort: 6 },
  { id: 'BEE', label: 'Waiting on Beeline Submission', sort: 7 },
  { id: 'FUS', label: 'Waiting on Fusion Submission', sort: 8 }
]

// Army 8 b06-N-U: a $5,000 request approved at Level 2 went to Level 5, while
// the confirm panel said Level 3.
describe('landingState', () => {
  it('walks past states the engine will skip, collecting the reasons', () => {
    const l = landingState('L3', states, {
      L3: { skipped: true, skip_reasons: ['requisition amount (5,000) is below 20,000'] },
      L4: { skipped: true, skip_reasons: ['requisition amount (5,000) is below 50,000'] },
      L5: { skipped: false }
    })
    expect(l?.state.id).toBe('L5')
    expect(l?.skipped.map((s) => s.state.id)).toEqual(['L3', 'L4'])
    expect(l?.skipped[0].reasons[0]).toContain('below 20,000')
  })
  it('steps over states on another branch', () => {
    const l = landingState('L5', states, {
      L5: { skipped: true },
      BEE: { on_path: false },
      FUS: { skipped: false }
    })
    expect(l?.state.id).toBe('FUS')
  })
  it('is the target itself when nothing is skipped or the chain is not loaded', () => {
    expect(landingState('L3', states, { L3: { skipped: false } })?.state.id).toBe('L3')
    expect(landingState('L3', states, null)?.state.id).toBe('L3')
    expect(landingState('nope', states, null)).toBeNull()
  })
})
