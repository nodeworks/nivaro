import { describe, expect, it } from 'vitest'
import { latestSendBack, REFUSAL_FIX_ACTIONS, refusalCode, refusalFixFor } from './PipelinePanel'

const states = [
  { id: 'S-START', sort: 0 },
  { id: 'S-L1', sort: 1 },
  { id: 'S-L2', sort: 2 }
]
const entry = (over: Record<string, unknown>) =>
  ({
    id: 1,
    from_state: 'S-L1',
    to_state: 'S-START',
    from_state_label: 'L1',
    to_state_label: 'Started',
    from_state_color: null,
    to_state_color: null,
    user_email: 'lee@x.test',
    first_name: 'Lee',
    last_name: 'Herzog',
    comment: 'Please fix the category',
    timestamp: '2026-11-05T20:00:00Z',
    origin: 'person',
    ...over
  }) as never

describe('send-back notice (army4 a15-4)', () => {
  it('the newest move, a send back with a note into the current state, is shown', () => {
    const h = [
      entry({
        id: 1,
        from_state: 'S-START',
        to_state: 'S-L1',
        comment: null,
        timestamp: '2026-11-05T19:00:00Z'
      }),
      entry({ id: 2 })
    ]
    expect((latestSendBack(h, 's-start', states) as { id: number } | null)?.id).toBe(2)
  })

  it('not once the record has moved on, nor for a forward move, a machine move or no note', () => {
    expect(latestSendBack([entry({})], 'S-L1', states)).toBeNull()
    expect(
      latestSendBack([entry({ from_state: 'S-START', to_state: 'S-L1' })], 'S-L1', states)
    ).toBeNull()
    expect(latestSendBack([entry({ origin: 'machine' })], 'S-START', states)).toBeNull()
    expect(latestSendBack([entry({ comment: '  ' })], 'S-START', states)).toBeNull()
    expect(latestSendBack([], 'S-START', states)).toBeNull()
    expect(latestSendBack([entry({})], null, states)).toBeNull()
  })
})

describe('refusal fix (army4 a15-2)', () => {
  const err = (code: string, shape: 'sdk' | 'axios') =>
    shape === 'sdk' ? { status: 422, response: { code } } : { response: { data: { code } } }

  it('PRIORITY_REQUIRED offers the priority action and keeps the move to retry', () => {
    expect(REFUSAL_FIX_ACTIONS.PRIORITY_REQUIRED).toBe('priority')
    for (const shape of ['sdk', 'axios'] as const) {
      expect(refusalCode(err('PRIORITY_REQUIRED', shape))).toBe('PRIORITY_REQUIRED')
      expect(
        refusalFixFor(err('PRIORITY_REQUIRED', shape), { transition_id: 'T1', comment: 'ok' })
      ).toEqual({
        code: 'PRIORITY_REQUIRED',
        actionKey: 'priority',
        transitionId: 'T1',
        comment: 'ok'
      })
    }
  })

  it('any other refusal offers nothing', () => {
    expect(refusalFixFor(err('EDIT_LOCKED', 'sdk'), { transition_id: 'T1' })).toBeNull()
    expect(refusalFixFor(new Error('x'), { transition_id: 'T1' })).toBeNull()
  })
})
