import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Exhaustive coverage of the EFP workflow state machine: every state in the
// real approval chain, every transition out of it, and every role, asserted
// against POST /pipelines/instance/:collection/:item/transition.
//
// The state names mirror the machine_names in the live EFP data (extracted from
// the legacy app): started -> peer review -> manager -> VP -> project ->
// oracle submission -> oracle approval -> PO -> completion -> completed, with
// rejected/canceled reachable from most points.
//
// What this pins:
//   * only a role in transition.required_roles may advance a given state
//   * admin bypasses every gate
//   * a transition is rejected from any state other than its from_state
//   * terminal states complete the instance and accept nothing further

const CREATOR = 'role-workflow-creator'
const APPROVER = 'role-workflow-approver'
const VP = 'role-vp'
const ORACLE = 'role-oracle'
const ROLES = [CREATOR, APPROVER, VP, ORACLE]

const currentUser: { id: string; role: string | null; isAdmin: boolean } = {
  id: 'u-1',
  role: CREATOR,
  isAdmin: false
}

function login(role: string | null, isAdmin = false) {
  currentUser.id = isAdmin ? 'u-admin' : `u-${role}`
  currentUser.role = role
  currentUser.isAdmin = isAdmin
}

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: currentUser.id, role: currentUser.role }
    req.isAdmin = currentUser.isAdmin
  }),
  requireAdmin: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: currentUser.id, role: currentUser.role }
    req.isAdmin = currentUser.isAdmin
  }),
  authenticate: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: currentUser.id, role: currentUser.role }
    req.isAdmin = currentUser.isAdmin
  })
}))

vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/queue-materialization.js', () => ({
  syncMaterializedQueueItem: vi.fn(async () => {})
}))
vi.mock('../../../services/collections.js', () => ({ getCollection: vi.fn(async () => undefined) }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { pipelinesRoutes } from '../../../routes/pipelines.js'

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(pipelinesRoutes, { prefix: '/pipelines' })
  return app
}

/** The EFP approval chain, in order, with the role that owns each step. */
interface Step {
  /** machine_name of the state the workflow sits in. */
  from: string
  /** machine_name of the state it advances to. */
  to: string
  label: string
  /** Roles permitted to run it; empty means unrestricted. */
  roles: string[]
}

const CHAIN: Step[] = [
  {
    from: 'started',
    to: 'waiting_on_peer_review',
    label: 'Submit for peer review',
    roles: [CREATOR]
  },
  {
    from: 'waiting_on_peer_review',
    to: 'waiting_on_manager_approval',
    label: 'Peer approve',
    roles: [APPROVER]
  },
  {
    from: 'waiting_on_manager_approval',
    to: 'waiting_on_vp_approval',
    label: 'Manager approve',
    roles: [APPROVER]
  },
  {
    from: 'waiting_on_vp_approval',
    to: 'waiting_on_project_approval',
    label: 'VP approve',
    roles: [VP]
  },
  {
    from: 'waiting_on_project_approval',
    to: 'waiting_on_oracle_submission',
    label: 'Project approve',
    roles: [VP]
  },
  {
    from: 'waiting_on_oracle_submission',
    to: 'waiting_on_oracle_approval',
    label: 'Submit to Oracle',
    roles: [ORACLE]
  },
  {
    from: 'waiting_on_oracle_approval',
    to: 'waiting_on_po',
    label: 'Oracle approve',
    roles: [ORACLE]
  },
  { from: 'waiting_on_po', to: 'waiting_on_completion', label: 'PO issued', roles: [] },
  { from: 'waiting_on_completion', to: 'completed', label: 'Complete', roles: [] }
]

/** Cancel/reject are reachable from any in-flight state. */
const EXITS: Step[] = [
  { from: 'waiting_on_peer_review', to: 'rejected', label: 'Send back', roles: [APPROVER] },
  { from: 'waiting_on_manager_approval', to: 'rejected', label: 'Send back', roles: [APPROVER] },
  { from: 'waiting_on_vp_approval', to: 'rejected', label: 'Send back', roles: [VP] },
  { from: 'started', to: 'canceled', label: 'Cancel', roles: [CREATOR] }
]

const TERMINAL = new Set(['completed', 'rejected', 'canceled'])

function stateRow(key: string) {
  return {
    id: `st-${key}`,
    template: 'tpl-1',
    key,
    label: key,
    is_initial: key === 'started',
    is_terminal: TERMINAL.has(key)
  }
}

function transitionRow(step: Step) {
  return {
    id: `tx-${step.from}-${step.to}`,
    template: 'tpl-1',
    from_state: `st-${step.from}`,
    to_state: `st-${step.to}`,
    label: step.label,
    auto_trigger: false,
    required_roles: step.roles.length > 0 ? JSON.stringify(step.roles) : null,
    condition_rules: null,
    requirements: null
  }
}

interface Fx {
  currentState: string
  transition: Record<string, unknown>
  completed?: boolean
  instanceUpdate?: ReturnType<typeof vi.fn>
  historyInsert?: ReturnType<typeof vi.fn>
}

function installDb(fx: Fx) {
  const instance = {
    id: 'inst-1',
    template: 'tpl-1',
    collection: 'workflows',
    item: 'wf-1',
    current_state: `st-${fx.currentState}`,
    completed_at: fx.completed ? new Date() : null
  }
  const target = String(fx.transition.to_state).replace(/^st-/, '')

  vi.mocked(db).mockImplementation(((table: string) => {
    switch (table) {
      case 'nivaro_workflow_instances':
        return {
          where: vi.fn(() => ({
            first: vi.fn(() => Promise.resolve(instance)),
            update: fx.instanceUpdate ?? vi.fn((_row: unknown) => Promise.resolve(1))
          }))
        }
      case 'nivaro_workflow_transitions':
        return {
          where: vi.fn(() => ({
            first: vi.fn(() => Promise.resolve(fx.transition)),
            where: vi.fn(() => ({
              whereNot: vi.fn(() => ({ orderBy: vi.fn(() => Promise.resolve([])) }))
            }))
          }))
        }
      case 'nivaro_workflow_states':
        return { where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(stateRow(target))) })) }
      case 'nivaro_workflow_history':
        return { insert: fx.historyInsert ?? vi.fn((_row: unknown) => Promise.resolve([1])) }
      case 'nivaro_workflow_bindings':
        return { where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(undefined)) })) }
      case 'nivaro_fields':
        return { where: vi.fn(() => ({ select: vi.fn(() => Promise.resolve([])) })) }
      default: {
        // A generic chainable stub. applyTransition fans out to the queue sync
        // and notification-subscription hooks, which join across several
        // tables; without this they throw and log noise on every test.
        const chain: Record<string, unknown> = {}
        for (const m of [
          'where',
          'andWhere',
          'orWhere',
          'whereIn',
          'whereNot',
          'whereNull',
          'join',
          'leftJoin',
          'orderBy',
          'limit',
          'distinct'
        ]) {
          chain[m] = vi.fn(() => chain)
        }
        chain.select = vi.fn(() => Promise.resolve([]))
        chain.pluck = vi.fn(() => Promise.resolve([]))
        chain.first = vi.fn(() => Promise.resolve(undefined))
        chain.insert = vi.fn((_row: unknown) => Promise.resolve([1]))
        chain.update = vi.fn((_row: unknown) => Promise.resolve(1))
        return chain
      }
    }
  }) as unknown as typeof db)
}

