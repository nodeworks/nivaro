import { describe, expect, it } from 'vitest'
import { matchesVisibleWhen } from '../../../lib/visible-when'
import type { ActiveLayoutData } from '../../item-edit/types'
import {
  compareMarks,
  drivingFields,
  fieldAccessForRole,
  fieldsLockedInState,
  leavingNeeds,
  type RoleAccessInput,
  visibilityChanges,
  whoSeesFields,
  whoTint
} from './preview-model'

const FIN = 'aaaa0000-0000-0000-0000-000000000001'
const ENG = 'bbbb0000-0000-0000-0000-000000000002'

function layout(): ActiveLayoutData {
  return {
    layout: { id: 1, name: 'Main' } as ActiveLayoutData['layout'],
    groups: [
      { id: 1, key: 'money', label: 'Money', type: 'section', sort: 0 },
      {
        id: 2,
        key: 'secret',
        label: 'Secret',
        type: 'section',
        sort: 1,
        hidden_for_roles: JSON.stringify([ENG.toLowerCase()])
      },
      {
        id: 3,
        key: 'audit',
        label: 'Audit',
        type: 'section',
        sort: 2,
        locked_for_roles: JSON.stringify([FIN])
      },
      {
        id: 4,
        key: 'sparing',
        label: 'Sparing',
        type: 'tab',
        sort: 3,
        visible_when: JSON.stringify([{ field: 'is_sparing', op: 'eq', value: 'true' }])
      },
      {
        id: 5,
        key: 'region',
        label: 'Region step',
        type: 'tab',
        sort: 4,
        visible_when: JSON.stringify([{ field: 'kind', op: 'in', value: 'a, b' }])
      }
    ] as unknown as ActiveLayoutData['groups'],
    assignments: [
      { field: 'amount', group_key: 'money', sort: 0 },
      {
        field: 'budget',
        group_key: 'money',
        sort: 1,
        lock_conditions: JSON.stringify([
          { type: 'pipeline_state', state_keys: ['review'] },
          { type: 'role', role_ids: [ENG] }
        ])
      },
      { field: 'cost_code', group_key: 'secret', sort: 0 },
      { field: 'notes', group_key: 'audit', sort: 0 },
      { field: '__comments__', group_key: 'money', sort: 9 }
    ] as unknown as ActiveLayoutData['assignments'],
    ungrouped_sort: null
  }
}

function access(id: string, name: string, over: Partial<RoleAccessInput> = {}): RoleAccessInput {
  return {
    role: { id, name, admin_access: false },
    can_read: true,
    can_update: true,
    hidden_fields: [],
    readonly_fields: [],
    ...over
  }
}

describe('fieldAccessForRole', () => {
  it('combines permissions with section and role-lock rules', () => {
    const fin = fieldAccessForRole(
      access(FIN, 'Finance', { readonly_fields: ['amount'] }),
      layout()
    )
    expect(Object.fromEntries(fin)).toEqual({
      amount: 'readonly',
      budget: 'editable',
      cost_code: 'editable',
      notes: 'readonly'
    })
    const eng = fieldAccessForRole(access(ENG, 'Engineering'), layout())
    expect(eng.get('cost_code')).toBe('hidden') // hidden_for_roles matches case-insensitively
    expect(eng.get('budget')).toBe('readonly') // role lock
    expect(eng.has('__comments__')).toBe(false)
  })

  it('administrators skip section rules; no read access hides everything', () => {
    const admin = fieldAccessForRole(
      { ...access(ENG, 'Admin'), role: { id: ENG, name: 'Admin', admin_access: true } },
      layout()
    )
    expect(admin.get('cost_code')).toBe('editable')
    const none = fieldAccessForRole(access(FIN, 'Guest', { can_read: false }), layout())
    expect([...none.values()].every((v) => v === 'hidden')).toBe(true)
  })
})

