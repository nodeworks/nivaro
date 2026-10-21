import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/permissions.js', () => ({
  getAllowedFields: vi.fn(),
  isAdminRole: vi.fn()
}))

import {
  normalizeEmailSection,
  sectionAssignments
} from '../../../services/layout-email-section.js'

const GROUPS = [
  { id: 1, key: 'main', container_id: null, sort: 0, hidden_for_roles: null },
  { id: 2, key: 'tab_a', container_id: 1, sort: 1, hidden_for_roles: null },
  { id: 3, key: 'tab_b', container_id: 1, sort: 0, hidden_for_roles: JSON.stringify(['role-x']) },
  { id: 4, key: 'other', container_id: null, sort: 1, hidden_for_roles: null }
]
const row = (
  field: string,
  group_key: string,
  sort: number,
  extra: Record<string, unknown> = {}
) => ({
  field,
  group_key,
  sort,
  label_override: null,
  overrides: null,
  is_visible: true,
  ...extra
})
const ROWS = [
  row('title', 'main', 1),
  row('status', 'main', 0, { label_override: 'State' }),
  row('__comments__', 'main', 2),
  row('secret', 'main', 3, { overrides: JSON.stringify({ hidden: true }) }),
  row('off', 'main', 4, { is_visible: 0 }),
  row('a1', 'tab_a', 0, {
    overrides: JSON.stringify({ label: 'Alpha', options: { format: 'currency' } })
  }),
  row('b1', 'tab_b', 0),
  row('z', 'other', 0)
]

describe('email section (#2725)', () => {
  it('accepts a group key or null, refuses anything else', () => {
    expect(normalizeEmailSection(null)).toEqual({ value: null })
    expect(normalizeEmailSection('')).toEqual({ value: null })
    expect(normalizeEmailSection('basic_info')).toEqual({ value: 'basic_info' })
    expect(normalizeEmailSection('a b')).toHaveProperty('error')
    expect(normalizeEmailSection(4)).toHaveProperty('error')
  })

  it('lists the section’s fields in form order, then its tabs, skipping slots, hidden and off', () => {
    const out = sectionAssignments(GROUPS, ROWS, 'main', null, true)
    expect(out.map((a) => a.field)).toEqual(['status', 'title', 'b1', 'a1'])
    expect(out[0].label).toBe('State')
    expect(out.find((a) => a.field === 'a1')).toEqual({
      field: 'a1',
      label: 'Alpha',
      format: 'currency'
    })
  })

  it('drops a tab hidden for the recipient’s role, and the whole section when it is', () => {
    expect(sectionAssignments(GROUPS, ROWS, 'main', 'role-x', false).map((a) => a.field)).toEqual([
      'status',
      'title',
      'a1'
    ])
    const hidden = [
      { ...GROUPS[0], hidden_for_roles: JSON.stringify(['role-x']) },
      ...GROUPS.slice(1)
    ]
    expect(sectionAssignments(hidden, ROWS, 'main', 'role-x', false)).toEqual([])
    // An administrator is shown everything.
    expect(sectionAssignments(hidden, ROWS, 'main', 'role-x', true).length).toBeGreaterThan(0)
  })

  it('an unknown section yields nothing', () => {
    expect(sectionAssignments(GROUPS, ROWS, 'gone', null, true)).toEqual([])
  })
})
