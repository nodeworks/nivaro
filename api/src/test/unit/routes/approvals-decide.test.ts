import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The approval-chain engine (nivaro_approval_chains → _steps → _instances →
// _decisions) is the sign-off ladder behind the approver role: a creator starts
// an approval, each step's approver decides, and the instance advances strictly
// sequentially. applyApprovalDecision() is shared by the HTTP route and the
// signed Teams/Slack callback, so its gate ladder is the security contract for
// both surfaces.
//
// Gate ladder under test (routes/approvals.ts:137-162):
//   404 instance missing → 409 already decided → 404 chain missing
//   → 409 current step missing → 403 not an approver → 409 double-decide
// then: insert decision (always) → reject terminates / approve advances or finishes.

const CREATOR_ROLE = 'role-workflow-creator'
const APPROVER_ROLE = 'role-workflow-approver'
const VP_ROLE = 'role-vp'

const currentUser: { id: string; role: string | null; isAdmin: boolean } = {
  id: 'user-approver',
  role: APPROVER_ROLE,
  isAdmin: false
}

function login(id: string, role: string | null, isAdmin = false) {
  currentUser.id = id
  currentUser.role = role
  currentUser.isAdmin = isAdmin
}

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: currentUser.id, role: currentUser.role }
    req.isAdmin = currentUser.isAdmin
  }),
  authenticate: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: currentUser.id, role: currentUser.role }
    req.isAdmin = currentUser.isAdmin
  })
}))

vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/notification-channels.js', () => ({
  notifyUser: vi.fn(async () => {})
}))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
// Breaks the approvals ↔ message-actions lazy import so no Teams card is attempted.
vi.mock('../../../routes/message-actions.js', () => ({ sendApprovalCard: vi.fn(async () => {}) }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { approvalsRoutes } from '../../../routes/approvals.js'
import { notifyUser } from '../../../services/notification-channels.js'

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(approvalsRoutes, { prefix: '/approvals' })
  return app
}

const chain = {
  id: 7,
  name: 'Capital spend sign-off',
  collection: 'workflows',
  workflow_template: 'tpl-1',
  state_key: null,
  is_active: true,
  created_at: new Date()
}

/** Two-step ladder: manager approval (role) then VP approval (named user). */
const twoStepChain = [
  {
    id: 1,
    chain: 7,
    step_order: 0,
    approver: null,
    approver_role: APPROVER_ROLE,
    label: 'Manager'
  },
  { id: 2, chain: 7, step_order: 1, approver: 'user-vp', approver_role: null, label: 'VP' }
]

const pendingInstance = {
  id: 42,
  chain: 7,
  collection: 'workflows',
  item: 'wf-1',
  current_step: 0,
  status: 'pending' as const,
  started_by: 'user-creator',
  created_at: new Date()
}

interface Fx {
  instance?: Record<string, unknown> | undefined
  chain?: Record<string, unknown> | undefined
  steps?: Array<Record<string, unknown>>
  /** An existing decision row => the double-decide guard trips. */
  priorDecision?: Record<string, unknown> | undefined
  decisionInsert?: ReturnType<typeof vi.fn>
  instanceUpdate?: ReturnType<typeof vi.fn>
  roleUsers?: Array<{ id: string }>
}

function makeDbMock(fx: Fx) {
  const instance = Object.hasOwn(fx, 'instance') ? fx.instance : pendingInstance
  const chainRow = Object.hasOwn(fx, 'chain') ? fx.chain : chain
  const steps = fx.steps ?? twoStepChain
  const decisionInsert = fx.decisionInsert ?? vi.fn((_row: unknown) => Promise.resolve([1]))
  const instanceUpdate = fx.instanceUpdate ?? vi.fn(() => Promise.resolve(1))

  return vi.fn((table: string) => {
    switch (table) {
      case 'nivaro_approval_instances':
        return {
          where: vi.fn(() => ({
            first: vi.fn(() => Promise.resolve(instance)),
            update: instanceUpdate
          }))
        }
      case 'nivaro_approval_chains':
        return { where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(chainRow)) })) }
      case 'nivaro_approval_chain_steps':
        return { where: vi.fn(() => ({ orderBy: vi.fn(() => Promise.resolve(steps)) })) }
      case 'nivaro_approval_decisions':
        return {
          where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(fx.priorDecision)) })),
          insert: decisionInsert
        }
      case 'nivaro_users':
        return {
          where: vi.fn(() => ({ select: vi.fn(() => Promise.resolve(fx.roleUsers ?? [])) }))
        }
      default:
        throw new Error(`unexpected table: ${table}`)
    }
  })
}

function installDb(fx: Fx = {}) {
  vi.mocked(db).mockImplementation(makeDbMock(fx) as unknown as typeof db)
}

