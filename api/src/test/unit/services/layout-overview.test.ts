import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => {
  const d = vi.fn()
  return {
    db: Object.assign(d, { transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(d)) })
  }
})

import { pickBestLayoutTraced } from '../../../routes/collection-layouts.js'
import {
  buildLayoutOverview,
  type OverviewLayoutInput,
  type OverviewRow
} from '../../../services/layout-overview.js'

const notUnit = { field: 'is_unit_specific_order', op: 'eq', value: false }

// inventory_request on EFP_Development, 2026-10-20 (ids, names, slugs, rules as dumped).
const fixture: OverviewLayoutInput[] = [
  { id: 20, name: 'Default', layout_type: 'grouped', is_active: 0, sort: 0, slug: null },
  {
    id: 22,
    name: 'Unit Order',
    layout_type: 'grouped',
    is_active: 1,
    sort: 1,
    slug: 'inv-unit',
    create_label: 'Unit (Node Splits / Genesis)',
    tab_mode: 'steps',
    groups: [
      { id: 1, key: 's1', type: 'tab' },
      { id: 2, key: 's2', type: 'tab' },
      { id: 3, key: 's3', type: 'tab' },
      { id: 4, key: 's4', type: 'tab' },
      { id: 5, key: 'notes', type: 'section' }
    ],
    assignments: [
      { field: 'title', group_key: 's1', is_visible: 1 },
      { field: 'site', group_key: 's1', is_visible: true },
      { field: 'site', group_key: '__header__', is_visible: true },
      { field: 'qty', group_key: 's2', is_visible: 0 },
      { field: '__pipeline__', group_key: 's1', is_visible: 1 },
      { field: '__ungrouped_pos__', group_key: null, is_visible: 1 }
    ]
  },
  {
    id: 23,
    name: 'Non-Unit Order',
    layout_type: 'grouped',
    is_active: 0,
    sort: 2,
    slug: 'inv-non-unit',
    create_label: 'Non-Unit',
    record_conditions: JSON.stringify([notUnit, { field: 'is_sparing', op: 'eq', value: false }])
  },
  {
    id: 24,
    name: 'Sparing Order',
    layout_type: 'grouped',
    is_active: 0,
    sort: 3,
    slug: 'inv-sparing',
    create_label: 'Sparing',
    record_conditions: JSON.stringify([notUnit, { field: 'is_sparing', op: 'eq', value: true }])
  },
  { id: 46, name: 'Drill Columns', layout_type: 'table', is_active: 0, sort: 4, slug: null },
  {
    id: 58,
    name: 'Warehouse Submission',
    layout_type: 'grouped',
    is_active: 0,
    sort: 5,
    slug: 'warehouse-submission',
    create_hidden: 1
  },
  { id: 59, name: 'IR Export', layout_type: 'file', is_active: 1, sort: 6, slug: 'ir-export' },
  {
    id: 87,
    name: 'Summary',
    layout_type: 'summary',
    is_active: 1,
    sort: 7,
    slug: 'summary',
    create_hidden: 1
  }
]

const byId = (rows: OverviewRow[], id: number) =>
  rows.find((r) => r.layout_id === id) as OverviewRow
const ids = (rows: OverviewRow[], section: OverviewRow['section']) =>
  rows.filter((r) => r.section === section).map((r) => r.layout_id)

describe('buildLayoutOverview — inventory_request', () => {
  const rows = buildLayoutOverview(fixture, new Map(), [])

  it('lists forms in the order /active checks them: record rules (most rules first), then the default', () => {
    expect(ids(rows, 'forms')).toEqual([23, 24, 22])
    expect(byId(rows, 24).reason).toEqual({
      kind: 'record_rule',
      rules: [notUnit, { field: 'is_sparing', op: 'eq', value: true }]
    })
    expect(byId(rows, 22).reason.kind).toBe('default')
    expect(byId(rows, 22).is_default).toBe(true)
    expect(byId(rows, 23).is_default).toBe(false)
  })

  it('puts the sections in page order', () => {
    const order = rows.map((r) => r.section)
    const firstOf = (s: OverviewRow['section']) => order.indexOf(s)
    expect(firstOf('forms')).toBeLessThan(firstOf('link_only'))
    expect(firstOf('link_only')).toBeLessThan(firstOf('other_views'))
    expect(firstOf('other_views')).toBeLessThan(firstOf('unused'))
  })

  it('a hidden slugged form is link-only', () => {
    expect(ids(rows, 'link_only')).toEqual([58])
    expect(byId(rows, 58).reason.kind).toBe('slug')
    expect(byId(rows, 58).new_menu).toEqual({ label: 'Warehouse Submission', hidden: true })
  })

  it('summary, file and table layouts are other views with a plain use line', () => {
    expect(ids(rows, 'other_views').sort()).toEqual([46, 59, 87])
    for (const id of [46, 59, 87]) {
      const row = byId(rows, id)
      expect(row.reason.kind).toBe('type_use')
      expect(typeof row.reason.type_use).toBe('string')
      expect(row.new_menu).toBeNull()
    }
  })

  it('an empty, unslugged, unreferenced grouped layout is unused', () => {
    expect(ids(rows, 'unused')).toEqual([20])
    expect(byId(rows, 20).shape).toEqual({
      groups: 0,
      steps_or_tabs: 0,
      fields: 0,
      container_mode: null
    })
  })

  it('reports New-menu labels', () => {
    expect(byId(rows, 22).new_menu).toEqual({
      label: 'Unit (Node Splits / Genesis)',
      hidden: false
    })
    expect(byId(rows, 23).new_menu).toEqual({ label: 'Non-Unit', hidden: false })
  })

  it('counts steps, sections and distinct visible real fields', () => {
    expect(byId(rows, 22).shape).toEqual({
      groups: 1,
      steps_or_tabs: 4,
      fields: 2,
      container_mode: 'steps'
    })
  })

  it('no rule in the fixture is shadowed', () => {
    for (const r of rows) expect(r.warnings).toEqual([])
  })
})

