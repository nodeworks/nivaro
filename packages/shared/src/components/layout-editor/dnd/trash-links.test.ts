import { describe, expect, it } from 'vitest'
import {
  type LayoutBundle,
  type LayoutOp,
  newGroup,
  newPlacement,
  ungroupedGroup
} from '../../../lib/layout-ops'
import { type FieldLink, formulaLinks, formulaRefs, trashWarning } from './trash-links'

const bundle: LayoutBundle = {
  layout: { id: 1, collection: 'orders' },
  rev: 'r',
  groups: [
    { ...newGroup('g1', 'Basics', 'section', null), sort: 0 },
    { ...newGroup('billing', 'Billing', 'section', null), sort: 1 },
    ungroupedGroup(2)
  ],
  placements: [
    { ...newPlacement('region', 'g1'), sort: 0 },
    { ...newPlacement('site', 'g1'), sort: 1 },
    { ...newPlacement('tax_code', 'billing'), sort: 0 },
    { ...newPlacement('total', 'billing'), sort: 1 }
  ]
}

const links: FieldLink[] = [
  { driver: 'region', kind: 'visibility', target: { kind: 'group', key: 'billing' } },
  { driver: 'region', kind: 'field_rule', target: { kind: 'field', field: 'tax_code' } },
  { driver: 'region', kind: 'cascade', target: { kind: 'field', field: 'site' }, filterOnly: true },
  { driver: 'tax_code', kind: 'formula', target: { kind: 'field', field: 'total' } }
]
const LABELS: Record<string, string> = {
  region: 'Region',
  site: 'Site',
  tax_code: 'Tax code',
  total: 'Total'
}
const label = (f: string) => LABELS[f] ?? f
const groupLabel = (k: string) => (k === 'billing' ? 'Billing' : k)
const remove = (field: string, group_key: string): LayoutOp => ({
  op: 'remove',
  at: { field, group_key }
})

describe('formula references', () => {
  it('reads item.<col> and {{col}} references', () => {
    expect(formulaRefs('item.qty * item.price + {{ tax }}')).toEqual(['qty', 'price', 'tax'])
    expect(formulaRefs(null)).toEqual([])
  })

  it('calculated fields and starting values link back to what they read; rollups do not', () => {
    expect(
      formulaLinks([
        { field: 'total', computed_type: 'write', computed_formula: 'item.qty * item.price' },
        { field: 'count', computed_type: 'rollup', computed_formula: '{"sources":[]}' },
        { field: 'due', default_formula: '{{start}}' }
      ])
    ).toEqual([
      { driver: 'qty', kind: 'formula', target: { kind: 'field', field: 'total' } },
      { driver: 'price', kind: 'formula', target: { kind: 'field', field: 'total' } },
      { driver: 'start', kind: 'default', target: { kind: 'field', field: 'due' } }
    ])
  })
})

describe('trashWarning', () => {
  it('says what a field that leaves the form drives', () => {
    const w = trashWarning({
      bundle,
      ops: [remove('region', 'g1')],
      links,
      label,
      groupLabel
    })
    expect(w?.headline).toBe('Region drives 3 rules')
    expect(w?.effects).toEqual([
      'Shows or hides Billing',
      'Fills Tax code',
      'Narrows the choices of Site'
    ])
  })

  it('a field still placed elsewhere on the form warns of nothing', () => {
    const twin = {
      ...bundle,
      placements: [...bundle.placements, { ...newPlacement('region', 'billing'), sort: 2 }]
    }
    expect(
      trashWarning({ bundle: twin, ops: [remove('region', 'g1')], links, label, groupLabel })
    ).toBeNull()
  })

  it('a field nothing reads warns of nothing', () => {
    expect(
      trashWarning({ bundle, ops: [remove('site', 'g1')], links, label, groupLabel })
    ).toBeNull()
  })

  it('a section leaving: rules about what leaves with it do not count', () => {
    const w = trashWarning({
      bundle,
      ops: [{ op: 'group_remove', key: 'billing', placements: 'delete' }],
      links,
      label,
      groupLabel
    })
    // tax_code → total: both leave together.
    expect(w).toBeNull()
    const both = trashWarning({
      bundle,
      ops: [remove('region', 'g1'), remove('tax_code', 'billing')],
      links,
      label,
      groupLabel
    })
    expect(both?.headline).toBe('2 of these fields drive 3 rules')
    expect(both?.effects).toEqual([
      'Region shows or hides Billing',
      'Tax code calculates Total',
      'Region narrows the choices of Site'
    ])
  })
})
