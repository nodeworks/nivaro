import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../services/permissions.js', () => ({
  can: async () => true,
  getAllowedFields: async () => null
}))

import {
  cleanValues,
  type FormFieldRow,
  type FormGroupRow,
  type JudgeInput,
  judgeFormState
} from '../../../services/form-state.js'
import { matchesVisibleWhen } from '../../../services/visible-when.js'

const SHARED_TWIN = new URL(
  '../../../../../packages/shared/src/lib/visible-when.ts',
  import.meta.url
)
const API_TWIN = new URL('../../../services/visible-when.ts', import.meta.url)

describe('visible-when twin', () => {
  it('is byte-identical to the packages/shared twin', () => {
    expect(readFileSync(API_TWIN, 'utf8')).toBe(readFileSync(SHARED_TWIN, 'utf8'))
  })
  it('judges in as a comma list, like the record form', () => {
    expect(matchesVisibleWhen('[{"field":"k","op":"in","value":"a, b"}]', { k: 'b' })).toBe(true)
    expect(matchesVisibleWhen([{ field: 'k', op: 'nnull' }], { k: '' })).toBe(false)
  })
})

const groups: FormGroupRow[] = [
  { key: 'main', label: 'Main', type: 'section', parent_key: null },
  {
    key: 'money',
    label: 'Money',
    type: 'section',
    parent_key: null,
    locked_for_roles: '["role-fin"]'
  },
  {
    key: 'ops',
    label: 'Ops',
    type: 'section',
    parent_key: null,
    hidden_for_roles: JSON.stringify(['ROLE-FIN'])
  },
  {
    key: 'step2',
    label: 'Approval',
    type: 'tab',
    parent_key: null,
    visible_when: '[{"field":"kind","op":"eq","value":"capex"}]'
  },
  { key: 'inner', label: 'Inner', type: 'section', parent_key: 'step2' }
]

const row = (field: string, group_key: string | null, extra: Partial<FormFieldRow> = {}) =>
  ({ field, label: field, group_key, layout_assigned: true, ...extra }) as FormFieldRow

const base = (over: Partial<JudgeInput> = {}): JudgeInput => ({
  groups,
  rows: [
    row('title', 'main', { required: true }),
    row('kind', 'main'),
    row('amount', 'money'),
    row('notes', 'ops'),
    row('approver', 'inner'),
    row('secret', 'main'),
    row('off', 'main', { is_visible: false }),
    row('total', 'main', { readonly: true, computed_type: 'rollup' }),
    row('code', 'main', {
      validation_rules: [{ type: 'required_if', field: 'kind', op: 'eq', value: 'capex' }]
    }),
    row('promo', 'main', {
      visibility_rules: { show_when: [{ field: 'kind', operator: 'eq', value: 'promo' }] }
    }),
    row('frozen', 'main', { lock_condition: { field: 'kind', operator: 'eq', value: 'capex' } }),
    row('stage_locked', 'main', {
      lock_conditions: JSON.stringify([{ type: 'pipeline_state', state_keys: ['approved'] }])
    }),
    row('__pipeline__', 'main'),
    row('unplaced', null, { layout_assigned: false })
  ],
  values: { title: '', kind: 'capex' },
  roleId: 'role-fin',
  isAdmin: false,
  readable: [
    'title',
    'kind',
    'amount',
    'notes',
    'approver',
    'off',
    'total',
    'code',
    'promo',
    'frozen',
    'stage_locked'
  ],
  updatable: ['title', 'kind', 'amount', 'notes', 'approver', 'code', 'promo', 'frozen'],
  canUpdate: true,
  stateKey: 'approved',
  ...over
})

const byField = (input: JudgeInput) =>
  new Map(judgeFormState(input).fields.map((f) => [f.field, f]))

describe('judgeFormState (#3218)', () => {
  it('skips sentinel and unplaced fields', () => {
    const f = byField(base())
    expect(f.has('__pipeline__')).toBe(false)
    expect(f.has('unplaced')).toBe(false)
  })

  it('hides by permission, by the form, by a field rule and by section rules', () => {
    const f = byField(base())
    expect(f.get('secret')).toMatchObject({ visible: false, hidden_by: 'permission' })
    expect(f.get('off')).toMatchObject({ visible: false, hidden_by: 'off_on_form' })
    expect(f.get('promo')).toMatchObject({ visible: false, hidden_by: 'field_rule' })
    expect(f.get('notes')).toMatchObject({ visible: false, hidden_by: 'section_role' })
    // The step's rule matches (kind = capex), so its nested section shows.
    expect(f.get('approver')).toMatchObject({ visible: true })
    const other = byField(base({ values: { kind: 'opex' } }))
    expect(other.get('approver')).toMatchObject({ visible: false, hidden_by: 'section_rule' })
    expect(other.get('approver')?.why).toMatch(/hidden/)
  })

  it('locks by section role, computed, field rule, step rule and permission', () => {
    const f = byField(base())
    expect(f.get('amount')).toMatchObject({ locked: true, locked_by: 'section_role' })
    expect(f.get('total')).toMatchObject({ locked: true, locked_by: 'computed' })
    expect(f.get('frozen')).toMatchObject({ locked: true, locked_by: 'field_rule' })
    expect(f.get('stage_locked')).toMatchObject({ locked: true, locked_by: 'state_rule' })
    expect(f.get('kind')).toMatchObject({ locked: false })
    const noWrite = byField(base({ stateKey: 'draft' }))
    expect(noWrite.get('stage_locked')).toMatchObject({ locked: true, locked_by: 'permission' })
    const record = byField(base({ canUpdate: false }))
    expect(record.get('title')).toMatchObject({ locked: true, locked_by: 'record' })
  })

  it('requires from the field, the form and required_if rules; flags missing values', () => {
    const f = byField(base())
    expect(f.get('title')).toMatchObject({ required: true, missing: true })
    expect(f.get('code')).toMatchObject({ required: true, missing: true })
    const opex = byField(base({ values: { title: 'Hi', kind: 'opex' } }))
    expect(opex.get('title')?.missing).toBeUndefined()
    expect(opex.get('code')).toMatchObject({ required: false })
  })

  it('administrators are exempt from section role rules and field permissions', () => {
    const f = byField(base({ isAdmin: true, readable: null, updatable: null }))
    expect(f.get('notes')).toMatchObject({ visible: true })
    expect(f.get('amount')).toMatchObject({ locked: false })
    expect(f.get('secret')).toMatchObject({ visible: true })
  })

  it('reports sections with why', () => {
    const g = new Map(judgeFormState(base()).groups.map((x) => [x.key, x]))
    expect(g.get('ops')).toMatchObject({ visible: false })
    expect(g.get('money')).toMatchObject({ visible: true, locked: true })
    expect(g.get('inner')).toMatchObject({ visible: true })
  })
})

describe('cleanValues', () => {
  it('keeps plain field keys of an object only', () => {
    expect(cleanValues({ a: 1, 'b c': 2, _x: 3, 'x;drop': 4 })).toEqual({ a: 1, _x: 3 })
    expect(cleanValues([1, 2])).toEqual({})
    expect(cleanValues('x')).toEqual({})
  })
})