describe('buildLayoutOverview — edge cases', () => {
  const grouped = (over: Partial<OverviewLayoutInput>): OverviewLayoutInput => ({
    id: 1,
    name: 'L',
    layout_type: 'grouped',
    is_active: 0,
    sort: 0,
    slug: null,
    ...over
  })

  it('no layouts → no rows', () => {
    expect(buildLayoutOverview([], new Map(), [])).toEqual([])
  })

  it('role-only collection: more roles first, role names, first in order is the fallback', () => {
    const rows = buildLayoutOverview(
      [
        grouped({ id: 1, name: 'Finance', sort: 0, conditions: { role_ids: ['r-fin'] } }),
        grouped({
          id: 2,
          name: 'Ops',
          sort: 1,
          conditions: JSON.stringify({ role_ids: ['r-fin', 'r-eng'] })
        })
      ],
      new Map(),
      [
        { id: 'r-fin', name: 'Finance' },
        { id: 'r-eng', name: 'Engineering' }
      ]
    )
    expect(ids(rows, 'forms')).toEqual([2, 1])
    expect(byId(rows, 2).reason).toEqual({
      kind: 'role',
      role_ids: ['r-fin', 'r-eng'],
      role_names: ['Finance', 'Engineering']
    })
    expect(byId(rows, 1).reason.kind).toBe('role')
    expect(byId(rows, 1).is_default).toBe(false)
    // Layout 1 is still reached: admins fall back to the first in order.
    expect(byId(rows, 1).warnings).toEqual([])
    expect(ids(rows, 'unused')).toEqual([])
  })

  it('a role-preference layout every one of whose roles is taken by a wider one warns', () => {
    const rows = buildLayoutOverview(
      [
        grouped({ id: 1, name: 'Default', is_active: 1 }),
        grouped({ id: 2, name: 'Wide', sort: 1, conditions: { role_ids: ['a', 'b'] } }),
        grouped({ id: 3, name: 'Narrow', sort: 2, conditions: { role_ids: ['a'] } })
      ],
      new Map(),
      []
    )
    expect(ids(rows, 'forms')).toEqual([2, 3, 1])
    expect(byId(rows, 3).warnings).toEqual(['never reached: shadowed by Wide'])
    expect(byId(rows, 2).warnings).toEqual([])
  })

  it('record-rule layout fully shadowed by an earlier one gets a warning', () => {
    const a = { field: 'a', op: 'eq', value: 1 }
    const b = { field: 'b', op: 'eq', value: 2 }
    const rows = buildLayoutOverview(
      [
        grouped({ id: 1, name: 'Default', is_active: 1 }),
        grouped({ id: 2, name: 'First A', sort: 1, record_conditions: [a] }),
        grouped({ id: 3, name: 'Second A', sort: 2, record_conditions: [a] }),
        grouped({ id: 4, name: 'A and B', sort: 3, record_conditions: [a, b] }),
        grouped({
          id: 5,
          name: 'B nnull',
          sort: 4,
          record_conditions: [{ field: 'b', op: 'nnull' }]
        })
      ],
      new Map(),
      []
    )
    expect(ids(rows, 'forms')).toEqual([4, 2, 3, 5, 1])
    expect(byId(rows, 3).warnings).toEqual(['never reached: shadowed by First A'])
    expect(byId(rows, 2).warnings).toEqual([])
    expect(byId(rows, 4).warnings).toEqual([])
    expect(byId(rows, 5).warnings).toEqual([])
  })

  it('a rule shadowing only some roles does not warn', () => {
    const a = { field: 'a', op: 'eq', value: 1 }
    const rows = buildLayoutOverview(
      [
        grouped({
          id: 1,
          name: 'Admins A',
          record_conditions: [a],
          conditions: { role_ids: ['x'] }
        }),
        grouped({ id: 2, name: 'Everyone A', sort: 1, record_conditions: [a] })
      ],
      new Map(),
      []
    )
    expect(byId(rows, 2).warnings).toEqual([])
  })

  it('an empty rule list warns that it catches every saved record', () => {
    const rows = buildLayoutOverview(
      [grouped({ id: 1, name: 'All', record_conditions: '[]' })],
      new Map(),
      []
    )
    expect(byId(rows, 1).warnings).toEqual(['matches every saved record (its rule list is empty)'])
  })

  it('a layout with a slug is never unused; a referenced one is link-only', () => {
    const refs = new Map([[3, [{ kind: 'submission_form', id: 'f1', label: 'Public form “Ask”' }]]])
    const rows = buildLayoutOverview(
      [
        grouped({ id: 1, name: 'Default', is_active: 1 }),
        grouped({ id: 2, name: 'Linked', sort: 1, slug: 'linked' }),
        grouped({ id: 3, name: 'Form', sort: 2 }),
        grouped({ id: 4, name: 'Nothing', sort: 3 })
      ],
      refs,
      []
    )
    expect(ids(rows, 'link_only')).toEqual([2, 3])
    expect(byId(rows, 3).references).toEqual(refs.get(3))
    expect(ids(rows, 'unused')).toEqual([4])
  })

  it('no active grouped layout: the first in order is the fallback, not the default', () => {
    const rows = buildLayoutOverview(
      [grouped({ id: 7, name: 'Only', sort: 3 }), grouped({ id: 8, name: 'Later', sort: 4 })],
      new Map(),
      []
    )
    expect(byId(rows, 7).reason.kind).toBe('fallback')
    expect(byId(rows, 7).is_default).toBe(false)
    expect(byId(rows, 7).section).toBe('forms')
    expect(byId(rows, 8).section).toBe('unused')
  })

  it('container_mode follows a tab container', () => {
    const rows = buildLayoutOverview(
      [
        grouped({
          id: 1,
          is_active: 1,
          groups: [
            { id: 10, key: 'c', type: 'container', tab_mode: 'tabs' },
            { id: 11, key: 't1', type: 'tab', container_id: 10 },
            { id: 12, key: 't2', type: 'tab', container_id: 10 }
          ]
        })
      ],
      new Map(),
      []
    )
    expect(rows[0].shape).toMatchObject({ steps_or_tabs: 2, container_mode: 'tabs', groups: 0 })
  })
})

