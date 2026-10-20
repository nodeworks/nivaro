import { describe, expect, it } from 'vitest'
import {
  applyLayoutOps,
  type GroupRow,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow
} from '../../../lib/layout-ops'
import {
  describeField,
  inlineDisplayOf,
  isDefaultForm,
  layoutGrids,
  overridePlacementOps,
  relatedCollectionOf,
  relKindOf,
  subtitleOf,
  withDefaultValue,
  withInlineDisplay,
  withOption,
  withOverride,
  withStaticBinding
} from './model'

const RELATIONS = [
  { many_collection: 'orders', many_field: 'vendor', one_collection: 'vendors', one_field: null },
  {
    many_collection: 'order_lines',
    many_field: 'order',
    one_collection: 'orders',
    one_field: 'lines',
    junction_field: null
  },
  {
    many_collection: 'orders_tags',
    many_field: 'orders_id',
    one_collection: 'orders',
    one_field: 'tags',
    junction_field: 'tags_id'
  },
  {
    many_collection: 'orders_tags',
    many_field: 'tags_id',
    one_collection: 'tags',
    one_field: null,
    junction_field: 'orders_id'
  }
]

const place = (field: string, group: string | null, extra: Partial<PlacementRow> = {}) => ({
  ...newPlacement(field, group),
  ...extra
})

function bundle(placements: PlacementRow[], groups: GroupRow[] = []): LayoutBundle {
  return {
    layout: { id: 7, collection: 'orders', is_active: true, layout_type: 'grouped' },
    groups,
    placements,
    rev: 'r1'
  }
}

describe('inspector model', () => {
  it('reads relation kinds and the far collection', () => {
    expect(relKindOf('vendor', RELATIONS)).toBe('M2O')
    expect(relKindOf('lines', RELATIONS)).toBe('O2M')
    expect(relKindOf('tags', RELATIONS)).toBe('M2M')
    expect(relKindOf('title', RELATIONS)).toBeNull()
    expect(relatedCollectionOf('vendor', RELATIONS)).toBe('vendors')
    expect(relatedCollectionOf('lines', RELATIONS)).toBe('order_lines')
    expect(relatedCollectionOf('tags', RELATIONS)).toBe('tags')
  })

  it('labels a field by this form, then the field, then its key', () => {
    const globals = [{ field: 'vendor', type: 'integer', label: 'Supplier', interface: null }]
    const p = place('vendor', null, { overrides: { label: 'Ship from' } })
    expect(describeField('vendor', globals, RELATIONS, p).label).toBe('Ship from')
    expect(describeField('vendor', globals, RELATIONS, place('vendor', null)).label).toBe(
      'Supplier'
    )
    expect(describeField('due_date', [], RELATIONS, null).label).toBe('Due Date')
    // A hidden label ('') is not a label
    const hidden = place('vendor', null, { overrides: { label: '' } })
    expect(describeField('vendor', globals, RELATIONS, hidden).label).toBe('Supplier')
  })

  it('sets and removes override and option keys without touching the rest', () => {
    const p = place('qty', null, { overrides: { label: 'Qty', options: { precision: 2 } } })
    expect(withOverride(p, 'required', true)).toEqual({
      label: 'Qty',
      options: { precision: 2 },
      required: true
    })
    expect(withOverride(p, 'label', undefined)).toEqual({ options: { precision: 2 } })
    expect(withOption(p, 'precision', undefined)).toEqual({ label: 'Qty' })
    expect(withOption(place('x', null), 'date_mode', 'date')).toEqual({
      options: { date_mode: 'date' }
    })
    expect(withOption(place('x', null, { overrides: { options: { a: 1 } } }), 'a', undefined)).toBe(
      null
    )
  })

  it('keeps other bindings when one static binding changes', () => {
    const p = place('vendor', null, {
      input_bindings: [{ key: 'other', binding_type: 'static', binding_value: 'x' }]
    })
    const cfg = {
      entries: [{ field: 'name', label: null, format: null }],
      separator: ', '
    }
    const next = withInlineDisplay(p, cfg)
    expect(next?.map((b) => b.key)).toEqual(['other', '__inline_display__'])
    expect(inlineDisplayOf({ ...p, input_bindings: next })).toEqual(cfg)
    expect(withStaticBinding(p, 'other', null)).toBeNull()
  })

  it('reads the legacy bare-array inline display', () => {
    const p = place('vendor', null, {
      input_bindings: [
        {
          key: '__inline_display__',
          binding_type: 'static',
          binding_value: JSON.stringify([{ field: 'name', label: null, format: null }])
        }
      ]
    })
    expect(inlineDisplayOf(p)).toEqual({
      entries: [{ field: 'name', label: null, format: null }],
      separator: null
    })
  })

  it('drops a default value that is empty and the map when nothing is left', () => {
    const layout = { id: 1, collection: 'orders', default_values: '{"status":"open"}' }
    expect(withDefaultValue(layout, 'priority', 2)).toEqual({ status: 'open', priority: 2 })
    expect(withDefaultValue(layout, 'status', '')).toBeNull()
    expect(withDefaultValue(layout, 'tags', [])).toEqual({ status: 'open' })
  })

  it('knows the default form', () => {
    expect(isDefaultForm({ id: 1, collection: 'c', is_active: true, layout_type: null })).toBe(true)
    expect(isDefaultForm({ id: 1, collection: 'c', is_active: false })).toBe(false)
    expect(
      isDefaultForm({ id: 1, collection: 'c', is_active: true, layout_type: 'addendum' })
    ).toBe(false)
  })

  it('lists the grids placed on the layout', () => {
    const b = bundle([place('lines', 'main'), place('title', 'main'), place('vendor', null)])
    expect(layoutGrids(b, [], RELATIONS)).toEqual([
      { field: 'lines', label: 'Lines', childCollection: 'order_lines' }
    ])
  })

  it('reads the subtitle row', () => {
    const b = bundle([
      place('__subtitle__', null, {
        input_bindings: [
          {
            key: '__subtitle_config__',
            binding_type: 'static',
            binding_value: JSON.stringify({
              fields: [{ field: 'po', label: 'PO' }],
              separator: ' · '
            })
          }
        ]
      })
    ])
    expect(subtitleOf(b)).toEqual({ fields: [{ field: 'po', label: 'PO' }], separator: ' · ' })
    expect(subtitleOf(bundle([]))).toBeNull()
  })

  it('copies an inherited placement and its missing section into the child', () => {
    const parent = bundle(
      [place('vendor', 'shipping', { col_span: 6, overrides: { required: true } })],
      [{ ...newGroup('shipping', 'Shipping', 'section', null), sort: 0 }]
    )
    const child = bundle([place('title', null)])
    const ops = overridePlacementOps(child, parent, parent.placements[0])
    expect(ops.map((o) => o.op)).toEqual(['group_create', 'place'])
    const next = applyLayoutOps(child, ops)
    const row = next.placements.find((p) => p.field === 'vendor')
    expect(row?.group_key).toBe('shipping')
    expect(row?.col_span).toBe(6)
    expect(row?.overrides).toEqual({ required: true })
    expect(next.groups.find((g) => g.key === 'shipping')?.label).toBe('Shipping')
  })
})