async function decide(payload: Record<string, unknown>, instanceId = 42) {
  const app = buildApp()
  await app.ready()
  return app.inject({
    method: 'POST',
    url: `/approvals/instances/${instanceId}/decide`,
    payload
  })
}

afterEach(() => {
  vi.clearAllMocks()
  login('user-approver', APPROVER_ROLE)
})

// ─── Input validation ──────────────────────────────────────────────────────

describe('POST /approvals/instances/:id/decide — input validation', () => {
  it('400s a decision that is neither approved nor rejected', async () => {
    installDb()
    const res = await decide({ decision: 'maybe' })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({
      error: "decision must be 'approved' or 'rejected'"
    })
  })

  it('400s a missing decision', async () => {
    installDb()
    const res = await decide({})
    expect(res.statusCode).toBe(400)
  })

  it('rejects the decision before touching the database', async () => {
    const decisionInsert = vi.fn((_row: unknown) => Promise.resolve([1]))
    installDb({ decisionInsert })

    await decide({ decision: 'sneaky' })
    expect(decisionInsert).not.toHaveBeenCalled()
  })
})

// ─── Authorization ─────────────────────────────────────────────────────────

describe('POST /approvals/instances/:id/decide — who may decide', () => {
  it('403s a creator who is not an approver for the current step', async () => {
    login('user-creator', CREATOR_ROLE)
    const decisionInsert = vi.fn((_row: unknown) => Promise.resolve([1]))
    installDb({ decisionInsert })

    const res = await decide({ decision: 'approved' })

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toEqual({
      error: 'You are not an approver for the current step'
    })
    // No decision is recorded for an unauthorised caller.
    expect(decisionInsert).not.toHaveBeenCalled()
  })

  it('allows a user holding the step approver_role', async () => {
    login('user-approver', APPROVER_ROLE)
    installDb()

    const res = await decide({ decision: 'approved' })
    expect(res.statusCode).toBe(200)
  })

  it('allows the named direct approver of the step', async () => {
    login('user-vp', null)
    installDb({ instance: { ...pendingInstance, current_step: 1 } })

    const res = await decide({ decision: 'approved' })
    expect(res.statusCode).toBe(200)
  })

  it('403s a different user holding no role on a direct-approver step', async () => {
    login('user-someone-else', null)
    installDb({ instance: { ...pendingInstance, current_step: 1 } })

    const res = await decide({ decision: 'approved' })
    expect(res.statusCode).toBe(403)
  })

  it('403s an approver whose role matches a DIFFERENT step than the current one', async () => {
    // VP role holder cannot short-circuit the manager step.
    login('user-vp-role', VP_ROLE)
    installDb({
      steps: [
        { ...twoStepChain[0] },
        { id: 2, chain: 7, step_order: 1, approver: null, approver_role: VP_ROLE, label: 'VP' }
      ]
    })

    const res = await decide({ decision: 'approved' })
    expect(res.statusCode).toBe(403)
  })

  it('lets an admin decide any step', async () => {
    login('user-admin', 'role-admin', true)
    installDb()

    const res = await decide({ decision: 'approved' })
    expect(res.statusCode).toBe(200)
  })
})

// ─── Instance state gates ──────────────────────────────────────────────────

describe('POST /approvals/instances/:id/decide — instance state gates', () => {
  it('404s a missing instance', async () => {
    installDb({ instance: undefined })
    const res = await decide({ decision: 'approved' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'Instance not found' })
  })

  it('409s an already-approved instance', async () => {
    installDb({ instance: { ...pendingInstance, status: 'approved' } })
    const res = await decide({ decision: 'approved' })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toEqual({ error: 'Instance is already approved' })
  })

  it('409s an already-rejected instance', async () => {
    installDb({ instance: { ...pendingInstance, status: 'rejected' } })
    const res = await decide({ decision: 'approved' })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toEqual({ error: 'Instance is already rejected' })
  })

  it('409s a cancelled instance', async () => {
    installDb({ instance: { ...pendingInstance, status: 'cancelled' } })
    const res = await decide({ decision: 'approved' })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toEqual({ error: 'Instance is already cancelled' })
  })

  it('404s when the chain behind the instance is gone', async () => {
    installDb({ chain: undefined })
    const res = await decide({ decision: 'approved' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'Chain not found' })
  })

  it('409s when current_step points at a step that no longer exists', async () => {
    installDb({ instance: { ...pendingInstance, current_step: 99 } })
    const res = await decide({ decision: 'approved' })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toEqual({ error: 'Current step not found' })
  })

  it('409s a second decision from the same user on the same step', async () => {
    const decisionInsert = vi.fn((_row: unknown) => Promise.resolve([1]))
    installDb({
      priorDecision: { id: 5, instance: 42, step_order: 0, user: 'user-approver' },
      decisionInsert
    })

    const res = await decide({ decision: 'approved' })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toEqual({ error: 'You already decided this step' })
    expect(decisionInsert).not.toHaveBeenCalled()
  })
})

