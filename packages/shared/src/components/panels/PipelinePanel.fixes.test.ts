import { describe, expect, it } from 'vitest'
import {
  briefWarnings,
  FRESH_BUTTON_MS,
  FRESH_HOVER_MAX_MS,
  FreshButtonGuard,
  latestSendBack,
  lockedMoveOffer,
  REFUSAL_FIX_ACTIONS,
  refusalCode,
  refusalFixFor
} from './PipelinePanel'

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

describe('fresh transition buttons (army6 M19)', () => {
  it('the first answer is the baseline: nothing on offer then is inert', () => {
    const g = new FreshButtonGuard()
    g.observe(['t-approve'], 0)
    expect(g.press('t-approve', 1)).toBe(true)
  })

  it('a button that appears after a move is inert for the window; a double click cannot press it', () => {
    const g = new FreshButtonGuard()
    g.observe(['t-approve'], 0)
    g.observe(['t-submit-wh'], 1000)
    expect(g.timed('t-submit-wh', 1100)).toBe(true)
    expect(g.press('t-submit-wh', 1100)).toBe(false)
    // The press inside the window counts as the pointer being there: after the
    // window it still needs the pointer to leave and come back.
    expect(g.press('t-submit-wh', 1000 + FRESH_BUTTON_MS + 10)).toBe(false)
    g.leave('t-submit-wh')
    g.enter('t-submit-wh', 1000 + FRESH_BUTTON_MS + 20)
    expect(g.press('t-submit-wh', 1000 + FRESH_BUTTON_MS + 30)).toBe(true)
  })

  it('a pointer resting on the new button must leave and re-enter; one that never was there needs only the window', () => {
    const g = new FreshButtonGuard()
    g.observe(['a'], 0)
    g.observe(['a', 'b', 'c'], 100)
    g.enter('b', 200)
    const later = 100 + FRESH_BUTTON_MS + 50
    expect(g.inert('b', later)).toBe(true)
    expect(g.press('c', later)).toBe(true)
    g.leave('b')
    expect(g.press('b', later)).toBe(true)
  })

  it('a pointer that never leaves (or a keyboard press) is let through once the hover rule ends (army 11 a1 F-12)', () => {
    const g = new FreshButtonGuard()
    g.observe(['approve'], 0)
    g.observe(['fusion-submitted'], 1000)
    // The click on Approve left the pointer on the spot where the new button appeared.
    g.enter('fusion-submitted', 1010)
    expect(g.press('fusion-submitted', 1000 + FRESH_BUTTON_MS + 500)).toBe(false)
    expect(g.inert('fusion-submitted', 1000 + FRESH_HOVER_MAX_MS - 1)).toBe(true)
    expect(g.inert('fusion-submitted', 1000 + FRESH_HOVER_MAX_MS)).toBe(false)
    expect(g.press('fusion-submitted', 1000 + FRESH_HOVER_MAX_MS + 1)).toBe(true)
  })

  it('ids compare case-blind and a gone button is forgotten', () => {
    const g = new FreshButtonGuard()
    g.observe(['A'], 0)
    g.observe(['a', 'B'], 10)
    expect(g.press('a', 20)).toBe(true)
    g.observe(['a'], 30)
    expect(g.inert('b', 40)).toBe(false)
  })
})

describe('forward-move brief warnings (army6 D6)', () => {
  it('only warn and danger lines make Submit ask', () => {
    expect(
      briefWarnings([
        { label: 'Forecast', text: 'Over $55,000 — above the requisition', tone: 'warn' },
        { label: 'Spend', text: 'ok', tone: 'ok' },
        { label: 'X', text: 'y' }
      ]).map((l) => l.label)
    ).toEqual(['Forecast'])
    expect(briefWarnings(null)).toEqual([])
  })
})

describe('a move refused while someone else edits (army 11 f4 M4)', () => {
  const body = {
    error: 'Bernard Kelly is editing this record right now. If you Submit now, …',
    code: 'RECORD_LOCKED',
    locked_by_name: 'Bernard Kelly',
    move_anyway: true
  }
  it('offers to move anyway in both client error shapes', () => {
    for (const e of [{ status: 409, response: body }, { response: { data: body } }]) {
      const offer = lockedMoveOffer(e)
      expect(offer?.holder).toBe('Bernard Kelly')
      expect(offer?.message).toContain('Bernard Kelly is editing')
    }
  })
  it('a plain record-lock refusal (a save) and other codes offer nothing', () => {
    expect(lockedMoveOffer({ response: { ...body, move_anyway: undefined } })).toBeNull()
    expect(lockedMoveOffer({ response: { code: 'EDIT_LOCKED', move_anyway: true } })).toBeNull()
    expect(lockedMoveOffer(new Error('x'))).toBeNull()
  })
})
