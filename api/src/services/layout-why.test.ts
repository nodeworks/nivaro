import { describe, expect, it } from 'vitest'
import { stripEditorNotes } from './layout-editor-notes.js'
import { explainFieldLocks, explainHiddenFields, orList, type WhyInput } from './layout-why.js'

const base = (over: Partial<WhyInput> = {}): WhyInput => ({
  layoutName: 'Request',
  groups: [],
  placements: [],
  roleId: 'r-tech',
  roleName: 'Field Tech',
  isAdmin: false,
  roleNames: new Map([
    ['R-TECH', 'Field Tech'],
    ['R-FIN', 'Finance']
  ]),
  stateLabels: new Map([
    ['approved', 'Approved'],
    ['closed', 'Closed']
  ]),
  currentState: null,
  updatable: null,
  readable: null,
  ...over
})

describe('orList', () => {
  it('joins names', () => {
    expect(orList(['A'])).toBe('A')
    expect(orList(['A', 'B'])).toBe('A or B')
    expect(orList(['A', 'B', 'C'])).toBe('A, B or C')
  })
})

describe('explainFieldLocks', () => {
  it('names the section that locks a field for the viewer role, nested sections included', () => {
    const locks = explainFieldLocks(
      base({
        groups: [
          {
            key: 'money',
            label: 'Budget',
            parent_key: null,
            visible_when: null,
            hidden_for_roles: null,
            locked_for_roles: JSON.stringify(['R-TECH'])
          },
          {
            key: 'inner',
            label: 'Inner',
            parent_key: 'money',
            visible_when: null,
            hidden_for_roles: null,
            locked_for_roles: null
          }
        ],
        placements: [
          { field: 'amount', group_key: 'inner', is_visible: true, lock_conditions: null },
          { field: 'title', group_key: null, is_visible: true, lock_conditions: null }
        ]
      })
    )
    expect(locks.amount).toEqual({
      kind: 'section',
      text: 'The “Budget” section is locked for the Field Tech role on the “Request” form'
    })
    expect(locks.title).toBeUndefined()
  })

  it('names the step a lock rule lists, only when the record is in it', () => {
    const p = {
      field: 'amount',
      group_key: null,
      is_visible: true,
      lock_conditions: JSON.stringify([
        { type: 'pipeline_state', state_keys: ['approved', 'closed'] }
      ])
    }
    expect(explainFieldLocks(base({ placements: [p], currentState: 'approved' })).amount).toEqual({
      kind: 'state',
      text: 'Locked while the record is in Approved, by a rule on the “Request” form'
    })
    // Step unknown: the rule's steps, at most three then a count.
    expect(explainFieldLocks(base({ placements: [p] })).amount.text).toBe(
      'Locked while the record is in Approved or Closed, by a rule on the “Request” form'
    )
    const many = {
      ...p,
      lock_conditions: JSON.stringify([
        { type: 'pipeline_state', state_keys: ['a', 'b', 'c', 'd', 'e'] }
      ])
    }
    expect(explainFieldLocks(base({ placements: [many] })).amount.text).toBe(
      'Locked while the record is in A, B, C or 2 other steps, by a rule on the “Request” form'
    )
    expect(explainFieldLocks(base({ placements: [p], currentState: 'draft' })).amount).toBe(
      undefined
    )
  })

  it('names only the viewer role to a non-admin, every role to an admin', () => {
    const p = {
      field: 'amount',
      group_key: null,
      is_visible: true,
      lock_conditions: JSON.stringify([{ type: 'role', role_ids: ['r-fin', 'r-tech'] }])
    }
    expect(explainFieldLocks(base({ placements: [p] })).amount.text).toBe(
      'Locked for the Field Tech role by a rule on the “Request” form'
    )
    expect(explainFieldLocks(base({ placements: [p], isAdmin: true })).amount.text).toBe(
      'Locked for the Finance or Field Tech roles by a rule on the “Request” form'
    )
    // A rule for other roles says nothing to this viewer.
    expect(explainFieldLocks(base({ placements: [p], roleId: 'r-other' })).amount).toBeUndefined()
  })

  it('explains readable-but-not-updatable fields from the role permissions', () => {
    const locks = explainFieldLocks(
      base({
        placements: [
          { field: 'amount', group_key: null, is_visible: true, lock_conditions: null },
          { field: 'title', group_key: null, is_visible: true, lock_conditions: null },
          { field: 'secret', group_key: null, is_visible: true, lock_conditions: null }
        ],
        updatable: ['title'],
        readable: ['title', 'amount']
      })
    )
    expect(locks.amount.kind).toBe('permission')
    expect(locks.amount.text).toBe(
      'The Field Tech role can read this field but not change it (role permissions)'
    )
    expect(locks.title).toBeUndefined()
    expect(locks.secret).toBeUndefined()
  })
})

describe('explainHiddenFields', () => {
  it('lists fields under step rules, role-hidden sections and fields turned off', () => {
    const hidden = explainHiddenFields(
      base({
        isAdmin: true,
        groups: [
          {
            key: 'step2',
            label: 'Approval',
            parent_key: null,
            visible_when: JSON.stringify([{ field: 'kind', op: 'eq', value: 'big' }]),
            hidden_for_roles: null,
            locked_for_roles: null
          },
          {
            key: 'fin',
            label: null,
            parent_key: null,
            visible_when: null,
            hidden_for_roles: JSON.stringify(['R-TECH']),
            locked_for_roles: null
          }
        ],
        placements: [
          { field: 'approver', group_key: 'step2', is_visible: true, lock_conditions: null },
          { field: 'cost', group_key: 'fin', is_visible: true, lock_conditions: null },
          { field: 'legacy', group_key: null, is_visible: false, lock_conditions: null },
          { field: '__comments__', group_key: null, is_visible: false, lock_conditions: null }
        ]
      })
    )
    expect(hidden.map((h) => [h.field, h.kind])).toEqual([
      ['approver', 'step_rule'],
      ['cost', 'section_roles'],
      ['legacy', 'off']
    ])
    expect(hidden[0].rules).toEqual([{ field: 'kind', op: 'eq', value: 'big' }])
    expect(hidden[1].text).toBe('The “Fin” section is hidden from Field Tech')
  })
})

describe('stripEditorNotes', () => {
  it('drops section notes and the note key inside placement overrides', () => {
    const note = { text: 'Finance asked for this', by: 'u1', by_name: 'Ann', at: '2026-10-20' }
    const { groups, assignments } = stripEditorNotes(
      [{ key: 'a', editor_note: JSON.stringify(note) }, { key: 'b' }],
      [
        { field: 'x', overrides: JSON.stringify({ note: 'help', editor_note: note }) },
        { field: 'y', overrides: { label: 'Y', editor_note: note } },
        { field: 'z', overrides: null }
      ]
    )
    expect(groups).toEqual([{ key: 'a' }, { key: 'b' }])
    expect(JSON.parse(assignments[0].overrides as string)).toEqual({ note: 'help' })
    expect(assignments[1].overrides).toEqual({ label: 'Y' })
    expect(assignments[2].overrides).toBeNull()
  })
})
