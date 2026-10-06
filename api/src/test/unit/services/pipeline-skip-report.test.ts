import { describe, expect, it } from 'vitest'
import {
  computeSkipHistory,
  criterionVerdict,
  describeCriterion
} from '../../../services/pipeline-skip-report.js'

const states = [
  { id: 'started', sort: 1 },
  { id: 'l1', sort: 2 },
  { id: 'l2', sort: 3 },
  { id: 'l3', sort: 4 },
  { id: 'done', sort: 9 }
]

describe('computeSkipHistory', () => {
  it('a forward jump skips the unvisited states it crosses', () => {
    const r = computeSkipHistory(
      states,
      [
        { instance: 'a', from_state: 'started', to_state: 'l1' },
        { instance: 'a', from_state: 'l1', to_state: 'done' }
      ],
      new Map([['A', new Set(['L1', 'DONE'])]])
    )
    expect(r.get('L2')).toEqual({ entered: 0, skipped: 1 })
    expect(r.get('L3')).toEqual({ entered: 0, skipped: 1 })
    expect(r.get('L1')).toEqual({ entered: 1, skipped: 0 })
  })

  it('a state visited earlier (even before the window) is not skipped; send-backs skip nothing', () => {
    const r = computeSkipHistory(
      states,
      [
        { instance: 'b', from_state: 'l3', to_state: 'started' },
        { instance: 'b', from_state: 'started', to_state: 'l3' }
      ],
      new Map([['B', new Set(['L1', 'L2', 'L3', 'STARTED'])]])
    )
    expect(r.get('L1')?.skipped).toBe(0)
    expect(r.get('L2')?.skipped).toBe(0)
    expect(r.get('STARTED')?.entered).toBe(1)
  })

  it('counts distinct instances, case-insensitively', () => {
    const r = computeSkipHistory(
      states,
      [
        { instance: 'x', from_state: 'STARTED', to_state: 'l3' },
        { instance: 'X', from_state: 'started', to_state: 'L3' },
        { instance: 'y', from_state: 'started', to_state: 'l3' }
      ],
      new Map()
    )
    expect(r.get('L1')?.skipped).toBe(2)
    expect(r.get('L3')?.entered).toBe(2)
  })
})

describe('criterionVerdict / describeCriterion', () => {
  it('needs a minimum sample before calling never/always', () => {
    expect(criterionVerdict(0, 5)).toBe('too_few')
    expect(criterionVerdict(0, 40)).toBe('never')
    expect(criterionVerdict(40, 40)).toBe('always')
    expect(criterionVerdict(3, 40)).toBe('sometimes')
  })

  it('reads a lookup threshold as a sentence', () => {
    expect(
      describeCriterion({
        type: 'lookup_compare',
        collection: 'approval_thresholds',
        record_field: 'requisition_amount',
        compare_column: 'threshold_amount',
        op: 'lt',
        filters: [{ column: 'level', value: 2 }]
      })
    ).toBe(
      'requisition amount is below the threshold amount in approval_thresholds (where level = 2)'
    )
  })
})
