import { describe, expect, it } from 'vitest'
import type { ActiveLayoutData } from '../../item-edit/types'
import {
  compareOutcomes,
  conditionFields,
  formCost,
  formView,
  nameList,
  readTesting,
  roleIdsPatch,
  testingPatch,
  type WalkAccess,
  walkthrough
} from './testing-model'

const g = (key: string, id: number, extra: Record<string, unknown> = {}) => ({
  key,
  id,
  label: key,
  type: 'section',
  sort: id,
  container_id: null,
  ...extra
})
const a = (field: string, group_key: string | null, extra: Record<string, unknown> = {}) => ({
  field,
  group_key,
  sort: 0,
  is_visible: true,
  ...extra
})
const layoutOf = (
  groups: ReturnType<typeof g>[],
  assignments: ReturnType<typeof a>[],
  meta: Record<string, unknown> = {}
) =>
  ({
    layout: { id: 1, name: 'Main', tab_mode: null, validate_before_next: false, ...meta },
    groups,
    assignments
  }) as unknown as ActiveLayoutData

const role = (over: Partial<Record<string, unknown>> = {}) => ({
  role: { id: 'R1', name: 'Requester', admin_access: false },
  can_read: true,
  can_update: true,
  hidden_fields: [] as string[],
  readonly_fields: [] as string[],
  ...over
})

describe('stored testing settings', () => {
  it('reads pins and the cost limit from conditions, deduped and capped', () => {
    const c = {
      role_ids: ['x'],
      testing: {
        records: [{ item: 1 }, { item: '1' }, { item: 2, role_id: 'r' }, { item: '' }],
        cost_limit: '55'
      }
    }
    expect(readTesting(JSON.stringify(c))).toEqual({
      records: [
        { item: '1', role_id: null },
        { item: '2', role_id: 'r' }
      ],
      cost_limit: 55
    })
    expect(readTesting(null)).toEqual({ records: [], cost_limit: null })
  })

  it('writes testing beside the role list and the role list beside testing', () => {
    const c = { role_ids: ['x'] }
    const withPins = testingPatch(c, { records: [{ item: '7', role_id: null }], cost_limit: null })
    expect(withPins).toEqual({
      conditions: { role_ids: ['x'], testing: { records: [{ item: '7', role_id: null }] } }
    })
    expect(roleIdsPatch(withPins.conditions, [])).toEqual({
      conditions: { testing: { records: [{ item: '7', role_id: null }] } }
    })
    expect(testingPatch({ testing: { records: [] } }, { records: [], cost_limit: null })).toEqual({
      conditions: null
    })
  })
})

describe('formView', () => {
  const layout = layoutOf(
    [
      g('main', 1),
      g('car', 2, { type: 'tab', visible_when: '[{"field":"kind","op":"eq","value":"car"}]' }),
      // Sections ignore conditions on the form: only top-level steps honour them.
      g('note', 3, { visible_when: '[{"field":"kind","op":"eq","value":"x"}]' })
    ],
    [
      a('title', null),
      a('zone', 'main'),
      a('secret', 'main', { is_visible: false }),
      a('quiet', 'main', { overrides: { hidden: true } }),
      a('plate', 'car'),
      a('memo', 'note'),
      a('__comments__', null)
    ]
  )

  it('shows visible placements in sections whose conditions hold', () => {
    expect([...formView(layout, { kind: 'car' }, null).keys()]).toEqual([
      'title',
      'zone',
      'plate',
      'memo'
    ])
    expect([...formView(layout, { kind: 'van' }, null).keys()]).toEqual(['title', 'zone', 'memo'])
  })

  it('applies the role’s permissions and the form’s role rules', () => {
    const v = formView(layout, {}, role({ hidden_fields: ['zone'], readonly_fields: ['title'] }))
    expect(Object.fromEntries(v)).toEqual({ title: 'readonly', memo: 'editable' })
  })

  it('names the fields the conditions read', () => {
    expect(conditionFields(layout, null)).toEqual(['kind'])
  })
})

