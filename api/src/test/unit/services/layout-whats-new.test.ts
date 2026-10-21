import { describe, expect, it } from 'vitest'
import {
  diffForPeople,
  pickBaseVersion,
  summarizeOps,
  whatsNewCount,
  whatsNewLines
} from '../../../services/layout-whats-new.js'

const label = (field: string, p: Record<string, unknown>) =>
  (p.label_override as string) || field.toUpperCase()

const snap = (
  groups: Array<[string, string]>,
  assignments: Array<[string, string | null, Record<string, unknown>?]>
) => ({
  groups: groups.map(([key, l], i) => ({ id: i + 1, key, label: l })),
  assignments: assignments.map(([field, group_key, extra], i) => ({
    field,
    group_key,
    sort: i,
    ...(extra ?? {})
  }))
})

describe('diffForPeople', () => {
  it('names added, removed and moved fields and section changes', () => {
    const from = snap(
      [
        ['main', 'Main'],
        ['old', 'Legacy']
      ],
      [
        ['title', 'main'],
        ['due', 'main'],
        ['notes', 'old']
      ]
    )
    const to = snap(
      [
        ['main', 'Overview'],
        ['sched', 'Schedule']
      ],
      [
        ['title', 'main'],
        ['due', 'sched'],
        ['budget', 'main', { label_override: 'Budget code' }]
      ]
    )
    const w = diffForPeople(from, to, { label })
    expect(w.added).toEqual(['Budget code'])
    expect(w.removed).toEqual(['NOTES'])
    expect(w.moved).toEqual([{ field: 'DUE', to: 'Schedule' }])
    expect(w.sections_added).toEqual(['Schedule'])
    expect(w.sections_removed).toEqual(['Legacy'])
    expect(w.sections_renamed).toEqual([{ from: 'Main', to: 'Overview' }])
    expect(whatsNewCount(w)).toBe(6)
    const lines = whatsNewLines(w)
    expect(lines[0]).toBe('New: Budget code')
    expect(lines).toContain('DUE moved to Schedule')
    expect(lines).toContain('No longer on the form: NOTES')
  })

  it('never names a field the reader cannot read, slots, or hidden placements', () => {
    const from = snap([['main', 'Main']], [['title', 'main']])
    const to = snap(
      [['main', 'Main']],
      [
        ['title', 'main'],
        ['salary', 'main'],
        ['__pipeline__', 'main'],
        ['ghost', 'main', { is_visible: false }]
      ]
    )
    const w = diffForPeople(from, to, { label, mayRead: (f) => f !== 'salary' })
    expect(whatsNewCount(w)).toBe(0)
    expect(whatsNewLines(w)).toEqual([])
  })

  it('caps long lists', () => {
    const to = snap(
      [['main', 'Main']],
      ['a', 'b', 'c', 'd', 'e', 'f'].map((f) => [f, 'main'] as [string, string])
    )
    const lines = whatsNewLines(diffForPeople(snap([['main', 'Main']], []), to, { label }))
    expect(lines[0]).toBe('New: A, B, C, D and 2 more')
  })
})

describe('pickBaseVersion', () => {
  const versions = [
    { id: 1, hash: 'h1', created_at: '2026-10-01T10:00:00Z' },
    { id: 2, hash: 'h2', created_at: '2026-10-05T10:00:00Z' },
    { id: 3, hash: 'h3', created_at: '2026-10-09T10:00:00Z' }
  ]
  it('prefers the version that hashes to the seen state', () => {
    expect(pickBaseVersion(versions, { rev: 'h2', at: '2026-10-08T00:00:00Z' })?.id).toBe(2)
  })
  it('else the oldest version taken after the person looked', () => {
    expect(pickBaseVersion(versions, { rev: 'zz', at: '2026-10-04T00:00:00Z' })?.id).toBe(2)
  })
  it('else none', () => {
    expect(pickBaseVersion(versions, { rev: 'zz', at: '2026-10-10T00:00:00Z' })).toBeNull()
    expect(pickBaseVersion(versions, { rev: 'zz', at: 'not a date' })).toBeNull()
  })
})

describe('summarizeOps', () => {
  it('counts what a batch did', () => {
    expect(
      summarizeOps([{ op: 'move' }, { op: 'move' }, { op: 'group_create' }, { op: 'bogus' }])
    ).toBe('2 fields moved, 1 section added')
    expect(summarizeOps([])).toBe('changes saved')
  })
})
