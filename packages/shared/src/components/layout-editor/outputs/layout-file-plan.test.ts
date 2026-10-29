import { describe, expect, it } from 'vitest'
import {
  applyLayoutOps,
  type GroupRow,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow,
  ungroupedGroup
} from '../../../lib/layout-ops'
import { differences, type FileTarget, planFileOps } from './layout-file-plan'

const group = (key: string, extra: Partial<GroupRow> = {}): GroupRow => ({
  ...newGroup(key, key[0].toUpperCase() + key.slice(1), 'section', null),
  ...extra
})
const place = (
  field: string,
  group_key: string | null,
  sort: number,
  extra: Partial<PlacementRow> = {}
): PlacementRow => ({ ...newPlacement(field, group_key), sort, ...extra })

const current = (): LayoutBundle => ({
  layout: { id: 7, collection: 'orders', name: 'Order form', layout_type: 'grouped' },
  groups: [
    group('basics', { sort: 0 }),
    group('extra', { sort: 1 }),
    group('old', { sort: 2 }),
    ungroupedGroup(3)
  ],
  placements: [
    place('title', 'basics', 0, { id: 1 }),
    place('vendor', 'basics', 1, { id: 2 }),
    place('memo', 'extra', 0, { id: 3 }),
    place('gone', 'old', 0, { id: 4 }),
    place('status', null, 0, { id: 5 }),
    place('__pipeline__', null, 4, { id: 6 })
  ],
  rev: 'r1'
})

const target = (): FileTarget => ({
  layout: { name: 'Order form', tab_mode: 'steps' },
  groups: [
    group('basics', { sort: 1, label: 'Basics and vendor' }),
    // A section turns into a tabs holder with a new tab, and memo moves into it.
    group('extra', { sort: 0, type: 'container' }),
    group('details', { type: 'tab', parent_key: 'extra', sort: 0, is_collapsed: true }),
    { ...ungroupedGroup(3) },
    group('fresh', { sort: 2 })
  ],
  placements: [
    place('vendor', 'basics', 0, { col_span: 6 }),
    place('title', 'basics', 1),
    place('memo', 'details', 0),
    place('status', null, 0),
    place('added', 'fresh', 0, { is_visible: false }),
    place('__pipeline__', null, 4)
  ]
})

describe('layout file import plan (#3189)', () => {
  it('reaches the file’s layout, with nothing left over', () => {
    const plan = planFileOps(current(), target())
    expect(plan.remaining).toEqual([])
    const after = applyLayoutOps(current(), plan.ops)
    expect(differences(after, target())).toEqual([])
    expect(plan.ops.map((o) => o.op)).toContain('group_remove')
  })

  it('moves a field placed once on each side instead of removing it', () => {
    const plan = planFileOps(current(), target())
    const after = applyLayoutOps(current(), plan.ops)
    // memo keeps its row: moved, not removed and placed again.
    expect(after.placements.find((p) => p.field === 'memo')?.id).toBe(3)
    expect(plan.ops.some((o) => o.op === 'remove' && o.at.field === 'memo')).toBe(false)
    expect(after.placements.some((p) => p.field === 'gone')).toBe(false)
  })

  it('asks for nothing when the file matches the draft', () => {
    const b = current()
    const same: FileTarget = {
      layout: { name: 'Order form' },
      groups: b.groups,
      placements: b.placements
    }
    expect(planFileOps(b, same)).toMatchObject({ ops: [], remaining: [] })
  })

  it('says what it could not reach', () => {
    const t = target()
    // A field under a tabs holder itself is not a place a field can go.
    t.placements.push(place('stray', 'extra', 0))
    const plan = planFileOps(current(), t)
    expect(plan.remaining.some((r) => r.includes('stray'))).toBe(true)
  })
})
