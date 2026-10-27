import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  class InstanceAccessError extends Error {
    statusCode = 403
  }
  class TransitionDuplicateError extends Error {
    code = 'TRANSITION_DUPLICATE'
    first = { at: 'x' }
  }
  class TransitionBlockedError extends Error {}
  return {
    InstanceAccessError,
    TransitionDuplicateError,
    TransitionBlockedError,
    assertInstanceAccess: vi.fn(async () => {}),
    findRecordInstance: vi.fn(),
    refusal: vi.fn(),
    claim: vi.fn(),
    apply: vi.fn(),
    transition: undefined as unknown
  }
})

vi.mock('../../../db/index.js', () => ({
  db: (t: string) => ({
    where: () => ({
      first: async () => (t === 'nivaro_workflow_transitions' ? m.transition : null)
    })
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/auto-transition-memory.js', () => ({
  clearAutoFailures: vi.fn(async () => {})
}))
vi.mock('../../../services/branch-instances.js', () => ({
  findRecordInstance: m.findRecordInstance
}))
vi.mock('../../../services/chain.js', () => ({
  withChainStep: async (_s: string, fn: () => unknown) => fn()
}))
vi.mock('../../../services/instance-guard.js', () => ({
  assertInstanceAccess: m.assertInstanceAccess,
  InstanceAccessError: m.InstanceAccessError
}))
vi.mock('../../../services/manual-transition-gate.js', () => ({
  manualTransitionRefusal: m.refusal
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
  runAutoTransitions: vi.fn(async () => {})
}))

import { runRecordTransition } from '../../../services/record-transition.js'

const opts = {
  user: { id: 'u1' } as never,
  isAdmin: false,
  collection: 'orders',
  item: '5',
  transitionId: 't1',
  log: {} as never
}

beforeEach(() => {
  m.assertInstanceAccess.mockReset().mockResolvedValue(undefined)
  m.findRecordInstance.mockReset().mockResolvedValue({ id: 'i1', template: 'tpl' })
  m.refusal.mockReset().mockResolvedValue(null)
  m.claim.mockReset().mockResolvedValue({ release: vi.fn() })
  m.transition = { id: 't1', template: 'tpl', label: 'Approve' }
  m.apply.mockReset().mockResolvedValue({
    updatedInstance: { id: 'i1', current_state: 's2' },
    newStateObj: null,
    previousState: null,
    history_id: null
  })
})

describe('runRecordTransition', () => {
  it('404 when no instance', async () => {
    m.findRecordInstance.mockResolvedValue(null)
    expect(await runRecordTransition(opts)).toEqual({
      status: 404,
      body: { error: 'No pipeline instance for this item' }
    })
  })

  it('passes an access error through', async () => {
    const err = new m.InstanceAccessError('nope')
    m.assertInstanceAccess.mockRejectedValue(err)
    expect(await runRecordTransition(opts)).toEqual({ status: 403, body: { error: 'nope' } })
  })

  it('404 when the transition is not in the record template', async () => {
    m.transition = undefined
    expect(await runRecordTransition(opts)).toEqual({
      status: 404,
      body: { error: 'Transition not found' }
    })
  })

  it('refusal passes through status + body', async () => {
    m.refusal.mockResolvedValue({ status: 403, body: { error: 'Not your step' } })
    expect(await runRecordTransition(opts)).toEqual({
      status: 403,
      body: { error: 'Not your step' }
    })
    expect(m.claim).not.toHaveBeenCalled()
  })

  it('duplicate claim -> 409 with code TRANSITION_DUPLICATE', async () => {
    m.claim.mockRejectedValue(new m.TransitionDuplicateError('twin'))
    const r = await runRecordTransition(opts)
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ error: 'twin', code: 'TRANSITION_DUPLICATE' })
    expect(m.apply).not.toHaveBeenCalled()
  })

  it('blocked action -> 422 and the claim is released', async () => {
    const release = vi.fn()
    m.claim.mockResolvedValue({ release })
    m.apply.mockRejectedValue(new m.TransitionBlockedError('ERP said no'))
    expect(await runRecordTransition(opts)).toEqual({
      status: 422,
      body: { error: 'ERP said no' }
    })
    expect(release).toHaveBeenCalled()
  })

  it('success returns the route body shape', async () => {
    expect(await runRecordTransition(opts)).toEqual({
      status: 200,
      body: { data: { instance: { id: 'i1', current_state: 's2' }, new_state: null } }
    })
  })
})