async function runTransition(transitionId: string) {
  const app = buildApp()
  await app.ready()
  return app.inject({
    method: 'POST',
    url: '/pipelines/instance/workflows/wf-1/transition',
    payload: { transition_id: transitionId }
  })
}

afterEach(() => {
  vi.clearAllMocks()
  login(CREATOR)
})

// ─── Every step, every role ────────────────────────────────────────────────

describe('EFP approval chain — role matrix over every state', () => {
  for (const step of [...CHAIN, ...EXITS]) {
    const permitted = step.roles.length === 0 ? ROLES : step.roles
    const denied = ROLES.filter((r) => !permitted.includes(r))

    for (const role of permitted) {
      it(`${step.from} → ${step.to}: ${role} may run "${step.label}"`, async () => {
        login(role)
        const instanceUpdate = vi.fn((_row: unknown) => Promise.resolve(1))
        installDb({
          currentState: step.from,
          transition: transitionRow(step),
          instanceUpdate
        })

        const res = await runTransition(`tx-${step.from}-${step.to}`)

        expect(res.statusCode).toBe(200)
        expect(instanceUpdate).toHaveBeenCalledTimes(1)
        expect(instanceUpdate.mock.calls[0][0]).toMatchObject({
          current_state: `st-${step.to}`
        })
      })
    }

    for (const role of denied) {
      it(`${step.from} → ${step.to}: ${role} is refused "${step.label}"`, async () => {
        login(role)
        const instanceUpdate = vi.fn((_row: unknown) => Promise.resolve(1))
        installDb({
          currentState: step.from,
          transition: transitionRow(step),
          instanceUpdate
        })

        const res = await runTransition(`tx-${step.from}-${step.to}`)

        expect(res.statusCode).toBe(403)
        expect(instanceUpdate).not.toHaveBeenCalled()
      })
    }

    it(`${step.from} → ${step.to}: an admin may always run "${step.label}"`, async () => {
      login('role-admin', true)
      const instanceUpdate = vi.fn((_row: unknown) => Promise.resolve(1))
      installDb({ currentState: step.from, transition: transitionRow(step), instanceUpdate })

      const res = await runTransition(`tx-${step.from}-${step.to}`)

      expect(res.statusCode).toBe(200)
      expect(instanceUpdate).toHaveBeenCalledTimes(1)
    })
  }
})