describe('pickBestLayoutTraced — explain path', () => {
  const candidates = fixture
    .filter((l) => l.layout_type === 'grouped')
    .sort((a, b) => Number(b.is_active) - Number(a.is_active) || Number(a.sort) - Number(b.sort))
    .map((l) => ({ ...l }) as Record<string, unknown>)

  it('names the record-rule winner and why each other candidate lost', () => {
    const res = pickBestLayoutTraced(
      candidates,
      null,
      { id: 'x', is_unit_specific_order: false, is_sparing: true },
      true
    )
    expect(res.row?.id).toBe(24)
    expect(res.reason?.kind).toBe('record_rule')
    const check = (id: number) => res.checked.find((c) => c.layout_id === id)
    expect(check(24)?.matched).toBe(true)
    expect(check(23)?.matched).toBe(false)
    expect(check(22)?.matched).toBe(false)
    expect(res.checked.map((c) => c.layout_id)).toEqual(candidates.map((c) => c.id))
  })

  it('falls to the default when no rule matches', () => {
    const res = pickBestLayoutTraced(
      candidates,
      null,
      { id: 'x', is_unit_specific_order: true, is_sparing: false },
      true
    )
    expect(res.row?.id).toBe(22)
    expect(res.reason).toEqual({ kind: 'default' })
  })

  it('reports role restrictions as a failed check', () => {
    const res = pickBestLayoutTraced(
      [
        { id: 1, name: 'Admins', is_active: 1, conditions: '{"role_ids":["adm"]}' },
        { id: 2, name: 'Everyone', is_active: 0 }
      ],
      'user',
      null,
      false
    )
    expect(res.row?.id).toBe(2)
    expect(res.reason).toEqual({ kind: 'fallback' })
    expect(res.checked[0]).toMatchObject({ layout_id: 1, matched: false })
    // A default exists but this role can't open it: say so, not "none is marked default".
    expect(res.checked[1]).toEqual({
      layout_id: 2,
      matched: true,
      why: 'First in order among the forms this role can open'
    })
  })

  it('says no form is marked default only when none is active', () => {
    const res = pickBestLayoutTraced(
      [
        { id: 1, name: 'A', is_active: 0 },
        { id: 2, name: 'B', is_active: 0 }
      ],
      null,
      null,
      true
    )
    expect(res.checked[0].why).toBe('First in order (no form is marked default)')
  })
})