describe('compareOutcomes', () => {
  const label = (f: string) => f.toUpperCase()
  const view = (o: Record<string, 'editable' | 'readonly'>) => new Map(Object.entries(o))
  const me = { layout_id: 1, name: 'Main' }

  it('says when a record lands on another form', () => {
    const out = compareOutcomes(
      { form: me, view: view({ a: 'editable' }) },
      { form: { layout_id: 2, name: 'Other' }, view: null },
      label
    )
    expect(out.map((c) => c.text)).toEqual(['lands on another form: “Other”'])
  })

  it('lists lost, gained and read-only fields', () => {
    const out = compareOutcomes(
      { form: me, view: view({ zone: 'editable', a: 'editable', b: 'readonly' }) },
      { form: me, view: view({ a: 'readonly', b: 'editable', c: 'editable' }) },
      label
    )
    expect(out.map((c) => c.text)).toEqual([
      'loses the ZONE field',
      'gains the C field',
      'can no longer edit A',
      'can now edit B'
    ])
  })

  it('joins long name lists', () => {
    expect(nameList(['a', 'b'])).toBe('a and b')
    expect(nameList(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more')
  })
})

describe('walkthrough', () => {
  const access = (over: Partial<WalkAccess> = {}): WalkAccess => ({
    role: { id: 'R1', name: 'Requester', admin_access: false },
    role_may_open: true,
    can_create: true,
    create_fields: null,
    hidden_fields: [],
    new_record_form: { layout_id: 1, name: 'Main' },
    column_defaults: [],
    ...over
  })
  const steps = layoutOf(
    [
      g('basics', 1, { type: 'tab' }),
      g('funding', 2, { type: 'tab' }),
      g('extra', 3, { type: 'tab', visible_when: '[{"field":"kind","op":"eq","value":"big"}]' })
    ],
    [a('title', 'basics'), a('budget', 'funding'), a('reason', 'extra')],
    { tab_mode: 'steps', validate_before_next: true }
  )
  const rows = [
    { field: 'title', label: 'Title', required: true, group_key: 'basics' },
    { field: 'budget', label: 'Budget', required: true, group_key: 'funding' },
    { field: 'reason', label: 'Reason', required: true, group_key: 'extra' },
    { field: 'vendor', label: 'Vendor', required: true, layout_assigned: false }
  ]

  it('stops at Next on the first step with a required field the role cannot write', () => {
    const r = walkthrough({
      layout: steps,
      rows,
      access: access({ create_fields: ['title', 'reason'] }),
      thisLayoutId: 1
    })
    expect(r.blocker).toMatchObject({ step: 1, where: 'Next on “funding”', field: 'budget' })
    expect(r.skipped.map((s) => s.field)).toEqual(['vendor'])
  })

  it('reports a required field in a hidden step at Save', () => {
    const r = walkthrough({ layout: steps, rows, access: access(), thisLayoutId: 1 })
    expect(r.steps.find((s) => s.key === 'extra')?.hidden).toBe(true)
    expect(r.blocker).toMatchObject({ where: 'Save', field: 'reason' })
    const ok = walkthrough({
      layout: steps,
      rows,
      access: access(),
      values: { kind: 'big' },
      thisLayoutId: 1
    })
    expect(ok.blocker).toBeNull()
  })

  it('counts defaults as filled and refuses a role that cannot open or create', () => {
    const r = walkthrough({
      layout: steps,
      rows,
      access: access({ create_fields: ['title'], column_defaults: ['budget'] }),
      values: { kind: 'big', reason: 'x' },
      thisLayoutId: 1
    })
    expect(r.blocker).toBeNull()
    expect(
      walkthrough({
        layout: steps,
        rows,
        access: access({ role_may_open: false }),
        thisLayoutId: 1
      }).blocker?.step
    ).toBe(-1)
    expect(
      walkthrough({ layout: steps, rows, access: access({ can_create: false }), thisLayoutId: 1 })
        .blocker?.step
    ).toBe(-1)
  })

  it('walks a container’s tabs as steps; Next there never validates, Save does', () => {
    const container = layoutOf(
      [
        g('box', 1, { type: 'container' }),
        g('one', 2, { type: 'tab', container_id: 1 }),
        g('two', 3, { type: 'tab', container_id: 1 })
      ],
      [a('title', 'one'), a('budget', 'two')],
      { tab_mode: 'steps', validate_before_next: true }
    )
    const r = walkthrough({
      layout: container,
      rows: [
        { field: 'title', label: 'Title', required: true, group_key: 'one' },
        { field: 'budget', label: 'Budget', required: true, group_key: 'two' }
      ],
      access: access({ create_fields: ['title'] }),
      thisLayoutId: 1
    })
    expect(r.steps.map((s) => s.key)).toEqual(['one', 'two'])
    expect(r.blocker).toMatchObject({ where: 'Save', field: 'budget' })
  })

  it('notes when the role’s new records open on another form', () => {
    const r = walkthrough({
      layout: steps,
      rows,
      access: access({ new_record_form: { layout_id: 9, name: 'Quick' } }),
      values: { kind: 'big' },
      thisLayoutId: 1
    })
    expect(r.notes[0]).toContain('“Quick”')
  })
})

describe('formCost', () => {
  it('counts pickers, grids, widgets, panels and queries the form fires', () => {
    const layout = layoutOf(
      [g('main', 1)],
      [
        a('vendor', 'main'),
        a('lines', 'main'),
        a('tags', 'main'),
        a('vendor.name', 'main'),
        a('notes', 'main'),
        a('hidden_pick', 'main', { is_visible: false }),
        a('__pipeline__', null),
        a('__report__', 'main', { widget_id: 4, label_override: 'Spend' })
      ]
    )
    const relations = [
      {
        many_collection: 'orders',
        many_field: 'vendor',
        one_collection: 'vendors',
        one_field: null,
        junction_field: null
      },
      {
        many_collection: 'lines',
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
      }
    ]
    const cost = formCost({ layout, rows: [], relations, collection: 'orders' })
    expect(cost.counts).toEqual({ picker: 2, grid: 1, widget: 1, panel: 1, query: 1 })
    expect(cost.total).toBe(5 + 2 + 3 + 1 + 2 + 1)
    expect(cost.deferred).toBe(0)
  })

  it('counts a folded section that loads when opened apart (#2713)', () => {
    const layout = layoutOf(
      [g('main', 1), g('more', 2, { is_collapsed: true })],
      [a('notes', 'main'), a('vendor.name', 'more'), a('__report__', 'more', { widget_id: 4 })],
      { conditions: { lazy_sections: ['more'] } }
    )
    const cost = formCost({ layout, rows: [], relations: [], collection: 'orders' })
    expect(cost.total).toBe(5)
    expect(cost.deferred).toBe(2)
    expect(cost.items.filter((i) => i.deferred).map((i) => i.kind)).toEqual(['query', 'widget'])
    expect(cost.counts).toEqual({ picker: 0, grid: 0, widget: 0, panel: 0, query: 0 })
  })
})
