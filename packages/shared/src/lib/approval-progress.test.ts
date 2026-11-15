import { describe, expect, it } from 'vitest'
import { laneProgressText } from '../components/panels/BranchLanes'
import { approvalDecisionText, chainStepText, namesList, pastMove } from './approval-progress'
import { atClock } from './send-status'

const NOW = Date.parse('2026-11-14T16:00:00Z')
const AT = '2026-11-14T15:42:00.000Z'
const clock = atClock(AT, NOW)

describe('approval progress words', () => {
  it('names: three, then "and N more"', () => {
    expect(namesList(['Jane Doe', 'Mark Li'])).toBe('Jane Doe, Mark Li')
    expect(namesList(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C and 2 more')
  })

  it('pastMove turns a move into what happened', () => {
    expect(pastMove('Approve')).toBe('Approved')
    expect(pastMove('Send back to requester')).toBe('Sent back to requester')
    expect(pastMove('Approved')).toBe('Approved')
    expect(pastMove('Escalate')).toBeNull()
  })

  it('the current step waits on its owners', () => {
    expect(
      chainStepText({
        stateId: 'fin',
        currentStateId: 'fin',
        history: [],
        owners: ['Jane Doe', 'Mark Li'],
        now: NOW
      })
    ).toEqual({ kind: 'waiting', text: 'Waiting on Jane Doe, Mark Li' })
  })

  it('a step left says who moved it on and when', () => {
    expect(
      chainStepText({
        stateId: 'fin',
        currentStateId: 'ops',
        history: [
          {
            from_state: 'fin',
            transition_label: 'Approve',
            first_name: 'Beth',
            last_name: 'Lee',
            timestamp: AT
          }
        ],
        now: NOW
      })
    ).toEqual({ kind: 'done', text: `Approved by Beth Lee at ${clock}` })
  })

  it('a step still ahead says nothing', () => {
    expect(chainStepText({ stateId: 'x', currentStateId: 'y', history: [], now: NOW })).toBeNull()
  })

  it('approval chain decisions', () => {
    expect(
      approvalDecisionText(
        { decision: 'approved', approver_name: 'Beth Lee', decided_at: AT },
        false,
        NOW
      )
    ).toBe(`Approved by Beth Lee at ${clock}`)
    expect(approvalDecisionText({ decision: 'pending', approver_name: 'Jane Doe' }, true)).toBe(
      'Waiting on Jane Doe'
    )
    expect(approvalDecisionText({ decision: 'pending' }, false)).toBeNull()
  })

  it('parallel branch lanes', () => {
    expect(
      laneProgressText({
        terminal: false,
        current: { id: 's', label: 'Review', color: null },
        steps: [],
        finished_at: null,
        owners: [
          { id: '1', name: 'Jane Doe' },
          { id: '2', name: 'Mark Li' }
        ]
      })
    ).toBe('Waiting on Jane Doe, Mark Li')
    expect(
      laneProgressText(
        {
          terminal: true,
          current: { id: 'a', label: 'Approved', color: null },
          steps: [
            {
              state: { id: 'a', label: 'Approved', color: null },
              entered_at: AT,
              left_at: null,
              by: 'Beth Lee'
            }
          ],
          finished_at: AT,
          owners: []
        },
        NOW
      )
    ).toBe(`Approved by Beth Lee at ${clock}`)
  })
})
