import { describe, expect, it } from 'vitest'
import { normalizeSets, roleDefault } from '../../../services/revision-column-sets.js'

const ROLE = '0A1B2C3D-0000-4000-8000-000000000001'

describe('revision column sets', () => {
  it('cleans the sets: names, field names, role ids, one default for everyone', () => {
    const r = normalizeSets([
      {
        name: 'Finance',
        fields: ['requisition_amount', '$step', 'child:lines:1:amount'],
        is_default: true
      },
      { name: 'Approver', fields: ['name'], default_roles: [ROLE.toLowerCase()], is_default: true }
    ])
    if (!('sets' in r)) throw new Error(r.error)
    expect(r.sets.map((s) => s.is_default)).toEqual([true, false])
    expect(r.sets[1].default_roles).toEqual([ROLE])
    expect(normalizeSets([{ name: 'x', fields: ["bad'field"] }])).toHaveProperty('error')
    expect(
      normalizeSets([
        { name: 'A', fields: [] },
        { name: 'a', fields: [] }
      ])
    ).toHaveProperty('error')
  })

  it('a role default wins over the collection default', () => {
    const r = normalizeSets([
      { name: 'Everyone', fields: ['a'], is_default: true },
      { name: 'Approvers', fields: ['b'], default_roles: [ROLE] }
    ])
    if (!('sets' in r)) throw new Error(r.error)
    expect(roleDefault(r.sets, ROLE)?.name).toBe('Approvers')
    expect(roleDefault(r.sets, 'other')?.name).toBe('Everyone')
    expect(roleDefault(r.sets, null)?.name).toBe('Everyone')
  })
})