// ─── Sequential advancement ────────────────────────────────────────────────

describe('POST /approvals/instances/:id/decide — sequential advancement', () => {
  it('advances to the next step (not straight to approved) when more steps remain', async () => {
    const instanceUpdate = vi.fn(() => Promise.resolve(1))
    installDb({ instanceUpdate })

    const res = await decide({ decision: 'approved' })

    expect(res.statusCode).toBe(200)
    // Step 0 of 2 approved => bump current_step to 1, do NOT set status.
    expect(instanceUpdate).toHaveBeenCalledWith({ current_step: 1 })
    expect(instanceUpdate).not.toHaveBeenCalledWith({ status: 'approved' })
  })

  it('marks the instance approved once the final step is decided', async () => {
    login('user-vp', null)
    const instanceUpdate = vi.fn(() => Promise.resolve(1))
    installDb({ instance: { ...pendingInstance, current_step: 1 }, instanceUpdate })

    const res = await decide({ decision: 'approved' })

    expect(res.statusCode).toBe(200)
    expect(instanceUpdate).toHaveBeenCalledWith({ status: 'approved' })
  })

  it('records the decision with the step_order it was made on', async () => {
    const decisionInsert = vi.fn((_row: unknown) => Promise.resolve([1]))
    installDb({ decisionInsert })

    await decide({ decision: 'approved', comment: 'Looks good' })

    expect(decisionInsert).toHaveBeenCalledTimes(1)
    expect(decisionInsert.mock.calls[0][0]).toMatchObject({
      instance: 42,
      step_order: 0,
      user: 'user-approver',
      decision: 'approved',
      comment: 'Looks good'
    })
  })

  it('stores a null comment when none is supplied', async () => {
    const decisionInsert = vi.fn((_row: unknown) => Promise.resolve([1]))
    installDb({ decisionInsert })

    await decide({ decision: 'approved' })

    expect(decisionInsert.mock.calls[0][0]).toMatchObject({ comment: null })
  })

  it('notifies only the next step approver on advancement, not the whole chain', async () => {
    installDb()

    await decide({ decision: 'approved' })

    // Step 1's direct approver is user-vp; nobody else is told yet.
    expect(vi.mocked(notifyUser)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notifyUser).mock.calls[0][1]).toBe('user-vp')
  })

  it('notifies every holder of the role when the next step is role-based', async () => {
    login('user-first', 'role-first')
    installDb({
      instance: { ...pendingInstance, current_step: 0 },
      steps: [
        { id: 1, chain: 7, step_order: 0, approver: null, approver_role: 'role-first', label: 'A' },
        { id: 2, chain: 7, step_order: 1, approver: null, approver_role: APPROVER_ROLE, label: 'B' }
      ],
      roleUsers: [{ id: 'appr-1' }, { id: 'appr-2' }]
    })

    await decide({ decision: 'approved' })

    expect(vi.mocked(notifyUser)).toHaveBeenCalledTimes(2)
    const notified = vi.mocked(notifyUser).mock.calls.map((c) => c[1])
    expect(notified).toEqual(['appr-1', 'appr-2'])
  })
})

// ─── Rejection ─────────────────────────────────────────────────────────────

describe('POST /approvals/instances/:id/decide — rejection', () => {
  it('terminates the whole instance on rejection at a non-final step', async () => {
    const instanceUpdate = vi.fn(() => Promise.resolve(1))
    installDb({ instanceUpdate })

    const res = await decide({ decision: 'rejected', comment: 'Over budget' })

    expect(res.statusCode).toBe(200)
    expect(instanceUpdate).toHaveBeenCalledWith({ status: 'rejected' })
    // Rejection must not advance the ladder.
    expect(instanceUpdate).not.toHaveBeenCalledWith({ current_step: 1 })
  })

  it('still records the rejection in the decision log', async () => {
    const decisionInsert = vi.fn((_row: unknown) => Promise.resolve([1]))
    installDb({ decisionInsert })

    await decide({ decision: 'rejected', comment: 'Over budget' })

    expect(decisionInsert.mock.calls[0][0]).toMatchObject({
      decision: 'rejected',
      comment: 'Over budget',
      step_order: 0
    })
  })

  it('notifies the creator who started the approval, not the next approver', async () => {
    installDb()

    await decide({ decision: 'rejected' })

    expect(vi.mocked(notifyUser)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notifyUser).mock.calls[0][1]).toBe('user-creator')
  })

  it('notifies the creator on full approval too', async () => {
    login('user-vp', null)
    installDb({ instance: { ...pendingInstance, current_step: 1 } })

    await decide({ decision: 'approved' })

    expect(vi.mocked(notifyUser)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notifyUser).mock.calls[0][1]).toBe('user-creator')
  })
})