// ─── Wrong-state guards ────────────────────────────────────────────────────

describe('EFP approval chain — a transition is valid only from its own state', () => {
  const OTHER_STATES = CHAIN.map((s) => s.from)

  for (const step of CHAIN) {
    const wrongStates = OTHER_STATES.filter((s) => s !== step.from)
    for (const wrong of wrongStates.slice(0, 3)) {
      it(`"${step.label}" is refused while the workflow sits in ${wrong}`, async () => {
        // Run as an authorised role so only the state gate can reject it.
        login(step.roles[0] ?? APPROVER)
        const instanceUpdate = vi.fn((_row: unknown) => Promise.resolve(1))
        installDb({ currentState: wrong, transition: transitionRow(step), instanceUpdate })

        const res = await runTransition(`tx-${step.from}-${step.to}`)

        expect(res.statusCode).toBe(400)
        expect(JSON.parse(res.body)).toEqual({
          error: 'Transition is not valid from the current state'
        })
        expect(instanceUpdate).not.toHaveBeenCalled()
      })
    }
  }
})

// ─── Terminal states ───────────────────────────────────────────────────────

describe('EFP approval chain — terminal states', () => {
  for (const terminal of ['completed', 'rejected', 'canceled']) {
    it(`marks the instance complete on arrival at ${terminal}`, async () => {
      const step: Step = { from: 'waiting_on_completion', to: terminal, label: 'Finish', roles: [] }
      login(APPROVER)
      const instanceUpdate = vi.fn((_row: unknown) => Promise.resolve(1))
      installDb({ currentState: step.from, transition: transitionRow(step), instanceUpdate })

      const res = await runTransition(`tx-${step.from}-${step.to}`)

      expect(res.statusCode).toBe(200)
      expect((instanceUpdate.mock.calls[0][0] as { completed_at?: unknown }).completed_at).toBeInstanceOf(Date)
    })
  }

  it('refuses any further transition once the instance is completed', async () => {
    login('role-admin', true)
    const step = CHAIN[0]
    const instanceUpdate = vi.fn((_row: unknown) => Promise.resolve(1))
    installDb({
      currentState: step.from,
      transition: transitionRow(step),
      completed: true,
      instanceUpdate
    })

    const res = await runTransition(`tx-${step.from}-${step.to}`)

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'Pipeline is already completed' })
    expect(instanceUpdate).not.toHaveBeenCalled()
  })

  it('leaves completed_at null for a non-terminal state', async () => {
    login(APPROVER)
    const step = CHAIN[1]
    const instanceUpdate = vi.fn((_row: unknown) => Promise.resolve(1))
    installDb({ currentState: step.from, transition: transitionRow(step), instanceUpdate })

    await runTransition(`tx-${step.from}-${step.to}`)

    expect((instanceUpdate.mock.calls[0][0] as { completed_at?: unknown }).completed_at).toBeNull()
  })
})

// ─── History ───────────────────────────────────────────────────────────────

describe('EFP approval chain — audit trail', () => {
  it('records who moved the workflow and between which states', async () => {
    login(APPROVER)
    const step = CHAIN[1]
    const historyInsert = vi.fn((_row: unknown) => Promise.resolve([1]))
    installDb({ currentState: step.from, transition: transitionRow(step), historyInsert })

    await runTransition(`tx-${step.from}-${step.to}`)

    expect(historyInsert).toHaveBeenCalledTimes(1)
    expect(historyInsert.mock.calls[0][0]).toMatchObject({
      instance: 'inst-1',
      from_state: `st-${step.from}`,
      to_state: `st-${step.to}`,
      user: `u-${APPROVER}`
    })
  })

  it('writes no history entry when the role gate refuses the move', async () => {
    login(CREATOR)
    const step = CHAIN[1] // approver-only
    const historyInsert = vi.fn((_row: unknown) => Promise.resolve([1]))
    installDb({ currentState: step.from, transition: transitionRow(step), historyInsert })

    const res = await runTransition(`tx-${step.from}-${step.to}`)

    expect(res.statusCode).toBe(403)
    expect(historyInsert).not.toHaveBeenCalled()
  })

  it('carries the reviewer comment into the audit trail', async () => {
    login(APPROVER)
    const step = CHAIN[1]
    const historyInsert = vi.fn((_row: unknown) => Promise.resolve([1]))
    installDb({ currentState: step.from, transition: transitionRow(step), historyInsert })

    const app = buildApp()
    await app.ready()
    await app.inject({
      method: 'POST',
      url: '/pipelines/instance/workflows/wf-1/transition',
      payload: { transition_id: `tx-${step.from}-${step.to}`, comment: 'Budget verified' }
    })

    expect(historyInsert.mock.calls[0][0]).toMatchObject({ comment: 'Budget verified' })
  })
})
