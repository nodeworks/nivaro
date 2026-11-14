import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: {} }))
vi.mock('../../../services/pipeline-engine.js', () => ({ resolveStateOwnersBatch: vi.fn() }))

import { computeStepTiming, type TimingVisit } from '../../../services/step-timing.js'

const H = 3_600_000
const T0 = Date.UTC(2026, 10, 2, 13, 0)
const at = (hours: number) => T0 + hours * H

const visit = (v: Partial<TimingVisit> & Pick<TimingVisit, 'id' | 'state' | 'entered_at'>) => ({
  left_at: null,
  entered_by: 'MOVER',
  left_by: null,
  terminal: false,
  ...v
})

describe('computeStepTiming', () => {
  it('splits a visit at the first owner touch', () => {
    const [t] = computeStepTiming({
      visits: [
        visit({ id: 1, state: 'S-REVIEW', entered_at: at(0), left_at: at(51), left_by: 'ana' })
      ],
      touches: [
        // Someone who does not own the step does not end the wait.
        { user: 'stranger', at: at(1), kind: 'comment' },
        { user: 'ANA', at: at(48), kind: 'comment' },
        { user: 'ana', at: at(49), kind: 'edit' }
      ],
      ownersByState: new Map([['s-review', ['ana']]]),
      views: new Map(),
      now: at(100)
    })
    expect(t.waiting_ms).toBe(48 * H)
    expect(t.working_ms).toBe(3 * H)
    expect(t.first_touch_kind).toBe('comment')
    expect(t.current).toBe(false)
    expect(t.owners_known).toBe(true)
  })

  it('a move out with no touch before it is all waiting ("decided at once")', () => {
    const [t] = computeStepTiming({
      visits: [visit({ id: 1, state: 'S', entered_at: at(0), left_at: at(5), left_by: 'ana' })],
      touches: [],
      ownersByState: new Map([['S', ['ana']]]),
      views: new Map(),
      now: at(10)
    })
    expect(t.waiting_ms).toBe(5 * H)
    expect(t.working_ms).toBe(0)
    expect(t.first_touch_kind).toBe('move')
  })

  it('whoever moves it out counts as an owner of the visit (their earlier comment too)', () => {
    const [t] = computeStepTiming({
      visits: [visit({ id: 1, state: 'S', entered_at: at(0), left_at: at(10), left_by: 'admin' })],
      touches: [{ user: 'admin', at: at(4), kind: 'comment' }],
      ownersByState: new Map(),
      views: new Map(),
      now: at(20)
    })
    expect(t.waiting_ms).toBe(4 * H)
    expect(t.working_ms).toBe(6 * H)
  })

  it('send-back loops: every visit is timed on its own', () => {
    const visits = [
      visit({
        id: 1,
        state: 'DRAFT',
        entered_at: at(0),
        left_at: at(2),
        left_by: 'req',
        entered_by: 'req'
      }),
      visit({
        id: 2,
        state: 'REVIEW',
        entered_at: at(2),
        left_at: at(30),
        left_by: 'ana',
        entered_by: 'req'
      }),
      // sent back
      visit({
        id: 3,
        state: 'DRAFT',
        entered_at: at(30),
        left_at: at(40),
        left_by: 'req',
        entered_by: 'ana'
      }),
      visit({ id: 4, state: 'REVIEW', entered_at: at(40), left_at: null, entered_by: 'req' })
    ]
    const timing = computeStepTiming({
      visits,
      touches: [
        { user: 'ana', at: at(20), kind: 'comment' }, // first review visit
        { user: 'req', at: at(36), kind: 'edit' }, // fixing it in draft
        { user: 'ana', at: at(44), kind: 'edit' } // second review visit
      ],
      ownersByState: new Map([
        ['DRAFT', ['req']],
        ['REVIEW', ['ana']]
      ]),
      views: new Map(),
      now: at(50)
    })
    expect(timing.map((t) => t.history_id)).toEqual([1, 2, 3, 4])
    const byId = new Map(timing.map((t) => [t.history_id, t]))
    // Visit 1: the requester moved it on right away — the move itself.
    expect(byId.get(1)?.waiting_ms).toBe(2 * H)
    // Visit 2: waited 18 h, worked 10 h.
    expect(byId.get(2)?.waiting_ms).toBe(18 * H)
    expect(byId.get(2)?.working_ms).toBe(10 * H)
    // Visit 3 (back in draft): waited 6 h, worked 4 h — not merged with visit 1.
    expect(byId.get(3)?.waiting_ms).toBe(6 * H)
    expect(byId.get(3)?.working_ms).toBe(4 * H)
    // Visit 4 is open: 4 h waiting, 6 h working so far.
    expect(byId.get(4)?.current).toBe(true)
    expect(byId.get(4)?.waiting_ms).toBe(4 * H)
    expect(byId.get(4)?.working_ms).toBe(6 * H)
  })

  it("the mover-out's own writes just before their move are part of the move", () => {
    const [t] = computeStepTiming({
      visits: [visit({ id: 1, state: 'S', entered_at: at(0), left_at: at(6), left_by: 'ana' })],
      touches: [{ user: 'ana', at: at(6) - 500, kind: 'edit' }],
      ownersByState: new Map([['S', ['ana']]]),
      views: new Map(),
      now: at(9)
    })
    expect(t.first_touch_kind).toBe('move')
    expect(t.waiting_ms).toBe(6 * H)
    expect(t.working_ms).toBe(0)
  })

  it('the mover-in is not working during the entry grace, but counts after it', () => {
    const visits = [visit({ id: 1, state: 'S', entered_at: at(0), entered_by: 'kim' })]
    const owners = new Map([['S', ['kim']]])
    const early = computeStepTiming({
      visits,
      touches: [{ user: 'kim', at: at(0) + 2_000, kind: 'edit' }],
      ownersByState: owners,
      views: new Map(),
      now: at(3)
    })[0]
    expect(early.first_touch_at).toBeNull()
    expect(early.waiting_ms).toBe(3 * H)
    const later = computeStepTiming({
      visits,
      touches: [{ user: 'kim', at: at(1), kind: 'edit' }],
      ownersByState: owners,
      views: new Map(),
      now: at(3)
    })[0]
    expect(later.waiting_ms).toBe(1 * H)
    expect(later.working_ms).toBe(2 * H)
  })

  it('an owner opening the record ends the wait; a view outside the visit does not', () => {
    const [t] = computeStepTiming({
      visits: [visit({ id: 1, state: 'S', entered_at: at(10), left_at: at(20), left_by: 'ana' })],
      touches: [{ user: 'ana', at: at(15), kind: 'edit' }],
      ownersByState: new Map([['S', ['ana']]]),
      views: new Map([['ANA', { prev: at(5), last: at(12) }]]),
      now: at(30)
    })
    expect(t.first_touch_kind).toBe('view')
    expect(t.waiting_ms).toBe(2 * H)
    expect(t.working_ms).toBe(8 * H)
  })

  it('a step nobody owns is all waiting and says so; terminal visits are not timed', () => {
    const timing = computeStepTiming({
      visits: [
        visit({ id: 1, state: 'S', entered_at: at(0), left_at: at(4), left_by: null }),
        visit({ id: 2, state: 'DONE', entered_at: at(4), terminal: true })
      ],
      touches: [{ user: 'x', at: at(1), kind: 'edit' }],
      ownersByState: new Map(),
      views: new Map(),
      completedAt: at(4),
      now: at(9)
    })
    expect(timing).toHaveLength(1)
    expect(timing[0].owners_known).toBe(false)
    expect(timing[0].waiting_ms).toBe(4 * H)
    expect(timing[0].working_ms).toBe(0)
  })
})
