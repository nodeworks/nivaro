import { describe, expect, it } from 'vitest'
import { applyLayoutOps, type LayoutBundle, newGroup } from '../../../lib/layout-ops'
import { roleAccess, roleAccessOps } from './role-matrix'

const group = (patch: Record<string, unknown> = {}) => ({
  ...newGroup('money', 'Money', 'section', null),
  ...patch
})

describe('role × section', () => {
  it('reads hidden before read-only, ids case-insensitively', () => {
    expect(roleAccess(group(), 'r1')).toBe('edit')
    expect(roleAccess(group({ locked_for_roles: '["R1"]' }), 'r1')).toBe('readonly')
    expect(
      roleAccess(group({ locked_for_roles: '["r1"]', hidden_for_roles: '["r1"]' }), 'R1')
    ).toBe('hidden')
  })

  it('one group_update per change, moving the role between the lists', () => {
    const g = group({ locked_for_roles: '["r1","r2"]' })
    expect(roleAccessOps(g, 'r1', 'readonly')).toEqual([])
    expect(roleAccessOps(g, 'r1', 'hidden')).toEqual([
      {
        op: 'group_update',
        key: 'money',
        patch: { hidden_for_roles: '["r1"]', locked_for_roles: '["r2"]' }
      }
    ])
    expect(roleAccessOps(group({ hidden_for_roles: '["r1"]' }), 'r1', 'edit')).toEqual([
      {
        op: 'group_update',
        key: 'money',
        patch: { hidden_for_roles: null, locked_for_roles: null }
      }
    ])
  })

  it('the ops apply cleanly to a bundle', () => {
    const bundle: LayoutBundle = {
      layout: { id: 1, collection: 'po' },
      groups: [group()],
      placements: [],
      rev: '1'
    }
    const next = applyLayoutOps(bundle, roleAccessOps(bundle.groups[0], 'r1', 'readonly'))
    expect(next.groups[0].locked_for_roles).toBe('["r1"]')
  })
})
