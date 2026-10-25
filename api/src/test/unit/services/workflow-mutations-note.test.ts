import { beforeEach, describe, expect, it, vi } from 'vitest'

// The GraphQL transition path copies the REST gate chain; it skipped a
// transition's "note required" (army 2026-10-25, Send Back with no reason).

vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/instance-guard.js', () => ({
  InstanceAccessError: class extends Error {},
  assertInstanceAccess: vi.fn(async () => {})
}))
vi.mock('../../../services/branch-instances.js', () => ({
  findRecordInstance: vi.fn(async () => ({
    id: 'inst-1',
    template: 'tpl',
    collection: 'workflows',
    item: '1',
    current_state: 'S1',
    completed_at: null
  }))
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
      id: 'T-SEND-BACK',
      label: 'Send Back',
      from_state: 'S1',
      to_state: 'S0',
      required_roles: null,
      comment_mode: 'required'
    }))
    return c
  })
}))

import {
  executeWorkflowTransition,
  WorkflowMutationError
} from '../../../services/workflow-mutations.js'
import { applyTransition } from '../../../services/workflow-transitions.js'

const actor = { id: 'u-1', role: 'R', isAdmin: false, user: { id: 'u-1', role: 'R' } } as never

beforeEach(() => vi.clearAllMocks())

describe('executeWorkflowTransition — required note', () => {
  it('refuses a blank note with 422 and never applies the move', async () => {
    const err = await executeWorkflowTransition({
      collection: 'workflows',
      item: '1',
      transitionId: 'T-SEND-BACK',
      comment: '  ',
      actor
    }).catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowMutationError)
    expect(err.statusCode).toBe(422)
    expect(applyTransition).not.toHaveBeenCalled()
  })

  it('applies the move with a note', async () => {
    await executeWorkflowTransition({
      collection: 'workflows',
      item: '1',
      transitionId: 'T-SEND-BACK',
      comment: 'Quote missing',
      actor
    })
    expect(applyTransition).toHaveBeenCalledTimes(1)
  })
})