describe('buildLayoutOverview — matches the renderer and the New menu', () => {
  const grouped = (over: Partial<OverviewLayoutInput>): OverviewLayoutInput => ({
    id: 1,
    name: 'L',
    layout_type: 'grouped',
    is_active: 0,
    sort: 0,
    slug: null,
    ...over
  })
  const steps = [
    { id: 1, key: 'a', type: 'tab' },
    { id: 2, key: 'b', type: 'tab' }
  ]

  it('top-level tabs with a null tab_mode render as tabs', () => {
    const rows = buildLayoutOverview(
      [grouped({ is_active: 1, tab_mode: null, groups: steps })],
      new Map(),
      []
    )
    expect(rows[0].shape.container_mode).toBe('tabs')
    const asSteps = buildLayoutOverview(
      [grouped({ is_active: 1, tab_mode: 'steps', groups: steps })],
      new Map(),
      []
    )
    expect(asSteps[0].shape.container_mode).toBe('steps')
  })

  it("a container's own tab_mode decides (null = tabs, even under a steps layout)", () => {
    const rows = buildLayoutOverview(
      [
        grouped({
          is_active: 1,
          tab_mode: 'steps',
          groups: [
            { id: 10, key: 'c', type: 'container', tab_mode: null },
            { id: 11, key: 't', type: 'tab', container_id: 10 }
          ]
        })
      ],
      new Map(),
      []
    )
    expect(rows[0].shape.container_mode).toBe('tabs')
  })

  it("`eq null` and `eq ''` are different rules: no false shadow warning", () => {
    const rows = buildLayoutOverview(
      [
        grouped({ id: 1, name: 'Empty', record_conditions: [{ field: 'x', op: 'eq', value: '' }] }),
        grouped({
          id: 2,
          name: 'Null',
          sort: 1,
          record_conditions: [{ field: 'x', op: 'eq', value: null }]
        })
      ],
      new Map(),
      []
    )
    expect(byId(rows, 2).warnings).toEqual([])
  })

  it('a legacy NULL-type slugged layout is not on the New menu', () => {
    const rows = buildLayoutOverview(
      [
        grouped({ id: 1, name: 'Default', is_active: 1 }),
        grouped({ id: 2, name: 'Legacy', sort: 1, layout_type: null, slug: 'legacy' }),
        grouped({ id: 3, name: 'Typed', sort: 2, slug: 'typed' })
      ],
      new Map(),
      []
    )
    expect(byId(rows, 2).new_menu).toEqual({ label: 'Legacy', hidden: true })
    expect(byId(rows, 3).new_menu).toEqual({ label: 'Typed', hidden: false })
  })
})

describe('buildLayoutOverview rule_shape (#2642)', () => {
  const grouped = (over: Partial<OverviewLayoutInput>): OverviewLayoutInput => ({
    id: 1,
    name: 'L',
    layout_type: 'grouped',
    is_active: 0,
    sort: 0,
    slug: null,
    ...over
  })
  it('carries sections with their show-when rules and field places for forms only', () => {
    const rows = buildLayoutOverview(
      [
        grouped({
          id: 1,
          name: 'Form',
          is_active: 1,
          groups: [
            { id: 10, key: 'tabs', label: 'Tabs', type: 'container' },
            {
              id: 11,
              key: 'extra',
              type: 'tab',
              container_id: 10,
              visible_when: '[{"field":"x","op":"eq","value":"1"}]'
            }
          ],
          assignments: [
            { field: 'x', group_key: 'extra' },
            { field: '__comments__', group_key: null }
          ]
        }),
        grouped({ id: 2, name: 'Read', sort: 1, layout_type: 'summary' })
      ],
      new Map(),
      []
    )
    expect(byId(rows, 1).rule_shape).toEqual({
      groups: [
        { key: 'tabs', label: 'Tabs', parent_key: null, visible_when: null },
        {
          key: 'extra',
          label: null,
          parent_key: 'tabs',
          visible_when: '[{"field":"x","op":"eq","value":"1"}]'
        }
      ],
      placements: [{ field: 'x', group_key: 'extra' }]
    })
    expect(byId(rows, 2).rule_shape).toBeUndefined()
  })
})
