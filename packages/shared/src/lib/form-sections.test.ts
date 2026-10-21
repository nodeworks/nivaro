import { describe, expect, it } from 'vitest'
import { formSections, mergeFormSections } from './form-sections'

const groups = [
  { id: 1, key: 'tabs', label: 'Main', type: 'container', sort: 2 },
  { id: 2, key: 'money', label: 'Money', type: 'section', sort: 1, container_id: 1 },
  { id: 3, key: 'who', label: 'People', type: 'section', sort: 1 },
  { id: 4, key: 'note', label: 'Read me', type: 'content', sort: 3 },
  // Its container (id 9) was hidden from the viewer.
  { id: 5, key: 'orphan', label: 'Orphan', type: 'section', sort: 4, container_id: 9 }
]
const placements = [
  { field: 'amount', group_key: 'money', sort: 2 },
  { field: 'currency', group_key: 'money', sort: 1, label_override: 'Ccy' },
  { field: 'owner', group_key: 'who', sort: 1 },
  { field: 'hidden', group_key: 'who', sort: 2, is_visible: 0 },
  { field: '__owners__', group_key: 'who', sort: 3 },
  { field: 'title', group_key: null, sort: 1 },
  { field: 'status', group_key: '__header__', sort: 1 },
  { field: 'lost', group_key: 'orphan', sort: 1 },
  { field: 'gone', group_key: 'removed', sort: 1 }
]

describe('formSections', () => {
  it('orders header, general, then sections depth-first with paths', () => {
    expect(formSections(groups, placements)).toEqual([
      { key: '__header__', label: 'Header', fields: [{ field: 'status', label: null }] },
      { key: '__general__', label: 'General', fields: [{ field: 'title', label: null }] },
      { key: 'who', label: 'People', fields: [{ field: 'owner', label: null }] },
      {
        key: 'money',
        label: 'Main › Money',
        fields: [
          { field: 'currency', label: 'Ccy' },
          { field: 'amount', label: null }
        ]
      }
    ])
  })

  it('places the ungrouped fields where the form puts them', () => {
    const keys = formSections(groups, placements, { ungroupedSort: 1.5 }).map((s) => s.key)
    expect(keys).toEqual(['__header__', 'who', '__general__', 'money'])
  })
})

describe('mergeFormSections', () => {
  it('keeps the first form’s order and adds what only others show', () => {
    const a = [{ key: 's', label: 'Details', fields: [{ field: 'x', label: null }] }]
    const b = [
      {
        key: 's2',
        label: 'Details',
        fields: [
          { field: 'x', label: null },
          { field: 'y', label: null }
        ]
      },
      { key: 'e', label: 'Extra', fields: [{ field: 'z', label: null }] }
    ]
    expect(mergeFormSections([a, b]).map((s) => [s.label, s.fields.map((f) => f.field)])).toEqual([
      ['Details', ['x', 'y']],
      ['Extra', ['z']]
    ])
  })
})
