import { describe, expect, it } from 'vitest'
import {
  fileToTarget,
  type ImportContext,
  LayoutFileError,
  layoutFileName,
  layoutToFile,
  layoutToYaml,
  parseLayoutYaml
} from '../../../services/layout-file.js'
import {
  type GroupRow,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow,
  ungroupedGroup
} from '../../../services/layout-ops-apply.js'

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

function bundle(): LayoutBundle {
  return {
    layout: {
      id: 7,
      collection: 'orders',
      name: 'Order form',
      slug: 'order',
      layout_type: 'grouped',
      is_active: true,
      sort: 3,
      tab_mode: 'steps',
      parent_layout_id: 4,
      record_conditions: [{ field: 'kind', op: 'eq', value: 'po' }]
    },
    groups: [
      group('basics', { sort: 0, hidden_for_roles: '["R-VIEW"]' }),
      group('tabs', { type: 'container', sort: 1 }),
      group('lines', { type: 'tab', parent_key: 'tabs', sort: 0 }),
      group('notes', { type: 'tab', parent_key: 'tabs', sort: 1, is_collapsed: true }),
      ungroupedGroup(2)
    ],
    placements: [
      place('title', 'basics', 0, { label_override: 'Request title' }),
      place('vendor', 'basics', 1, {
        col_span: 6,
        overrides: { note: 'Who ships it' },
        widget_id: 11
      }),
      place('line_items', 'lines', 0),
      place('memo', 'notes', 0, { is_visible: false }),
      place('status', null, 0),
      place('__pipeline__', null, 3),
      place('vendor', '__header__', 0)
    ],
    rev: 'r1'
  }
}

const ctx = (over: Partial<ImportContext> = {}): ImportContext => ({
  current: bundle(),
  layouts: [
    { id: 7, name: 'Order form', slug: 'order' },
    { id: 4, name: 'Base form', slug: 'base' },
    { id: 9, name: 'Other form', slug: 'other' }
  ],
  fields: new Set(['title', 'vendor', 'line_items', 'memo', 'status']),
  widgets: new Map([[11, 'Spend card']]),
  ...over
})

const refs = {
  layouts: new Map([
    [4, 'Base form'],
    [7, 'Order form']
  ]),
  widgets: new Map([[11, 'Spend card']])
}

const roundTrip = (b = bundle(), c = ctx()) =>
  fileToTarget(parseLayoutYaml(layoutToYaml(layoutToFile(b, refs, new Date(0)))), c)

