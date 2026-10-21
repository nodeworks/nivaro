import { describe, expect, it } from 'vitest'
import {
  type GroupRow,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow
} from '../../../lib/layout-ops'
import { appendStep, describeStep, type MacroStep, toMacroSteps } from './macro-record'

const group = (key: string, label: string, sort: number): GroupRow => ({
  ...newGroup(key, label, 'section', null),
  sort
})
const place = (field: string, gk: string | null, sort: number): PlacementRow => ({
  ...newPlacement(field, gk),
  sort
})
const bundle: LayoutBundle = {
  layout: { id: 1, collection: 'po', name: 'Form', layout_type: 'grouped' },
  groups: [group('g1', 'Main', 0), group('g2', 'Money', 1)],
  placements: [place('po_number', 'g1', 0), place('vendor', 'g1', 1), place('amount', 'g2', 0)],
  rev: 'r'
}

describe('toMacroSteps', () => {
  it('records a move as "after this field" in a section named by label', () => {
    const steps = toMacroSteps(bundle, [
      { op: 'move', from: { field: 'amount', group_key: 'g2' }, to_group_key: 'g1', index: 1 }
    ])
    expect(steps).toEqual([
      {
        op: 'move',
        field: 'amount',
        from: { key: 'g2', label: 'Money' },
        to: { key: 'g1', label: 'Main' },
        after: 'po_number'
      }
    ])
  })

  it('records a new section after the section before it, and follows a batch in order', () => {
    const steps = toMacroSteps(bundle, [
      {
        op: 'group_create',
        key: 'g_new',
        label: 'Fusion',
        group_type: 'section',
        parent_key: null,
        index: 1
      },
      { op: 'place', field: 'fusion_number', group_key: 'g_new', index: 0 }
    ])
    expect(steps[0]).toMatchObject({
      op: 'group_create',
      group: { key: 'g_new', label: 'Fusion' },
      after: { key: 'g1', label: 'Main' }
    })
    expect(steps[1]).toMatchObject({
      op: 'place',
      group: { key: 'g_new', label: 'Fusion' },
      after: null
    })
  })

  it('records nothing for a batch the engine refuses', () => {
    expect(
      toMacroSteps(bundle, [{ op: 'remove', at: { field: 'nope', group_key: null } }])
    ).toEqual([])
  })
})

describe('appendStep', () => {
  const width = (n: number): MacroStep => ({
    op: 'update_placement',
    field: 'vendor',
    group: { key: 'g1', label: 'Main' },
    patch: { col_span: n }
  })
  it('keeps only the last value of the same setting on the same field', () => {
    expect(appendStep([width(6)], width(4))).toEqual([width(4)])
    expect(
      appendStep([width(6)], { ...width(4), patch: { label_override: 'x' } } as MacroStep)
    ).toHaveLength(2)
  })
})

describe('describeStep', () => {
  it('reads as a short sentence with labels', () => {
    expect(
      describeStep({ op: 'move', field: 'amount', from: null, to: null, after: 'vendor' }, (f) =>
        f.toUpperCase()
      )
    ).toBe('Move AMOUNT after VENDOR')
  })
})
