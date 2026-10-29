import { describe, expect, it } from 'vitest'
import {
  applyLayoutOps,
  HEADER_GROUP_KEY,
  type LayoutBundle,
  newGroup,
  newPlacement,
  ungroupedGroup
} from '../../../lib/layout-ops'
import type { DesignTarget } from '../design-context'
import { PIN_KEY } from '../pin'
import { carriedTargets, copyAfterDrop, dropMany, manyLabel } from './multi-drop'

const bundle: LayoutBundle = {
  layout: { id: 1, collection: 'orders' },
  rev: 'r',
  groups: [
    { ...newGroup('g1', 'Details', 'section', null), sort: 0 },
    { ...newGroup('g2', 'Money', 'section', null), sort: 1 },
    ungroupedGroup(2)
  ],
  placements: [
    { ...newPlacement('a', 'g1'), sort: 0 },
    { ...newPlacement('b', 'g1'), sort: 1 },
    { ...newPlacement('c', 'g1'), sort: 2, col_span: 6 },
    { ...newPlacement('d', 'g2'), sort: 0 },
    { ...newPlacement('e', 'g2'), sort: 1 },
    { ...newPlacement('title', HEADER_GROUP_KEY), sort: 0 }
  ]
}

const f = (field: string, g: string | null): DesignTarget => ({
  kind: 'field',
  field,
  group_key: g
})
const zone = (b: LayoutBundle, g: string | null) =>
  b.placements
    .filter((p) => p.group_key === g)
    .sort((x, y) => x.sort - y.sort)
    .map((p) => p.field)

describe('carriedTargets', () => {
  it('a drag on one of several selected fields carries them all, in page order', () => {
    const sel = [f('c', 'g1'), f('d', 'g2'), f('a', 'g1')]
    expect(carriedTargets(bundle, sel, f('d', 'g2'))).toEqual([
      f('a', 'g1'),
      f('c', 'g1'),
      f('d', 'g2')
    ])
  })

  it('a drag outside the selection, or of a section, carries just what was grabbed', () => {
    const sel = [f('a', 'g1'), f('b', 'g1')]
    expect(carriedTargets(bundle, sel, f('d', 'g2'))).toEqual([f('d', 'g2')])
    const g: DesignTarget = { kind: 'group', key: 'g1' }
    expect(carriedTargets(bundle, sel, g)).toEqual([g])
    expect(carriedTargets(bundle, [f('a', 'g1')], f('a', 'g1'))).toEqual([f('a', 'g1')])
  })

  it('pinned fields stay behind', () => {
    const pinned: LayoutBundle = {
      ...bundle,
      placements: bundle.placements.map((p) =>
        p.field === 'b' ? { ...p, overrides: { [PIN_KEY]: true } } : p
      )
    }
    const sel = [f('a', 'g1'), f('b', 'g1'), f('c', 'g1')]
    expect(carriedTargets(pinned, sel, f('a', 'g1'))).toEqual([f('a', 'g1'), f('c', 'g1')])
  })
})

