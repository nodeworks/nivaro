import { graphql } from 'graphql'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Every GraphQL move runs the ONE manual-move path, runRecordTransition (2026-11-18):
// execute_workflow_transition and execute_pipeline_transition (graphql/resolvers.ts) and
// workflow_transition (schema-builder → executeWorkflowTransition) used to carry their own
// copies of the gate — without the owner rule, conditions, extension checks, the required
// note or the edit lock, and two of them ran no transition actions and wrote no activity.

const m = vi.hoisted(() => ({
  transition: {} as Record<string, unknown>,
  owner: vi.fn(),
  apply: vi.fn(),
  activity: vi.fn(async () => 1),
  lock: vi.fn(async () => null as unknown),
  claim: vi.fn(async () => ({ release: async () => {} }))
}))

vi.mock('../../../db/index.js', () => {
  const q = (table: string) => {
    const self: Record<string, unknown> = {}
    for (const k of ['where', 'whereIn', 'orderBy', 'limit', 'select', 'leftJoin', 'join'])
      self[k] = () => self
    self.first = async () =>
      table === 'nivaro_workflow_transitions'
        ? m.transition
        : table === 'nivaro_workflow_instances'
          ? { id: 'I1', template: 'T', current_state: 'S-DONE', completed_at: null }
          : table === 'nivaro_workflow_states'
            ? { id: 'S-DONE', key: 'done', label: 'Done', template: 'T' }
            : undefined
    self.then = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res)
    return self
  }
  return { db: Object.assign(q, { raw: async () => [] }), dbRead: q, isMssql: () => true }
})
vi.mock('../../../services/instance-guard.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/instance-guard.js')>()),
  assertInstanceAccess: vi.fn(async () => {})
}))
vi.mock('../../../services/branch-instances.js', () => ({
  findRecordInstance: vi.fn(async () => ({
    id: 'I1',
    template: 'T',
    collection: 'orders',
    item: '7',
    current_state: 'S-REVIEW',
    completed_at: null
  }))
}))
vi.mock('../../../services/edit-lock.js', () => ({
  adminOnlyTransitionsFor: vi.fn(async () => new Set()),
  adminOnlyStateOf: vi.fn(async () => null)
}))
vi.mock('../../../services/record-access.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/record-access.js')>()),
  checkTransitionOwner: m.owner
}))
vi.mock('../../../services/item-lock-guard.js', () => ({ editLockRefusal: m.lock }))
vi.mock('../../../services/transition-guard.js', () => ({
  TransitionDuplicateError: class extends Error {},
  claimTransition: m.claim
}))
vi.mock('../../../services/auto-transition-memory.js', () => ({
  clearAutoFailures: vi.fn(async () => {})
}))
vi.mock('../../../services/chain.js', () => ({
  withChainStep: async (_k: string, fn: () => unknown) => fn()
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: m.activity }))
vi.mock('../../../services/workflow-transitions.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/workflow-transitions.js')>()),
  applyTransition: m.apply,
  runAutoTransitions: vi.fn(async () => {}),
  flushChainEvents: vi.fn(),
  autoChainRunsInBackground: vi.fn(async () => false),
  resolveFriendlyId: vi.fn(async () => 'O-7')
}))
vi.mock('../../../services/pipeline-engine.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/pipeline-engine.js')>()),
  buildInstancePayload: vi.fn(async (i: { id: string }) => ({ id: i.id }))
}))
vi.mock('../../../services/collections.js', async (orig) => ({
  ...(await orig<object>()),
  listCollections: vi.fn(async () => []),
  getFields: vi.fn(async () => []),
  getRelations: vi.fn(async () => [])
}))
vi.mock('../../../services/record-instance.js', async (orig) => ({
  ...(await orig<object>()),
  boundCollections: vi.fn(async () => new Set<string>())
}))

import { domainMutationFields } from '../../../graphql/resolvers.js'
import { buildGraphQLSchema } from '../../../services/schema-builder.js'

type Resolve = (src: unknown, args: Record<string, unknown>, ctx: unknown) => Promise<unknown>
const user = { id: 'U-NOT-OWNER', role: 'R' }
const req = { user, authMethod: 'session', isAdmin: false, log: { warn() {}, error() {} } }
const ctx = { user, isAdmin: false, req }
const args = { collection: 'orders', item: '7', transition_id: 'T-APPROVE', comment: 'ok' }

