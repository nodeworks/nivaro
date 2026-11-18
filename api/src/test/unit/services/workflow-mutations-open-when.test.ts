import { beforeEach, describe, expect, it, vi } from 'vitest'

// open_when on the GraphQL / MCP path (executeWorkflowTransition): the owner
// gate gets the move's open_when, the same as the REST gate (migration 533).

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
  adminOnlyTransitionsFor: vi.fn(async () => new Set<string>()),
  adminOnlyStateOf: vi.fn(async () => null)
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
  runAutoTransitions: vi.fn(async () => {}),
  flushChainEvents: vi.fn(),
  // executeWorkflowTransition runs runRecordTransition (the one manual-move path) since 2026-11-18.
  autoChainRunsInBackground: vi.fn(async () => false),
  resolveFriendlyId: vi.fn(async () => 'O-1')
}))
const OPEN_WHEN = '[{"field":"$state","op":"neq","value":"waiting_on_po"}]'
vi.mock('../../../services/record-access.js', () => ({
  TRANSITION_OWNER_REQUIRED: 'TRANSITION_OWNER_REQUIRED',
  checkTransitionOwner: vi.fn()
}))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => {
    const c: Record<string, unknown> = {}
    c.where = vi.fn(() => c)
    c.first = vi.fn(async () => ({
      id: 'T-SEND-BACK',
      label: 'Send Back',
      from_state: null,
      to_state: 'S0',
      required_roles: null,
      require_owner: 1,
      open_when: OPEN_WHEN
    }))
    return c
  })
}))

import { checkTransitionOwner } from '../../../services/record-access.js'
import {
  executeWorkflowTransition,
  WorkflowMutationError
} from '../../../services/workflow-mutations.js'
import { applyTransition } from '../../../services/workflow-transitions.js'

const actor = (isAdmin: boolean) =>
  ({ id: 'u-1', role: 'R', isAdmin, user: { id: 'u-1', role: 'R' } }) as never
const run = (isAdmin = false) =>
  executeWorkflowTransition({
    collection: 'orders',
    item: '1',
    transitionId: 'T-SEND-BACK',
    actor: actor(isAdmin)
  })

beforeEach(() => vi.clearAllMocks())

describe('executeWorkflowTransition — open_when', () => {
  it('a non-owner moves the record while its open_when holds', async () => {
    vi.mocked(checkTransitionOwner).mockResolvedValueOnce({
      allowed: true,
      message: '',
      is_owner: false,
      is_creator: false,
      open: true
    })
    await run()
    expect(checkTransitionOwner).toHaveBeenCalledWith(
      expect.objectContaining({ openWhen: OPEN_WHEN, instanceId: 'inst-1' })
    )
    expect(applyTransition).toHaveBeenCalledTimes(1)
  })

  it('refuses with the owner code when it does not hold', async () => {
    vi.mocked(checkTransitionOwner).mockResolvedValueOnce({
      allowed: false,
      message:
        'Anyone can make this move while … — this record does not meet that, so only the owner of X can.',
      is_owner: false,
      is_creator: false,
      open_when_unmet: true
    })
    const err = await run().catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowMutationError)
    expect(err.statusCode).toBe(403)
    expect(err.extras).toEqual({ code: 'TRANSITION_OWNER_REQUIRED' })
    expect(applyTransition).not.toHaveBeenCalled()
  })

  it('admins are never refused (the shared gate asks with isAdmin; the owner check exempts them)', async () => {
    vi.mocked(checkTransitionOwner).mockResolvedValueOnce({
      allowed: true,
      message: '',
      is_owner: false,
      is_creator: false
    })
    await run(true)
    expect(checkTransitionOwner).toHaveBeenCalledWith(expect.objectContaining({ isAdmin: true }))
    expect(applyTransition).toHaveBeenCalledTimes(1)
  })
})