describe('dropMany', () => {
  it('moves the selection after a field in another section, order kept', () => {
    const ops = dropMany(bundle, [f('a', 'g1'), f('c', 'g1')], f('d', 'g2'), 'after', 'move')
    expect(ops).toEqual([
      { op: 'move', from: { field: 'a', group_key: 'g1' }, to_group_key: 'g2', index: 1 },
      { op: 'move', from: { field: 'c', group_key: 'g1' }, to_group_key: 'g2', index: 2 }
    ])
    const after = applyLayoutOps(bundle, ops)
    expect(zone(after, 'g2')).toEqual(['d', 'a', 'c', 'e'])
    expect(zone(after, 'g1')).toEqual(['b'])
  })

  it('gathers fields of one section next to each other', () => {
    const ops = dropMany(bundle, [f('a', 'g1'), f('c', 'g1')], f('b', 'g1'), 'before', 'move')
    expect(zone(applyLayoutOps(bundle, ops), 'g1')).toEqual(['a', 'c', 'b'])
  })

  it('lands first in a section dropped on its header', () => {
    const g2: DesignTarget = { kind: 'group', key: 'g2' }
    const ops = dropMany(bundle, [f('b', 'g1'), f('a', 'g1')], g2, 'before', 'move')
    expect(zone(applyLayoutOps(bundle, ops), 'g2')).toEqual(['b', 'a', 'd', 'e'])
  })

  it('does nothing dropped on one of the carried fields', () => {
    expect(dropMany(bundle, [f('a', 'g1'), f('b', 'g1')], f('b', 'g1'), 'after', 'move')).toEqual(
      []
    )
  })

  it('a twin the landing section already holds stays where it is', () => {
    const twin: LayoutBundle = {
      ...bundle,
      placements: [...bundle.placements, { ...newPlacement('a', 'g2'), sort: 2 }]
    }
    const ops = dropMany(twin, [f('a', 'g1'), f('b', 'g1')], f('d', 'g2'), 'after', 'move')
    expect(ops).toEqual([
      { op: 'move', from: { field: 'b', group_key: 'g1' }, to_group_key: 'g2', index: 1 }
    ])
  })

  it('copies the selection with their settings, the originals stay', () => {
    const ops = dropMany(bundle, [f('a', 'g1'), f('c', 'g1')], f('e', 'g2'), 'after', 'copy')
    const after = applyLayoutOps(bundle, ops)
    expect(zone(after, 'g1')).toEqual(['a', 'b', 'c'])
    expect(zone(after, 'g2')).toEqual(['d', 'e', 'a', 'c'])
    expect(after.placements.find((p) => p.field === 'c' && p.group_key === 'g2')?.col_span).toBe(6)
  })

  it('names the step', () => {
    expect(manyLabel([f('a', 'g1'), f('b', 'g1')], 'move')).toBe('Move 2 fields')
    expect(manyLabel([f('a', 'g1'), f('b', 'g1'), f('c', 'g1')], 'copy')).toBe('Copy 3 fields')
  })
})

describe('copyAfterDrop', () => {
  it('a field gets a second placement in another section, never pinned', () => {
    const pinned: LayoutBundle = {
      ...bundle,
      placements: bundle.placements.map((p) =>
        p.field === 'c' ? { ...p, overrides: { [PIN_KEY]: true, required: true } } : p
      )
    }
    const ops = copyAfterDrop(pinned, f('c', 'g1'), f('d', 'g2'), 'before')
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ op: 'place', field: 'c', group_key: 'g2', index: 0 })
    const patch = (ops[0] as { patch: { col_span: number; overrides: unknown } }).patch
    expect(patch.col_span).toBe(6)
    expect(patch.overrides).toEqual({ required: true })
  })

  it('refuses a field into the section that already holds it', () => {
    expect(copyAfterDrop(bundle, f('a', 'g1'), f('b', 'g1'), 'after')).toEqual([])
  })

  it('refuses header tiles (they show once)', () => {
    const t: DesignTarget = { kind: 'header', field: 'title' }
    expect(copyAfterDrop(bundle, t, t, 'after')).toEqual([])
  })

  it('a section is duplicated with its fields and the copy goes where it is dropped', () => {
    const ops = copyAfterDrop(
      bundle,
      { kind: 'group', key: 'g2' },
      { kind: 'group', key: 'g1' },
      'before'
    )
    const after = applyLayoutOps(bundle, ops)
    const top = after.groups
      .filter((g) => g.parent_key === null)
      .sort((x, y) => x.sort - y.sort)
      .map((g) => g.key)
    expect(top).toEqual(['g2_copy', 'g1', 'g2', '__ungrouped__'])
    expect(zone(after, 'g2_copy')).toEqual(['d', 'e'])
    expect(after.groups.find((g) => g.key === 'g2_copy')?.label).toBe('Money (copy)')
  })

  it('a section dropped over itself copies right after it', () => {
    const g1: DesignTarget = { kind: 'group', key: 'g1' }
    const after = applyLayoutOps(bundle, copyAfterDrop(bundle, g1, g1, 'after'))
    const top = after.groups
      .filter((g) => g.parent_key === null)
      .sort((x, y) => x.sort - y.sort)
      .map((g) => g.key)
    expect(top).toEqual(['g1', 'g1_copy', 'g2', '__ungrouped__'])
  })

  it('the Ungrouped zone is not copied', () => {
    const u: DesignTarget = { kind: 'group', key: '__ungrouped__' }
    expect(copyAfterDrop(bundle, u, { kind: 'group', key: 'g1' }, 'before')).toEqual([])
  })
})
