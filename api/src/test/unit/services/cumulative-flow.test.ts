import { describe, expect, it } from 'vitest'
import {
  type CfdDelta,
  type CfdState,
  enumerateDays,
  foldDeltas,
  parseCfdParams,
  rebase,
  summarize
} from '../../../services/cumulative-flow.js'

const states: CfdState[] = [
  { id: 'a', key: 'draft', label: 'Draft', color: null, sort: 1, is_terminal: false },
  { id: 'b', key: 'review', label: 'Review', color: null, sort: 2, is_terminal: false },
  { id: 'c', key: 'done', label: 'Done', color: null, sort: 3, is_terminal: true }
]
const days = ['2026-10-01', '2026-10-02', '2026-10-03']

describe('foldDeltas', () => {
  it('starts from the baseline and sums end-of-day counts', () => {
    const deltas: CfdDelta[] = [
      { state: 'a', day: null, delta: 3 },
      { state: 'a', day: '2026-10-02', delta: -1 },
      { state: 'b', day: '2026-10-02', delta: 1 },
      { state: 'b', day: '2026-10-03', delta: -1 },
      { state: 'c', day: '2026-10-03', delta: 1 }
    ]
    const out = foldDeltas(deltas, days, states)
    expect(out.map((d) => d.counts)).toEqual([
      { a: 3, b: 0, c: 0 },
      { a: 2, b: 1, c: 0 },
      { a: 2, b: 0, c: 1 }
    ])
    expect(out.map((d) => d.total)).toEqual([3, 3, 3])
  })
})

describe('summarize', () => {
  it('derives arrivals, done, average WIP and Little lead time', () => {
    const folded = foldDeltas(
      [
        { state: 'a', day: '2026-10-01', delta: 2 },
        { state: 'a', day: '2026-10-02', delta: 2 },
        { state: 'a', day: '2026-10-03', delta: -2 },
        { state: 'c', day: '2026-10-03', delta: 2 }
      ],
      days,
      states
    )
    const s = summarize(folded, states)
    expect(s.arrivals).toBe(2)
    expect(s.done).toBe(2)
    expect(s.lead_time_days).not.toBeNull()
  })
  it('has no lead time when nothing finished', () => {
    const folded = foldDeltas([{ state: 'a', day: '2026-10-01', delta: 1 }], days, states)
    expect(summarize(folded, states).lead_time_days).toBeNull()
    expect(summarize([], states).avg_wip).toBe(0)
  })
})

describe('rebase / enumerateDays / parseCfdParams', () => {
  it('collapses deltas dated before the new start into the baseline', () => {
    const out = rebase(
      [
        { state: 'a', day: '2026-09-01', delta: 1 },
        { state: 'a', day: '2026-10-02', delta: 1 }
      ],
      '2026-10-01'
    )
    expect(out.map((d) => d.day)).toEqual([null, '2026-10-02'])
  })
  it('lists whole days inclusive', () => {
    expect(
      enumerateDays(new Date('2026-10-01T10:00:00Z'), new Date('2026-10-03T01:00:00Z'))
    ).toEqual(days)
  })
  it('validates template, collection and range', () => {
    expect(parseCfdParams({}).ok).toBe(false)
    expect(parseCfdParams({ template: 'abcdef12-0000', collection: 'nivaro_users' }).ok).toBe(false)
    expect(
      parseCfdParams({ template: 'abcdef12-0000', from: '2020-01-01', to: '2026-01-01' }).ok
    ).toBe(false)
    expect(parseCfdParams({ template: 'abcdef12-0000' }).ok).toBe(true)
  })
})
