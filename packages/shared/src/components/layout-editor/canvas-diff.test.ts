import { describe, expect, it } from 'vitest'
import {
  type GroupRow,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow,
  ungroupedGroup
} from '../../lib/layout-ops'
import { canvasDiff, diffSummary } from './canvas-diff'

const group = (key: string, sort: number, extra: Partial<GroupRow> = {}): GroupRow => ({
  ...newGroup(key, key[0].toUpperCase() + key.slice(1), 'section', null),
  sort,
  ...extra
})
const placed = (
  field: string,
  groupKey: string | null,
  sort: number,
  extra = {}
): PlacementRow => ({
  ...newPlacement(field, groupKey),
  sort,
  ...extra
})
const bundle = (groups: GroupRow[], placements: PlacementRow[], layout = {}): LayoutBundle => ({
  layout: { id: 1, collection: 'orders', name: 'Main', layout_type: 'grouped', ...layout },
  groups: [...groups, ungroupedGroup(groups.length)],
  placements,
  rev: 'r'
})
const fieldsIn = (b: LayoutBundle, key: string) =>
  b.placements
    .filter((p) => p.group_key === key)
    .sort((a, c) => a.sort - c.sort)
    .map((p) => p.field)

describe('canvasDiff', () => {
  const before = bundle(
    [group('main', 0), group('money', 1)],
    [
      placed('title', 'main', 0),
      placed('status', 'main', 1),
      placed('notes', 'main', 2),
      placed('amount', 'money', 0)
    ]
  )

  it('marks added, moved (with the section it came from), changed and removed', () => {
    const after = bundle(
      [group('main', 0, { label: 'Basics' }), group('money', 1)],
      [
        placed('title', 'main', 0, { col_span: 12 }),
        placed('notes', 'main', 1),
        placed('amount', 'money', 0),
        placed('status', 'money', 1),
        placed('owner', 'money', 2)
      ]
    )
    const d = canvasDiff(before, after)
    expect(d.marks.get('field:owner:money')).toEqual({ kind: 'added' })
    expect(d.marks.get('field:status:money')).toEqual({ kind: 'moved', detail: 'from Main' })
    expect(d.marks.get('field:title:main')).toEqual({ kind: 'changed', detail: 'col_span' })
    expect(d.marks.get('group:main')).toEqual({ kind: 'changed', detail: 'label' })
    expect(d.marks.has('field:notes:main')).toBe(false)
    expect(d.counts).toEqual({ added: 1, moved: 1, removed: 0, changed: 2 })
  })

  it('puts removed fields back where they were, as ghosts', () => {
    const after = bundle(
      [group('main', 0), group('money', 1)],
      [placed('title', 'main', 0), placed('notes', 'main', 1), placed('amount', 'money', 0)]
    )
    const d = canvasDiff(before, after)
    expect(d.marks.get('field:status:main')).toEqual({ kind: 'removed' })
    expect(fieldsIn(d.bundle, 'main')).toEqual(['title', 'status', 'notes'])
    expect(diffSummary(d)).toBe('1 removed')
  })

  it('brings a removed section back with its fields', () => {
    const after = bundle(
      [group('main', 0)],
      before.placements.filter((p) => p.group_key === 'main')
    )
    const d = canvasDiff(before, after)
    expect(d.marks.get('group:money')).toEqual({ kind: 'removed' })
    expect(d.marks.get('field:amount:money')).toEqual({ kind: 'removed' })
    expect(d.bundle.groups.map((g) => g.key)).toContain('money')
    expect(fieldsIn(d.bundle, 'money')).toEqual(['amount'])
  })

  it('nothing differs: no marks, no summary; form settings are counted', () => {
    expect(diffSummary(canvasDiff(before, before))).toBeNull()
    const renamed = { ...before, layout: { ...before.layout, name: 'Other' } }
    const d = canvasDiff(before, renamed)
    expect(d.settings).toEqual(['name'])
    expect(diffSummary(d)).toBe('1 form setting')
  })

  it('treats stored JSON text and the same object as equal', () => {
    const a = bundle([group('main', 0)], [placed('title', 'main', 0, { overrides: '{"x":1}' })])
    const b = bundle([group('main', 0)], [placed('title', 'main', 0, { overrides: { x: 1 } })])
    expect(canvasDiff(a, b).marks.size).toBe(0)
  })
})
