import { beforeEach, describe, expect, it, vi } from 'vitest'

// Post-approval lock: the schema-builder `workflow_transition` mutation
// (executeWorkflowTransition) refuses a non-admin a move the collection keeps
// for administrators in an admin-only state, as the REST route does.

vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/instance-guard.js', () => ({
  InstanceAccessError: class extends Error {},
  assertInstanceAccess: vi.fn(async () => {})
}))
vi.mock('../../../services/branch-instances.js', () => ({
  findRecordInstance: vi.fn(async () => ({
    id: 'inst-1',
    template: 'tpl',
    collection: 'orders',
    item: '1',
    current_state: 'S-APPROVED',
    completed_at: null
  }))
}))
vi.mock('../../../services/edit-lock.js', () => ({
  adminOnlyTransitionsFor: vi.fn(async () => new Set(['T-CANCEL'])),
  adminOnlyStateOf: vi.fn(async () => ({ key: 'approved', label: 'Approved' }))
}))
vi.mock('../../../services/transition-guard.js', () => ({
  TransitionDuplicateError: class extends Error {},
  claimTransition: vi.fn(async () => ({ release: async () => {} }))
}))
vi.mock('../../../services/auto-transition-memory.js', () => ({
  clearAutoFailures: vi.fn(async () => {})
}))
vi.mock('../../../services/chain.js', () => ({
  withChainStep: vi.fn(async (_k: string, fn: () => unknown) => fn())
}))
vi.mock('../../../services/workflow-transitions.js', () => ({
  applyTransition: vi.fn(async () => ({ updatedInstance: { id: 'inst-1' }, newStateObj: null })),
  coerceBool: (v: unknown) => v === true || v === 1 || v === '1',
  resolveTransitionTarget: vi.fn(),
  runAutoTransitions: vi.fn(async () => {})
}))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => {
    const c: Record<string, unknown> = {}
    c.where = vi.fn(() => c)
    c.first = vi.fn(async () => ({
      id: 'T-CANCEL',
      label: 'Cancel',
      from_state: null,
      to_state: 'S-CANCELED',
      required_roles: null
    }))
    return c
  })
}))

import {
  clearTransitionChecks,
  registerTransitionCheck
} from '../../../services/transition-checks.js'
import {
  executeWorkflowTransition,
  WorkflowMutationError
} from '../../../services/workflow-mutations.js'
import { applyTransition } from '../../../services/workflow-transitions.js'

const actor = (isAdmin: boolean) =>
  ({ id: 'u-1', role: 'R', isAdmin, user: { id: 'u-1', role: 'R' } }) as never

beforeEach(() => vi.clearAllMocks())

describe('executeWorkflowTransition — admin-only moves', () => {
  it('refuses a non-admin with 403 ADMIN_ONLY_TRANSITION and never applies the move', async () => {
    const err = await executeWorkflowTransition({
      collection: 'orders',
      item: '1',
      transitionId: 'T-CANCEL',
      actor: actor(false)
    }).catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowMutationError)
    expect(err.statusCode).toBe(403)
    expect(err.message).toBe(
      'Only administrators can make this move at Approved. Use Request help to ask for a change.'
    )
    expect(err.extras).toEqual({ code: 'ADMIN_ONLY_TRANSITION' })
    expect(applyTransition).not.toHaveBeenCalled()
  })

  it('applies the move for an administrator', async () => {
    await executeWorkflowTransition({
      collection: 'orders',
      item: '1',
      transitionId: 'T-CANCEL',
      actor: actor(true)
    })
    expect(applyTransition).toHaveBeenCalledTimes(1)
  })
})

describe('executeWorkflowTransition — extension checks', () => {
  it("refuses with the check's status and code, and never applies the move", async () => {
    registerTransitionCheck('ext', async () => ({
      status: 422,
      error: 'Over budget',
      code: 'VETO'
    }))
    try {
      const err = await executeWorkflowTransition({
        collection: 'orders',
        item: '1',
        transitionId: 'T-CANCEL',
        actor: actor(true)
      }).catch((e) => e)
      expect(err).toBeInstanceOf(WorkflowMutationError)
      expect(err.statusCode).toBe(422)
      expect(err.message).toBe('Over budget')
      expect(err.extras).toEqual({ code: 'VETO' })
      expect(applyTransition).not.toHaveBeenCalled()
    } finally {
      clearTransitionChecks()
    }
  })
})