/** Each GraphQL move, called the way a client calls it. Errors come back thrown. */
const MUTATIONS: Record<string, () => Promise<unknown>> = {
  execute_workflow_transition: () =>
    (domainMutationFields.execute_workflow_transition.resolve as unknown as Resolve)(
      null,
      args,
      ctx
    ),
  execute_pipeline_transition: () =>
    (domainMutationFields.execute_pipeline_transition.resolve as unknown as Resolve)(
      null,
      args,
      ctx
    ),
  workflow_transition: async () => {
    const res = await graphql({
      schema: await buildGraphQLSchema(),
      source:
        'mutation { workflow_transition(collection: "orders", item: "7", transition_id: "T-APPROVE", comment: "ok") }',
      contextValue: ctx
    })
    if (res.errors?.length) throw res.errors[0]
    return res.data
  }
}

beforeEach(() => {
  m.transition = {
    id: 'T-APPROVE',
    template: 'T',
    label: 'Approve',
    from_state: 'S-REVIEW',
    to_state: 'S-DONE',
    required_roles: null,
    require_owner: true,
    actions: '[{"type":"erp_submit","api":"fusion"}]'
  }
  m.owner.mockReset().mockResolvedValue({ allowed: true, message: '' })
  m.apply.mockReset().mockResolvedValue({
    updatedInstance: { id: 'I1', current_state: 'S-DONE' },
    newStateObj: { id: 'S-DONE', key: 'done', label: 'Done' },
    previousState: 'S-REVIEW',
    history_id: 9
  })
  m.activity.mockClear()
  m.lock.mockReset().mockResolvedValue(null)
  m.claim.mockClear()
})

describe.each(Object.keys(MUTATIONS))('%s runs the manual-move path', (name) => {
  it('refuses a non-owner an owner-only move, before anything moves', async () => {
    m.owner.mockResolvedValue({
      allowed: false,
      message: 'Only the owner of Review can make this move.'
    })
    const err = (await MUTATIONS[name]().catch((e) => e)) as Error & {
      extensions?: Record<string, unknown>
    }
    expect(err.message).toBe('Only the owner of Review can make this move.')
    expect(err.extensions).toMatchObject({ code: 'TRANSITION_OWNER_REQUIRED', status: 403 })
    expect(m.owner).toHaveBeenCalledWith(
      expect.objectContaining({ user, isAdmin: false, collection: 'orders', item: '7' })
    )
    expect(m.apply).not.toHaveBeenCalled()
    expect(m.activity).not.toHaveBeenCalled()
  })

  it('runs the transition actions, writes history (applyTransition) and the activity row', async () => {
    await MUTATIONS[name]()
    expect(m.claim).toHaveBeenCalled()
    expect(m.apply).toHaveBeenCalledTimes(1)
    expect(m.apply.mock.calls[0][0]).toMatchObject({
      userId: 'U-NOT-OWNER',
      comment: 'ok',
      source: 'manual',
      transition: expect.objectContaining({ id: 'T-APPROVE', actions: m.transition.actions })
    })
    expect(m.activity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pipeline-transition',
        collection: 'orders',
        item: '7',
        user: 'U-NOT-OWNER',
        req
      })
    )
  })

  it('is refused while someone else is editing the record (the edit lock)', async () => {
    m.lock.mockResolvedValue({
      status: 409,
      body: {
        error: 'Bernard is editing',
        code: 'RECORD_LOCKED',
        locked_by: 'U-B',
        locked_by_name: 'Bernard'
      }
    })
    const err = (await MUTATIONS[name]().catch((e) => e)) as Error & {
      extensions?: Record<string, unknown>
    }
    expect(err.extensions).toMatchObject({ code: 'RECORD_LOCKED', status: 409 })
    expect(m.apply).not.toHaveBeenCalled()
  })

  it('a required note is required here too', async () => {
    m.transition = { ...m.transition, require_owner: false, comment_mode: 'required' }
    const run =
      name === 'workflow_transition'
        ? async () => {
            const res = await graphql({
              schema: await buildGraphQLSchema(),
              source:
                'mutation { workflow_transition(collection: "orders", item: "7", transition_id: "T-APPROVE") }',
              contextValue: ctx
            })
            if (res.errors?.length) throw res.errors[0]
          }
        : () =>
            (domainMutationFields[name].resolve as unknown as Resolve)(
              null,
              { ...args, comment: '' },
              ctx
            )
    const err = (await run().catch((e) => e)) as Error & { extensions?: Record<string, unknown> }
    expect(err.extensions).toMatchObject({ status: 422 })
    expect(m.apply).not.toHaveBeenCalled()
  })
})
