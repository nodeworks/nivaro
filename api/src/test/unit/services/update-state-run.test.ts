import { beforeEach, describe, expect, it, vi } from 'vitest'

// An update that names a step moves the record through the REAL manual-move path
// (runRecordTransition): the gate, the double-fire claim, applyTransition (instance,
// history row, transition actions), the automatic moves after it and the activity row.
// Only the engine's own bottom layer is stubbed here.

const m = vi.hoisted(() => {
  class TransitionBlockedError extends Error {}
  class TransitionDuplicateError extends Error {}
  class InstanceAccessError extends Error {}
  return {
    TransitionBlockedError,
    TransitionDuplicateError,
    InstanceAccessError,
    gate: vi.fn(),
    apply: vi.fn(),
    runAuto: vi.fn(async () => {}),
    claim: vi.fn(),
    activity: vi.fn(async () => 1),
    transitions: [] as Array<Record<string, unknown>>
  }
})

const STATES = [
  { id: 'S-MGR', key: 'manager_approval', label: 'Manager Approval', sort: 2 },
  { id: 'S-CAN', key: 'canceled', label: 'Canceled', sort: 9 }
]
vi.mock('../../../db/index.js', () => {
  const q = (table: string) => {
    const self: Record<string, unknown> = {
      where: () => self,
      select: async () =>
        table === 'nivaro_workflow_states'
          ? STATES
          : table === 'nivaro_workflow_transitions'
            ? m.transitions
            : [],
      first: async () =>
        table === 'nivaro_workflow_bindings'
          ? { template: 'T-WF' }
          : table === 'nivaro_workflow_transitions'
            ? m.transitions[0]
            : table === 'nivaro_workflow_states'
              ? STATES[0]
              : undefined
    }
    return self
  }
  return { db: q }
})
vi.mock('../../../db/pool-context.js', () => ({
  inBackgroundPool: () => false,
  runInBackgroundPool: (fn: () => unknown) => fn()
}))
vi.mock('../../../services/branch-instances.js', () => ({
  findRecordInstance: async () => ({
    id: 'I-1',
    collection: 'workflows',
    item: '373049',
    template: 'T-WF',
    current_state: 'S-MGR',
    completed_at: null
  })
}))
vi.mock('../../../services/instance-guard.js', () => ({
  assertInstanceAccess: async () => {},
  InstanceAccessError: m.InstanceAccessError
}))
vi.mock('../../../services/manual-transition-gate.js', () => ({
  manualTransitionRefusal: m.gate
}))
vi.mock('../../../services/pipeline-subject.js', () => ({
  resolvePipelineSubject: async (c: string, i: string) => ({ collection: c, itemId: i })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: m.activity }))
vi.mock('../../../services/auto-transition-memory.js', () => ({
  clearAutoFailures: async () => {}
}))
vi.mock('../../../services/chain.js', () => ({
  withChainStep: async (_s: string, fn: () => unknown) => fn()
}))
vi.mock('../../../services/transition-guard.js', () => ({
  claimTransition: m.claim,
  TransitionDuplicateError: m.TransitionDuplicateError
}))
vi.mock('../../../services/workflow-actions.js', () => ({
  TransitionBlockedError: m.TransitionBlockedError
}))
vi.mock('../../../services/workflow-transitions.js', () => ({
  applyTransition: m.apply,
  runAutoTransitions: m.runAuto,
  flushChainEvents: () => {},
  autoChainRunsInBackground: async () => false,
  resolveFriendlyId: async () => 'CM26-1'
}))
vi.mock('../../../services/transition-runs.js', () => ({
  runsInBackground: () => false,
  takeTransitionRun: async () => null,
  TransitionRunningError: class extends Error {}
}))

import { judgeStateMove, planStateMove, runStateMove } from '../../../services/update-state.js'

const user = { id: 'U-LINX', role: 'R-INT' } as never
const CANCEL = {
  id: 'T-CANCEL',
  template: 'T-WF',
  from_state: null,
  to_state: 'S-CAN',
  label: 'Cancel Workflow',
  required_roles: null,
  auto_trigger: false,
  actions: '[{"type":"erp_submit"}]',
  sort: 0
}

beforeEach(() => {
  m.transitions = [CANCEL]
  m.gate.mockReset().mockResolvedValue(null)
  m.claim.mockReset().mockResolvedValue({ release: vi.fn() })
  m.activity.mockClear()
  m.runAuto.mockClear()
  m.apply.mockReset().mockResolvedValue({
    updatedInstance: { id: 'I-1', current_state: 'S-CAN' },
    newStateObj: { id: 'S-CAN', key: 'canceled', label: 'Canceled' },
    previousState: 'S-MGR',
    history_id: 77
  })
})

async function move() {
  const plan = await planStateMove({
    user,
    isAdmin: false,
    collection: 'workflows',
    item: '373049',
    value: 'canceled'
  })
  const chosen = await judgeStateMove(plan, { user, isAdmin: false, comment: 'per LinX' })
  return runStateMove(plan, chosen, { user, isAdmin: false, comment: 'per LinX' })
}

describe('a step named on an update runs the manual move', () => {
  it('moves with history + actions (applyTransition, source manual) and logs the activity', async () => {
    const out = await move()
    expect(out).toMatchObject({
      moved: true,
      from: { key: 'manager_approval' },
      to: { key: 'canceled', label: 'Canceled' },
      transition: { id: 'T-CANCEL', label: 'Cancel Workflow' }
    })
    // The gate ran twice: once before the write (judge), once in the move itself.
    expect(m.gate).toHaveBeenCalledTimes(2)
    expect(m.claim).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'I-1', transitionId: 'T-CANCEL' })
    )
    // applyTransition = the instance update, the history row and the transition actions.
    expect(m.apply).toHaveBeenCalledTimes(1)
    const applied = m.apply.mock.calls[0][0] as Record<string, unknown>
    expect(applied).toMatchObject({
      userId: 'U-LINX',
      comment: 'per LinX',
      source: 'manual',
      transition: expect.objectContaining({ id: 'T-CANCEL', actions: CANCEL.actions })
    })
    expect(m.runAuto).toHaveBeenCalled()
    expect(m.activity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pipeline-transition',
        collection: 'workflows',
        item: '373049',
        user: 'U-LINX'
      })
    )
  })

  it('a partner push refusing the move after the fields were saved: reported, not thrown', async () => {
    m.apply.mockRejectedValue(new m.TransitionBlockedError('Fusion: the order is already closed'))
    const out = await move()
    expect(out.moved).toBe(false)
    expect(out.fields_saved).toBe(true)
    expect(out.status).toBe(422)
    expect(out.error).toContain('Cancel Workflow did not go through. The record was not moved')
    expect(out.error).toContain('Fusion: the order is already closed')
    expect(m.activity).not.toHaveBeenCalled()
  })
})