describe('layout as a file (#3189)', () => {
  it('writes the form top to bottom, with only settings that differ', () => {
    const doc = layoutToFile(bundle(), refs, new Date(0))
    expect(doc.collection).toBe('orders')
    expect(doc.layout).not.toHaveProperty('is_active')
    expect(doc.layout).not.toHaveProperty('sort')
    const form = doc.form as Array<Record<string, unknown>>
    expect(form.map((e) => e.key ?? e.slot ?? (e.ungrouped ? 'ungrouped' : '?'))).toEqual([
      'basics',
      'tabs',
      'ungrouped',
      '__pipeline__'
    ])
    expect(form[0]).toEqual({
      key: 'basics',
      type: 'section',
      label: 'Basics',
      hidden_for_roles: ['R-VIEW'],
      fields: [
        { field: 'title', label_override: 'Request title' },
        { field: 'vendor', col_span: 6, overrides: { note: 'Who ships it' }, widget_id: 11 }
      ]
    })
    expect((form[1].tabs as unknown[]).length).toBe(2)
    expect(doc.zones).toEqual({ __header__: [{ field: 'vendor' }] })
    expect(doc.references).toEqual({
      parent_layout: { id: 4, name: 'Base form' },
      widgets: [{ id: 11, name: 'Spend card' }]
    })
    const yaml = layoutToYaml(doc)
    expect(yaml.startsWith('# Nivaro layout file')).toBe(true)
    expect(yaml).toContain('nivaro_layout_file: 1')
    expect(layoutFileName(bundle().layout)).toBe('orders-order.layout.yaml')
  })

  it('reads back the same layout', () => {
    const { target, warnings } = roundTrip()
    expect(warnings).toEqual([])
    const shape = (gs: GroupRow[]) =>
      gs
        .map((g) => [g.key, g.parent_key, g.type, g.sort, g.hidden_for_roles, g.is_collapsed])
        .sort()
    expect(shape(target.groups)).toEqual(shape(bundle().groups))
    const pshape = (ps: PlacementRow[]) =>
      ps
        .map((p) => [p.field, p.group_key, p.sort, p.label_override, p.col_span, p.is_visible])
        .sort()
    expect(pshape(target.placements)).toEqual(pshape(bundle().placements))
    expect(
      target.placements.find((p) => p.field === 'vendor' && p.group_key === 'basics')
    ).toMatchObject({ overrides: { note: 'Who ships it' }, widget_id: 11 })
    expect(target.layout).toMatchObject({ tab_mode: 'steps', parent_layout_id: 4 })
  })

  it('refuses another collection, another kind of layout and unknown settings, naming each', () => {
    const doc = layoutToFile(bundle(), refs)
    expect(() => fileToTarget({ ...doc, collection: 'invoices' }, ctx())).toThrow(LayoutFileError)
    const bad = {
      ...doc,
      layout: { ...(doc.layout as object), layout_type: 'table', colour: 'red' }
    }
    try {
      fileToTarget(bad, ctx())
      expect.unreachable()
    } catch (e) {
      expect((e as LayoutFileError).problems).toEqual([
        'This file is a table layout; this one is grouped'
      ])
    }
    const form = [
      { key: 'basics', type: 'section', label: 'B', colour: 1, fields: [{ field: 'x', wide: 1 }] }
    ]
    try {
      fileToTarget({ ...doc, form }, ctx())
      expect.unreachable()
    } catch (e) {
      expect((e as LayoutFileError).problems).toEqual([
        'form item 1 (basics): colour is not a section setting',
        'form item 1 (basics): wide is not a field setting (on x)'
      ])
    }
  })

  it('keeps this form’s name when another form has it; remaps references by name', () => {
    const doc = layoutToFile(bundle(), refs) as Record<string, unknown>
    const layout = { ...(doc.layout as object), name: 'Other form', parent_layout_id: 99 }
    const refs2 = {
      parent_layout: { id: 99, name: 'Base form' },
      widgets: [{ id: 50, name: 'Spend card' }]
    }
    const form = (doc.form as Array<Record<string, unknown>>).map((e) =>
      e.key === 'basics'
        ? {
            ...e,
            fields: [{ field: 'vendor', widget_id: 50 }, { field: 'ghost' }]
          }
        : e
    )
    const out = fileToTarget({ ...doc, layout, references: refs2, form }, ctx())
    expect(out.target.layout.name).toBeUndefined()
    expect(out.target.layout.parent_layout_id).toBe(4)
    expect(out.target.placements.find((p) => p.field === 'vendor')?.widget_id).toBe(11)
    expect(out.warnings).toEqual([
      'Kept this form’s name: another form here is already called “Other form”',
      'The parent form “Base form” is a different id here (4); used that one',
      'Not fields of orders: ghost — they stay on the form but show nothing'
    ])
  })

  it('reads YAML safely: no custom tags, no alias bombs, duplicate keys refused', () => {
    expect(() => parseLayoutYaml('')).toThrow('The file is empty')
    expect(() => parseLayoutYaml('a: 1')).toThrow('not a Nivaro layout file')
    expect(() => parseLayoutYaml('nivaro_layout_file: 1\nx: !!js/function "f(){}"')).toThrow(
      LayoutFileError
    )
    expect(() => parseLayoutYaml('nivaro_layout_file: 1\na: 1\na: 2')).toThrow(LayoutFileError)
    const bomb = [
      'nivaro_layout_file: 1',
      'a: &a [x, x, x, x, x, x, x, x, x, x]',
      'b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]',
      'c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]',
      'd: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]',
      'e: &e [*d, *d, *d, *d, *d, *d, *d, *d, *d, *d]',
      'f: [*e, *e, *e, *e, *e, *e, *e, *e, *e, *e]'
    ].join('\n')
    expect(() => parseLayoutYaml(bomb)).toThrow('too large or repeats itself')
    expect(() => parseLayoutYaml('nivaro_layout_file: 9\nform: []')).toThrow('newer Nivaro')
  })
})
