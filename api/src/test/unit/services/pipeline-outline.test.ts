import { describe, expect, it } from 'vitest'
import {
  type OutlineTransitionRow,
  pipelineOutline,
  roleMayRun
} from '../../../services/pipeline-outline.js'

// GET /pipelines/:id/outline — what a list view (state filter, bulk bar) may
// know of a template. Never more transitions than the record panel offers.

const tx = (over: Partial<OutlineTransitionRow>): OutlineTransitionRow => ({
  id: 't',
  label: 'Go',
  from_state: null,
  to_state: 's2',
  color: null,
  sort: 1,
  group_label: null,
  required_roles: null,
  auto_trigger: 0,
  require_owner: 0,
  ...over
})

const STATES = [
  {
    id: 's1',
    key: 'draft',
    label: 'Draft',
    color: '#ccc',
    sort: 1,
    is_initial: 1,
    is_terminal: 0,
    // a column the outline must not pass through
    skip_criteria: '{"x":1}'
  }
]

describe('roleMayRun', () => {
  it('matches roles case-insensitively, open when none are required', () => {
    expect(roleMayRun(null, { isAdmin: false, role: 'r1' })).toBe(true)
    expect(roleMayRun('[]', { isAdmin: false, role: null })).toBe(true)
    expect(roleMayRun('["R1"]', { isAdmin: false, role: 'r1' })).toBe(true)
    expect(roleMayRun('["R1"]', { isAdmin: false, role: 'R2' })).toBe(false)
    expect(roleMayRun('["R1"]', { isAdmin: false, role: null })).toBe(false)
    expect(roleMayRun('["R1"]', { isAdmin: true, role: null })).toBe(true)
  })
})

describe('pipelineOutline', () => {
  const transitions = [
    tx({ id: 'open', label: 'Submit' }),
    tx({ id: 'roleOk', label: 'Approve', required_roles: '["APPROVER"]' }),
    tx({ id: 'roleNo', label: 'Override', required_roles: '["FINANCE"]' }),
    tx({ id: 'auto', label: 'Auto close', auto_trigger: 1 }),
    tx({ id: 'owner', label: 'Sign off', require_owner: 1 })
  ]

  it('offers a non-admin only what their role may run, never automatic moves', () => {
    const out = pipelineOutline(STATES, transitions, { isAdmin: false, role: 'approver' })
    expect(out.transitions.map((t) => t.id)).toEqual(['open', 'roleOk', 'owner'])
    expect(out.transitions[2].require_owner).toBe(true)
    // No role lists, actions or conditions leave the server.
    expect(Object.keys(out.transitions[0]).sort()).toEqual(
      [
        'color',
        'from_state',
        'group_label',
        'id',
        'label',
        'require_owner',
        'sort',
        'to_state'
      ].sort()
    )
  })

  it('offers an admin every manual transition', () => {
    const out = pipelineOutline(STATES, transitions, { isAdmin: true, role: null })
    expect(out.transitions.map((t) => t.id)).toEqual(['open', 'roleOk', 'roleNo', 'owner'])
  })

  it('gives states as id/key/label/color/sort and two flags', () => {
    const out = pipelineOutline(STATES, [], { isAdmin: false, role: null })
    expect(out.states).toEqual([
      {
        id: 's1',
        key: 'draft',
        label: 'Draft',
        color: '#ccc',
        sort: 1,
        is_initial: true,
        is_terminal: false
      }
    ])
  })
})
