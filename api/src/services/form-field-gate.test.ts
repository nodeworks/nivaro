import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── DB fake: table → rows; every builder resolves to the rows its where() keeps ──
const tables: Record<string, Array<Record<string, unknown>>> = {}
function builder(table: string) {
  let rows = [...(tables[table] ?? [])]
  const b: Record<string, unknown> = {
    where(cond: Record<string, unknown>) {
      rows = rows.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v))
      return b
    },
    whereIn(col: string, vals: unknown[]) {
      const set = new Set(vals.map((v) => String(v)))
      rows = rows.filter((r) => set.has(String(r[col])))
      return b
    },
    select: () => b,
    orderBy: () => b,
    first: async () => rows[0],
    catch: () => Promise.resolve(rows),
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(ok, bad)
  }
  return b
}
vi.mock('../db/index.js', () => ({ db: (t: string) => builder(t) }))

const layouts: Array<Record<string, unknown>> = []
vi.mock('../routes/collection-layouts.js', () => ({
  fetchLayoutsForCollection: async () => layouts,
  collectRecordConditionFields: () => ['kind'],
  // Records of kind 'b' open form 2, everything else form 1.
  pickBestLayoutTraced: (_l: unknown, _r: unknown, record: Record<string, unknown> | null) => ({
    row: layouts.find((l) => l.id === (record?.kind === 'b' ? 2 : 1)) ?? null
  })
}))
vi.mock('./collections.js', () => ({
  getFields: async () => [
    { field: 'id', type: 'integer' },
    { field: 'title', type: 'string', label: 'Title' },
    { field: 'amount', type: 'decimal' },
    { field: 'code', type: 'string', readonly: true },
    { field: 'total', type: 'decimal', computed_formula: 'a+b' }
  ],
  getRelations: async () => []
}))
vi.mock('./items.js', () => ({ readItems: vi.fn() }))
vi.mock('./permissions.js', () => ({ getAllowedFields: vi.fn(async () => null) }))
vi.mock('./record-state.js', () => ({
  attachRecordState: async (_c: string, rows: Array<Record<string, unknown>>) => {
    for (const r of rows) r.$state = r.id === '3' ? { key: 'approved' } : null
  }
}))

import {
  bulkFormRefusals,
  type FormShape,
  formLockedFields,
  visibleShape
} from './form-field-gate.js'

const shape = (over: Partial<FormShape> = {}): FormShape => ({
  layout_id: 1,
  name: 'Main',
  ungrouped_sort: null,
  groups: [
    {
      id: 10,
      key: 'details',
      label: 'Details',
      type: 'section',
      sort: 1,
      container_id: null,
      tab_mode: null,
      hidden_for_roles: null,
      locked_for_roles: null,
      visibility_mode: null
    }
  ],
  placements: [
    {
      field: 'title',
      group_key: 'details',
      sort: 1,
      label_override: null,
      is_visible: true,
      lock_conditions: null
    }
  ],
  ...over
})

describe('visibleShape', () => {
  it('drops sections hidden from the role, their children and new-only sections', () => {
    const s = shape({
      groups: [
        { ...shape().groups[0], id: 1, key: 'tab', type: 'container', hidden_for_roles: '["R1"]' },
        { ...shape().groups[0], id: 2, key: 'inner', container_id: 1 },
        { ...shape().groups[0], id: 3, key: 'newonly', visibility_mode: 'new_only' },
        { ...shape().groups[0], id: 4, key: 'open' }
      ],
      placements: [
        { ...shape().placements[0], field: 'a', group_key: 'inner' },
        { ...shape().placements[0], field: 'b', group_key: 'newonly' },
        { ...shape().placements[0], field: 'c', group_key: 'open' },
        { ...shape().placements[0], field: 'd', group_key: 'open', is_visible: false },
        { ...shape().placements[0], field: '__owners__', group_key: 'open' },
        { ...shape().placements[0], field: 'e', group_key: null }
      ]
    })
    const v = visibleShape(s, 'r1', false)
    expect(v.groups.map((g) => g.key)).toEqual(['open'])
    expect(v.placements.map((p) => p.field)).toEqual(['c', 'e'])
    // Admins see role-hidden sections; new-only ones stay off an existing record.
    expect(visibleShape(s, 'r1', true).placements.map((p) => p.field)).toEqual(['a', 'c', 'e'])
  })
})

