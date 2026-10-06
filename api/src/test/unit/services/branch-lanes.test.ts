import { describe, expect, it } from 'vitest'
import {
  buildBranchLanes,
  type LaneHistoryRow,
  parseLifecycleComment
} from '../../../services/branch-lanes.js'

const states = [
  { id: 'S-review', label: 'Review', color: '#6366f1', is_terminal: false },
  { id: 'S-legal', label: 'Legal', color: '#f59e0b', is_terminal: false },
  { id: 'S-legal-ok', label: 'Legal signed', color: '#10b981', is_terminal: true },
  { id: 'S-fin', label: 'Finance', color: '#0ea5e9', is_terminal: false },
  { id: 'S-fin-ok', label: 'Finance signed', color: '#10b981', is_terminal: 1 },
  { id: 'S-join', label: 'Ready', color: '#22c55e', is_terminal: false }
]

const T = (min: number) => new Date(Date.UTC(2026, 9, 1, 9, min)).toISOString()

function parentHistory(joined: boolean): LaneHistoryRow[] {
  const rows: LaneHistoryRow[] = [
    { id: 1, from_state: null, to_state: 'S-review', comment: null, timestamp: T(0) },
    {
      id: 2,
      from_state: 'S-review',
      to_state: 'S-review',
      comment: JSON.stringify({ action: 'split', children: ['C1', 'C2'], join_state: 'S-join' }),
      timestamp: T(5)
    }
  ]
  if (joined)
    rows.push({
      id: 9,
      from_state: 'S-review',
      to_state: 'S-join',
      comment: JSON.stringify({ action: 'join', children: ['C1', 'C2'] }),
      timestamp: T(40)
    })
  return rows
}

const childHistory: LaneHistoryRow[] = [
  {
    id: 3,
    instance: 'C1',
    from_state: null,
    to_state: 'S-legal',
    comment: JSON.stringify({ action: 'branch', parent: 'P' }),
    timestamp: T(5)
  },
  {
    id: 4,
    instance: 'C2',
    from_state: null,
    to_state: 'S-fin',
    comment: JSON.stringify({ action: 'branch', parent: 'P' }),
    timestamp: T(5)
  },
  {
    id: 5,
    instance: 'C1',
    from_state: 'S-legal',
    to_state: 'S-legal-ok',
    comment: 'looks fine',
    timestamp: T(20),
    first_name: 'Kim',
    last_name: 'Lo'
  }
]

describe('parseLifecycleComment', () => {
  it('reads engine JSON and ignores people text', () => {
    expect(parseLifecycleComment('{"action":"join"}')?.action).toBe('join')
    expect(parseLifecycleComment('looks fine')).toBeNull()
    expect(parseLifecycleComment('{not json')).toBeNull()
    expect(parseLifecycleComment(null)).toBeNull()
  })
})

