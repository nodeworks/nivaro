import { describe, expect, it } from 'vitest'
import { applyLayoutOps, type GroupRow, type LayoutBundle, newGroup } from '../../../lib/layout-ops'
import { abRows, betterSide } from './AbTestSection'
import { rateText, suggestCollapse } from './suggest-collapse'

const group = (key: string, sort: number, extra: Partial<GroupRow> = {}) =>
  ({
    ...newGroup(key, key.toUpperCase(), 'section', null),
    id: sort + 1,
    sort,
    ...extra
  }) as GroupRow

const bundle = (groups: GroupRow[], layout: Record<string, unknown> = {}): LayoutBundle => ({
  layout: { id: 1, collection: 'orders', ...layout },
  rev: 'r1',
  groups,
  placements: []
})

const use = (key: string, shown: number, opened: number) => ({ key, shown, opened })

describe('suggestCollapse (#2730)', () => {
  const groups = [group('basics', 0), group('notes', 1), group('audit', 2), group('extra', 3)]

  it('suggests open sections people rarely open, never the first one', () => {
    const out = suggestCollapse(bundle(groups), [
      use('basics', 100, 0),
      use('notes', 100, 40),
      use('audit', 200, 4),
      use('extra', 50, 5)
    ])
    expect(out.candidates.map((c) => c.key)).toEqual(['audit', 'extra'])
    expect(out.ops).toEqual([
      { op: 'group_update', key: 'audit', patch: { is_collapsed: true } },
      { op: 'group_update', key: 'extra', patch: { is_collapsed: true } }
    ])
    // One undoable change that the ops apply cleanly.
    const after = applyLayoutOps(bundle(groups), out.ops)
    expect(after.groups.filter((g) => g.is_collapsed).map((g) => g.key)).toEqual(['audit', 'extra'])
  })

  it('needs enough visits and skips collapsed sections, tabs and accordion forms', () => {
    const gs = [
      group('basics', 0),
      group('few', 1),
      group('shut', 2, { is_collapsed: true }),
      group('tab', 3, { type: 'tab' })
    ]
    const sections = [use('few', 19, 0), use('shut', 100, 0), use('tab', 100, 0)]
    expect(suggestCollapse(bundle(gs), sections).candidates).toEqual([])
    expect(
      suggestCollapse(bundle(groups, { accordion_mode: true }), [use('audit', 100, 0)]).candidates
    ).toEqual([])
  })

  it('judges the first section per step', () => {
    const gs = [
      group('step1', 0, { type: 'tab' }),
      group('a', 1, { parent_key: 'step1' }),
      group('b', 2, { parent_key: 'step1' })
    ]
    const out = suggestCollapse(bundle(gs), [use('a', 100, 0), use('b', 100, 0)])
    expect(out.candidates.map((c) => c.key)).toEqual(['b'])
  })

  it('words the rate', () => {
    expect(rateText(0)).toBe('none')
    expect(rateText(0.004)).toBe('under 1%')
    expect(rateText(0.04)).toBe('4%')
  })
})

describe('A/B results rows (#2614)', () => {
  const arm = (over: Record<string, unknown>) => ({
    layout_id: 1,
    half: 'a' as const,
    people: 10,
    opens: 40,
    saves: 30,
    abandons: 4,
    save_rate: 0.75,
    avg_save_ms: 60_000,
    timed_saves: 30,
    created: 20,
    edited_after_save: 5,
    edits_per_record: 0.5,
    ...over
  })
  it('marks the better side by direction', () => {
    const rows = abRows({
      ready: true,
      since: '2026-10-01T00:00:00Z',
      a: arm({}),
      b: arm({ half: 'b', save_rate: 0.9, avg_save_ms: 90_000, edited_after_save: 2 })
    })
    const by = (label: string) => rows.find((r) => r.label === label)!
    expect(betterSide(by('Saved'))).toBe('b')
    expect(betterSide(by('Time to save'))).toBe('a')
    expect(betterSide(by('Edited again within a day'))).toBe('b')
    expect(betterSide(by('Left unfinished'))).toBeNull()
    expect(betterSide(by('Opened'))).toBeNull()
    expect(by('Edited again within a day').b).toBe('10%')
    expect(by('Edited again within a day').tipB).toBe('2 of 20 records')
  })
})
