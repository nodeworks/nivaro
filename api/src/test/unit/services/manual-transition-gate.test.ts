import { beforeEach, describe, expect, it, vi } from 'vitest'

// The one gate chain every manual transition runs (record panel, parallel
// branches, bulk). Army 2026-10-25: a Send Back marked "note required" went
// through the API with no note, and a branch transition skipped owner-only.

vi.mock('../../../services/record-access.js', () => ({
  TRANSITION_OWNER_REQUIRED: 'TRANSITION_OWNER_REQUIRED',
  checkTransitionOwner: vi.fn(async () => ({
    allowed: true,
    message: '',
    is_owner: true,
    is_creator: false
  }))
}))
vi.mock('../../../services/transition-requirements.js', () => ({
  evaluateTransitionRequirements: vi.fn(async () => null)
}))
vi.mock('../../../services/workflow-conditions.js', () => ({
  evaluateConditionRules: vi.fn(() => true),
  fetchRecordForConditions: vi.fn(async () => ({}))
}))

vi.mock('../../../services/edit-lock.js', () => ({
  adminOnlyStateOf: vi.fn(async () => null),
  adminOnlyTransitionsFor: vi.fn(async () => new Set<string>())
}))

import { adminOnlyStateOf, adminOnlyTransitionsFor } from '../../../services/edit-lock.js'
import {
  adminOnlyTransitionRefusal,
  commentMissing,
  manualTransitionRefusal,
  TRANSITION_COMMENT_REQUIRED
} from '../../../services/manual-transition-gate.js'
import { checkTransitionOwner } from '../../../services/record-access.js'

const user = { id: 'u-approver', role: 'role-approver' } as never
const instance = { id: 'inst-1', current_state: 's-l1', completed_at: null }
const sendBack = {
  id: 't-send-back',
  from_state: 's-l1',
  required_roles: null,
  comment_mode: 'required'
}
const ask = (over: Record<string, unknown> = {}) =>
  manualTransitionRefusal({
    user,
    isAdmin: false,
    collection: 'workflows',
    item: '372789',
    instance,
    transition: sendBack,
    ...over
  } as never)

beforeEach(() => vi.clearAllMocks())

describe('commentMissing', () => {
  it('needs text only when the move says required', () => {
    expect(commentMissing({ comment_mode: 'required' }, '   ')).toBe(true)
    expect(commentMissing({ comment_mode: 'required' }, undefined)).toBe(true)
    expect(commentMissing({ comment_mode: 'required' }, 'Missing quote')).toBe(false)
    expect(commentMissing({ comment_mode: 'optional' }, '')).toBe(false)
    expect(commentMissing({ comment_mode: null }, undefined)).toBe(false)
  })
})

describe('manualTransitionRefusal', () => {
  it('refuses a required-note move sent with a blank note (422)', async () => {
    const r = await ask({ comment: '   ' })
    expect(r?.status).toBe(422)
    expect(r?.body.code).toBe(TRANSITION_COMMENT_REQUIRED)
  })

  it('lets the same move through with a note', async () => {
    expect(await ask({ comment: 'Quote is missing' })).toBeNull()
  })

  it('refuses an owner-only move for someone who does not own the step', async () => {
    vi.mocked(checkTransitionOwner).mockResolvedValueOnce({
      allowed: false,
      message: 'Only the owner of Level 1 can make this move.',
      is_owner: false,
      is_creator: false
    })
    const r = await ask({
      transition: { ...sendBack, require_owner: 1, comment_mode: 'none' }
    })
    expect(r?.status).toBe(403)
    expect(r?.body.code).toBe('TRANSITION_OWNER_REQUIRED')
  })

  it('lets the step owner make the owner-only move', async () => {
    const r = await ask({ transition: { ...sendBack, require_owner: 1, comment_mode: 'none' } })
    expect(r).toBeNull()
    expect(checkTransitionOwner).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'inst-1', item: '372789' })
    )
  })

  it('refuses an automatic transition and a wrong from-state, even for an admin', async () => {
    const auto = await ask({ isAdmin: true, transition: { ...sendBack, auto_trigger: 1 } })
    expect(auto?.status).toBe(400)
    const wrong = await ask({ isAdmin: true, transition: { ...sendBack, from_state: 's-other' } })
    expect(wrong?.status).toBe(400)
  })

  it('refuses a role-gated move for another role; an admin passes', async () => {
    const tx = { ...sendBack, comment_mode: 'none', required_roles: '["role-vp"]' }
    expect((await ask({ transition: tx }))?.status).toBe(403)
    expect(await ask({ transition: tx, isAdmin: true })).toBeNull()
  })
})

describe('requirement writes ask the gate without requirements or the note', () => {
  it('skips the requirements and the note check; keeps who may run it', async () => {
    const { evaluateTransitionRequirements } = await import(
      '../../../services/transition-requirements.js'
    )
    vi.mocked(evaluateTransitionRequirements).mockResolvedValue([{ type: 'child_fields' }] as never)
    const tx = { ...sendBack, requirements: '[{"type":"child_fields"}]' }
    expect((await ask({ transition: tx, comment: 'note' }))?.status).toBe(422)
    expect(await ask({ transition: tx, skipRequirements: true, skipComment: true })).toBeNull()
    expect(evaluateTransitionRequirements).toHaveBeenCalledTimes(1)
    const roleTx = { ...tx, required_roles: '["role-vp"]' }
    expect(
      (await ask({ transition: roleTx, skipRequirements: true, skipComment: true }))?.status
    ).toBe(403)
  })
})

describe('admin-only transitions', () => {
  // A role this person lacks: a role refusal here would mean the order is wrong.
  const cancel = { id: 'T-CANCEL', from_state: 's-l1', required_roles: '["role-other"]' }
  const ask2 = (over: Record<string, unknown> = {}) =>
    adminOnlyTransitionRefusal({
      isAdmin: false,
      collection: 'workflows',
      item: '372789',
      transitionId: 't-cancel',
      ...over
    })
  const listed = () => {
    vi.mocked(adminOnlyTransitionsFor).mockResolvedValue(new Set(['T-CANCEL']))
    vi.mocked(adminOnlyStateOf).mockResolvedValue({ key: 'approved', label: 'Approved' })
  }

  it('refuses a non-admin running a listed move at an admin-only state', async () => {
    listed()
    const r = await ask2()
    expect(r?.status).toBe(403)
    expect(r?.body.code).toBe('ADMIN_ONLY_TRANSITION')
    expect(r?.body.error).toBe(
      'Only administrators can make this move at Approved. Use Request help to ask for a change.'
    )
  })

  it('lets the same move through while the record is in an approval state', async () => {
    listed()
    vi.mocked(adminOnlyStateOf).mockResolvedValue(null)
    expect(await ask2()).toBeNull()
  })

  it('never refuses an admin', async () => {
    listed()
    expect(await ask2({ isAdmin: true })).toBeNull()
  })

  it('leaves moves that are not listed alone', async () => {
    listed()
    expect(await ask2({ transitionId: 't-forward' })).toBeNull()
  })

  it('runs inside manualTransitionRefusal, before the role and owner checks', async () => {
    listed()
    const r = await ask({ transition: cancel })
    expect(r?.body.code).toBe('ADMIN_ONLY_TRANSITION')
    expect(await ask({ transition: cancel, isAdmin: true })).toBeNull()
  })
})