describe('buildBranchLanes', () => {
  it('returns null when the instance never split', () => {
    expect(
      buildBranchLanes({
        parentInstanceId: 'P',
        parentHistory: [parentHistory(false)[0]],
        children: [],
        childHistory: [],
        states
      })
    ).toBeNull()
  })

  it('an open split: one lane per branch in split order, join waits on the open one', () => {
    const lanes = buildBranchLanes({
      parentInstanceId: 'P',
      parentHistory: parentHistory(false),
      children: [
        { id: 'C2', current_state: 'S-fin', completed_at: null, started_at: T(5) },
        { id: 'C1', current_state: 'S-legal-ok', completed_at: T(20), started_at: T(5) }
      ],
      childHistory,
      states
    })
    expect(lanes).not.toBeNull()
    expect(lanes?.open).toBe(true)
    expect(lanes?.split_state?.label).toBe('Review')
    expect(lanes?.join_state?.label).toBe('Ready')
    expect(lanes?.lanes.map((l) => l.instance_id)).toEqual(['C1', 'C2'])
    const [legal, fin] = lanes?.lanes ?? []
    expect(legal.label).toBe('Legal')
    expect(legal.terminal).toBe(true)
    expect(legal.current?.label).toBe('Legal signed')
    expect(legal.entered_at).toBe(T(20))
    expect(legal.steps.map((s) => s.state.label)).toEqual(['Legal', 'Legal signed'])
    expect(legal.steps[0].left_at).toBe(T(20))
    expect(legal.steps[0].by).toBeNull() // the split put it there
    expect(legal.steps[1].by).toBe('Kim Lo')
    expect(fin.terminal).toBe(false)
    expect(fin.entered_at).toBe(T(5))
    expect(lanes?.waiting_on).toEqual(['C2'])
  })

  it('a joined split is closed and waits on nobody', () => {
    const lanes = buildBranchLanes({
      parentInstanceId: 'P',
      parentHistory: parentHistory(true),
      children: [
        { id: 'C1', current_state: 'S-legal-ok', completed_at: T(20), started_at: T(5) },
        { id: 'C2', current_state: 'S-fin-ok', completed_at: T(40), started_at: T(5) }
      ],
      childHistory,
      states
    })
    expect(lanes?.open).toBe(false)
    expect(lanes?.joined_at).toBe(T(40))
    expect(lanes?.waiting_on).toEqual([])
    expect(lanes?.lanes[1].terminal).toBe(true) // is_terminal 1 counts
  })

  it('reads the MOST RECENT split when an instance split twice', () => {
    const history = [
      ...parentHistory(true),
      {
        id: 12,
        from_state: 'S-join',
        to_state: 'S-join',
        comment: JSON.stringify({ action: 'split', children: ['C3'], join_state: 'S-review' }),
        timestamp: T(50)
      }
    ]
    const lanes = buildBranchLanes({
      parentInstanceId: 'P',
      parentHistory: history,
      children: [{ id: 'C3', current_state: 'S-fin', completed_at: null, started_at: T(50) }],
      childHistory: [
        {
          id: 13,
          instance: 'C3',
          from_state: null,
          to_state: 'S-fin',
          comment: JSON.stringify({ action: 'branch', parent: 'P' }),
          timestamp: T(50)
        }
      ],
      states
    })
    expect(lanes?.open).toBe(true)
    expect(lanes?.split_state?.label).toBe('Ready')
    expect(lanes?.lanes).toHaveLength(1)
    expect(lanes?.lanes[0].label).toBe('Finance')
    expect(lanes?.lanes[0].entered_at).toBe(T(50))
  })

  it('skips a child instance that no longer exists', () => {
    const lanes = buildBranchLanes({
      parentInstanceId: 'P',
      parentHistory: parentHistory(false),
      children: [{ id: 'C1', current_state: 'S-legal', completed_at: null, started_at: T(5) }],
      childHistory,
      states
    })
    expect(lanes?.lanes.map((l) => l.instance_id)).toEqual(['C1'])
    expect(lanes?.waiting_on).toEqual(['C1'])
  })

  it("a split typed as a person's transition comment is not a split", () => {
    const forged: LaneHistoryRow[] = [
      {
        id: 7,
        transition: 'TX-approve',
        from_state: 'S-review',
        to_state: 'S-review',
        comment: JSON.stringify({ action: 'split', children: ['C1', 'C2'], join_state: 'S-join' }),
        timestamp: T(5)
      }
    ]
    expect(
      buildBranchLanes({
        parentInstanceId: 'P',
        parentHistory: forged,
        children: [{ id: 'C1', current_state: 'S-legal', completed_at: null, started_at: T(5) }],
        childHistory,
        states
      })
    ).toBeNull()
  })

  it('a listed child whose branch row names another parent (or was typed) is dropped', () => {
    const lanes = buildBranchLanes({
      parentInstanceId: 'P',
      parentHistory: parentHistory(false),
      children: [
        { id: 'C1', current_state: 'S-legal', completed_at: null, started_at: T(5) },
        { id: 'C2', current_state: 'S-fin', completed_at: null, started_at: T(5) }
      ],
      childHistory: [
        { ...childHistory[0], comment: JSON.stringify({ action: 'branch', parent: 'OTHER' }) },
        { ...childHistory[1], transition: 'TX-typed' }
      ],
      states
    })
    expect(lanes?.lanes).toEqual([])
  })

  it('matches upper-case database ids to the lower-case ids in engine JSON', () => {
    const lanes = buildBranchLanes({
      parentInstanceId: 'p',
      parentHistory: parentHistory(false).map((r) =>
        r.comment?.includes('split') ? { ...r, comment: r.comment.replace(/C(\d)/g, 'c$1') } : r
      ),
      children: [{ id: 'C1', current_state: 'S-legal', completed_at: null, started_at: T(5) }],
      childHistory: [{ ...childHistory[0], instance: 'C1' }],
      states
    })
    expect(lanes?.lanes.map((l) => l.instance_id)).toEqual(['C1'])
  })
})