describe('formLockedFields', () => {
  it('locks a section for the role (not for admins), a role rule and a step rule', () => {
    const s = shape({
      groups: [{ ...shape().groups[0], locked_for_roles: '["role-a"]' }],
      placements: [
        { ...shape().placements[0], field: 'title' },
        {
          ...shape().placements[0],
          field: 'amount',
          group_key: null,
          lock_conditions: JSON.stringify([{ type: 'pipeline_state', state_keys: ['approved'] }])
        },
        {
          ...shape().placements[0],
          field: 'notes',
          group_key: null,
          lock_conditions: JSON.stringify([{ type: 'role', role_ids: ['ROLE-B'] }])
        }
      ]
    })
    const a = formLockedFields({ shape: s, roleId: 'ROLE-A', isAdmin: false, currentState: null })
    expect([...a.keys()]).toEqual(['title'])
    expect(a.get('title')).toBe('The “Details” section is locked for your role')

    const b = formLockedFields({
      shape: s,
      roleId: 'role-b',
      isAdmin: true,
      currentState: 'approved',
      stateLabels: new Map([['approved', 'Approved']]),
      readonlyFields: new Set(['title'])
    })
    expect(b.get('title')).toBe('This field is read-only')
    expect(b.get('amount')).toBe('Locked while the record is in Approved')
    expect(b.get('notes')).toBe('Locked for your role on this form')
  })
})

describe('bulkFormRefusals', () => {
  beforeEach(() => {
    layouts.length = 0
    layouts.push({ id: 1, name: 'Main' }, { id: 2, name: 'Other' })
    tables.nivaro_collections = [{ collection: 'orders' }]
    tables.orders = [
      { id: 1, kind: 'a' },
      { id: 2, kind: 'b' },
      { id: 3, kind: 'a' }
    ]
    tables.nivaro_field_groups = [
      { id: 10, layout_id: 1, key: 'details', label: 'Details', sort: 1 },
      { id: 20, layout_id: 2, key: 'other', label: 'Other', sort: 1 }
    ]
    tables.nivaro_layout_field_assignments = [
      { layout_id: 1, field: 'title', group_key: 'details', sort: 1, is_visible: 1 },
      {
        layout_id: 1,
        field: 'amount',
        group_key: 'details',
        sort: 2,
        is_visible: 1,
        lock_conditions: JSON.stringify([{ type: 'pipeline_state', state_keys: ['approved'] }])
      },
      { layout_id: 2, field: 'amount', group_key: 'other', sort: 1, is_visible: 1 }
    ]
    tables.nivaro_workflow_states = [{ key: 'approved', label: 'Approved' }]
  })

  const user = { id: 'u1', role: 'ROLE-A' } as never

  it('refuses a field locked on the record’s form at its step', async () => {
    const out = await bulkFormRefusals({
      user,
      isAdmin: false,
      collection: 'orders',
      ids: [1, 2, 3],
      fields: ['amount'],
      byForm: false
    })
    expect([...out.entries()]).toEqual([['3', 'amount: Locked while the record is in Approved']])
  })

  it('with byForm, refuses a field that is not on the record’s form', async () => {
    const out = await bulkFormRefusals({
      user,
      isAdmin: false,
      collection: 'orders',
      ids: [1, 2],
      fields: ['title'],
      byForm: true
    })
    expect([...out.entries()]).toEqual([['2', 'Title is not on this record’s form (Other)']])
  })

  it('refuses a read-only field, on a form or without one', async () => {
    const out = await bulkFormRefusals({
      user,
      isAdmin: false,
      collection: 'orders',
      ids: [1],
      fields: ['code'],
      byForm: false
    })
    expect(out.get('1')).toBe('code: this field is read-only')
    layouts.length = 0
    const none = await bulkFormRefusals({
      user,
      isAdmin: false,
      collection: 'orders',
      ids: [1],
      fields: ['code'],
      byForm: false
    })
    expect(none.get('1')).toBe('code: this field is read-only')
  })
})