describe('compareMarks', () => {
  it('marks fields and sections the two roles get differently', () => {
    const marks = compareMarks(layout(), access(FIN, 'Finance'), access(ENG, 'Engineering'))
    expect(marks({ kind: 'field', field: 'amount', group_key: 'money' })).toEqual([])
    const budget = marks({ kind: 'field', field: 'budget', group_key: 'money' })
    expect(budget[0]).toMatchObject({ text: 'Differs', highlight: true })
    expect(budget[0].tip).toBe('Finance: can edit · Engineering: read-only')
    expect(marks({ kind: 'group', key: 'secret' })[0].tip).toBe(
      'Engineering does not see this section'
    )
    expect(marks({ kind: 'group', key: 'money' })).toEqual([])
  })
})

describe('whoSeesFields / whoTint', () => {
  it('lists roles per field and tints by share', () => {
    const who = whoSeesFields(
      [access(FIN, 'Finance'), access(ENG, 'Engineering'), access('c', 'Ops', { can_read: false })],
      layout()
    )
    expect(who.get('cost_code')).toEqual({
      edit: ['Finance'],
      read: [],
      hidden: ['Engineering', 'Ops']
    })
    expect(whoTint(who.get('cost_code')!)).toBe('some') // 1 of 3
    expect(whoTint({ edit: ['a'], read: [], hidden: ['b', 'c', 'd'] })).toBe('few')
    expect(whoTint(who.get('amount')!)).toBe('most')
    expect(whoTint({ edit: ['a'], read: ['b'], hidden: [] })).toBe('all')
    expect(whoTint({ edit: [], read: [], hidden: ['a'] })).toBe('none')
    expect(whoTint({ edit: ['a'], read: [], hidden: ['b'] })).toBe('some')
  })
})

describe('workflow state', () => {
  it('finds the fields a state locks', () => {
    expect(fieldsLockedInState(layout(), 'review')).toEqual(['budget'])
    expect(fieldsLockedInState(layout(), 'draft')).toEqual([])
  })
  it('lists what moving on from a state needs', () => {
    const needs = leavingNeeds(
      [
        { label: 'Approve', from_state: 's1', requirements: [{ type: 'x', fields: ['amount'] }] },
        { label: 'Cancel', from_state: null, requirements: null },
        { label: 'Close', from_state: 's2', requirements: [{ type: 'x', fields: ['notes'] }] },
        {
          label: 'Submit',
          from_state: null,
          requirements: [{ type: 'child', collection: 'lines', fields: ['qty'] }]
        }
      ],
      's1'
    )
    expect(needs).toEqual([
      { label: 'Approve', fields: ['amount'], collection: null },
      { label: 'Submit', fields: ['qty'], collection: 'lines' }
    ])
  })
})

describe('what if', () => {
  it('lists driving fields with the values they test', () => {
    expect(drivingFields(layout())).toEqual([
      { field: 'is_sparing', values: ['true'], drives: ['Sparing'] },
      { field: 'kind', values: ['a', 'b'], drives: ['Region step'] }
    ])
  })
  it('reports what appears and disappears', () => {
    expect(visibilityChanges(layout(), { kind: 'a' }, { kind: 'z', is_sparing: 'true' })).toEqual({
      shown: ['sparing'],
      hidden: ['region']
    })
  })
  it('the shared evaluator answers like the form did', () => {
    expect(matchesVisibleWhen(null, {})).toBe(true)
    expect(matchesVisibleWhen('not json', {})).toBe(true)
    expect(matchesVisibleWhen('[{"field":"x","op":"null"}]', { x: '' })).toBe(true)
    expect(matchesVisibleWhen('[{"field":"x","op":"nnull"}]', { x: '' })).toBe(false)
    expect(matchesVisibleWhen('[{"field":"x","op":"neq","value":1}]', { x: 1 })).toBe(false)
    expect(matchesVisibleWhen([{ field: 'x', value: true }], { x: true })).toBe(true)
  })
})
