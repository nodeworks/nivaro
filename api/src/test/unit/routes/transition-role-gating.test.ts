import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Role gating is the whole creator-vs-approver contract: a transition carries
// `required_roles` (JSON array of role ids) and only a user holding one of
// those roles — or an admin — may execute it. Both the single-item route
// (POST /pipelines/instance/:collection/:item/transition) and the bulk route
// (POST /items/:collection/bulk-transition) enforce it independently, so both
// are covered here; a gap in either one is a privilege-escalation path.
//
// `currentUser` is mutated per-test to impersonate creator / approver / admin.

const CREATOR_ROLE = 'role-workflow-creator'
const APPROVER_ROLE = 'role-workflow-approver'

const currentUser: { id: string; role: string | null; isAdmin: boolean } = {
  id: 'test-user',
  role: CREATOR_ROLE,
  isAdmin: false
}

function asCreator() {
  currentUser.id = 'user-creator'
  currentUser.role = CREATOR_ROLE
  currentUser.isAdmin = false
}
function asApprover() {
  currentUser.id = 'user-approver'
  currentUser.role = APPROVER_ROLE
  currentUser.isAdmin = false
}
function asAdmin() {
  currentUser.id = 'user-admin'
  currentUser.role = 'role-admin'
  currentUser.isAdmin = true
}
function asRoleless() {
  currentUser.id = 'user-norole'
  currentUser.role = null
  currentUser.isAdmin = false
}

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: currentUser.id, role: currentUser.role }
    req.isAdmin = currentUser.isAdmin
  }),
  requireAuth: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: currentUser.id, role: currentUser.role }
    req.isAdmin = currentUser.isAdmin
  }),
  requireAdmin: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: currentUser.id, role: currentUser.role }
    req.isAdmin = currentUser.isAdmin
  })
}))

vi.mock('../../../middleware/workspace.js', () => ({
  resolveWorkspace: vi.fn(async (req: { workspaceId?: string }) => {
    req.workspaceId = 'ws-1'
  })
}))

vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/queue-materialization.js', () => ({
  syncMaterializedQueueItem: vi.fn(async () => {})
}))
vi.mock('../../../services/collections.js', () => ({ getCollection: vi.fn(async () => undefined) }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { itemsRoutes } from '../../../routes/items.js'
import { pipelinesRoutes } from '../../../routes/pipelines.js'

function buildPipelinesApp() {
  const app = Fastify({ logger: false })
  app.register(pipelinesRoutes, { prefix: '/pipelines' })
  return app
}

function buildItemsApp() {
  const app = Fastify({ logger: false })
  app.register(itemsRoutes, { prefix: '/items' })
  return app
}

const baseInstance = {
  id: 'inst-1',
  template: 'tpl-1',
  collection: 'workflows',
  item: 'wf-1',
  current_state: 'st-review',
  completed_at: null
}

const targetState = {
  id: 'st-approved',
  template: 'tpl-1',
  key: 'approved',
  label: 'Approved',
  is_initial: false,
  is_terminal: false
}

/** A transition off the review state that only the approver role may run. */
function approvalTransition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-approve',
    template: 'tpl-1',
    from_state: 'st-review',
    to_state: 'st-approved',
    label: 'Approve',
    auto_trigger: false,
    required_roles: JSON.stringify([APPROVER_ROLE]),
    condition_rules: null,
    requirements: null,
    ...overrides
  }
}

interface DbFixture {
  instance?: Record<string, unknown> | undefined
  transition?: Record<string, unknown> | undefined
  instanceUpdate?: ReturnType<typeof vi.fn>
  historyInsert?: ReturnType<typeof vi.fn>
}

function makeDbMock(fx: DbFixture) {
  // Presence checks, not `??` — a test that passes `instance: undefined` is
  // asserting the row is ABSENT, which must not fall back to the default.
  const instance = Object.hasOwn(fx, 'instance') ? fx.instance : baseInstance
  const transition = Object.hasOwn(fx, 'transition') ? fx.transition : approvalTransition()

  return vi.fn((table: string) => {
    switch (table) {
      case 'nivaro_workflow_instances':
        return {
          where: vi.fn(() => ({
            first: vi.fn(() => Promise.resolve(instance)),
            update: fx.instanceUpdate ?? vi.fn(() => Promise.resolve(1))
          }))
        }
      case 'nivaro_workflow_transitions':
        // `first()` serves the route's lookup; the chainable
        // where/whereNot/orderBy arm serves runAutoTransitions(), which the
        // route fires after a successful transition. Without it the engine
        // logs a swallowed TypeError and pollutes test output.
        return {
          where: vi.fn(() => ({
            first: vi.fn(() => Promise.resolve(transition)),
            where: vi.fn(() => ({
              whereNot: vi.fn(() => ({ orderBy: vi.fn(() => Promise.resolve([])) }))
            }))
          }))
        }
      case 'nivaro_workflow_states':
        return { where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(targetState)) })) }
      case 'nivaro_workflow_history':
        return { insert: fx.historyInsert ?? vi.fn(() => Promise.resolve([1])) }
      case 'nivaro_workflow_bindings':
        return { where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(undefined)) })) }
      case 'nivaro_fields':
        return { where: vi.fn(() => ({ select: vi.fn(() => Promise.resolve([])) })) }
      default:
        return {
          where: vi.fn(() => ({
            limit: vi.fn(() => ({ select: vi.fn(() => Promise.resolve([])) }))
          }))
        }
    }
  })
}

function installDb(fx: DbFixture = {}) {
  vi.mocked(db).mockImplementation(makeDbMock(fx) as unknown as typeof db)
}

afterEach(() => {
  vi.clearAllMocks()
  asCreator()
})

// ─── Single-item transition ────────────────────────────────────────────────

describe('POST /pipelines/instance/:collection/:item/transition — required_roles gating', () => {
  it('403s when the caller holds a role outside required_roles (creator on an approver-only transition)', async () => {
    asCreator()
    const instanceUpdate = vi.fn(() => Promise.resolve(1))
    installDb({ instanceUpdate })

    const app = buildPipelinesApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/pipelines/instance/workflows/wf-1/transition',
      payload: { transition_id: 'tx-approve' }
    })

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toEqual({
      error: 'You do not have permission for this transition'
    })
    // The gate must run before any mutation — the instance is never advanced.
    expect(instanceUpdate).not.toHaveBeenCalled()
  })

  it('allows the transition when the caller holds a required role', async () => {
    asApprover()
    const instanceUpdate = vi.fn(() => Promise.resolve(1))
    installDb({ instanceUpdate })

    const app = buildPipelinesApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/pipelines/instance/workflows/wf-1/transition',
      payload: { transition_id: 'tx-approve' }
    })

    expect(res.statusCode).toBe(200)
    expect(instanceUpdate).toHaveBeenCalled()
  })

  it('lets an admin bypass required_roles entirely', async () => {
    asAdmin()
    const instanceUpdate = vi.fn(() => Promise.resolve(1))
    installDb({ instanceUpdate })

    const app = buildPipelinesApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/pipelines/instance/workflows/wf-1/transition',
      payload: { transition_id: 'tx-approve' }
    })

    expect(res.statusCode).toBe(200)
    expect(instanceUpdate).toHaveBeenCalled()
  })

  it('403s a caller with no role at all', async () => {
    asRoleless()
    installDb()

    const app = buildPipelinesApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/pipelines/instance/workflows/wf-1/transition',
      payload: { transition_id: 'tx-approve' }
    })

    expect(res.statusCode).toBe(403)
  })

  it('treats an empty required_roles array as unrestricted', async () => {
    asCreator()
    installDb({ transition: approvalTransition({ required_roles: JSON.stringify([]) }) })

    const app = buildPipelinesApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/pipelines/instance/workflows/wf-1/transition',
      payload: { transition_id: 'tx-approve' }
    })

    expect(res.statusCode).toBe(200)
  })

  it('treats a null required_roles as unrestricted', async () => {
    asCreator()
    installDb({ transition: approvalTransition({ required_roles: null }) })

    const app = buildPipelinesApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/pipelines/instance/workflows/wf-1/transition',
      payload: { transition_id: 'tx-approve' }
    })

    expect(res.statusCode).toBe(200)
  })

  it('honours a multi-role required_roles list', async () => {
    asCreator()
    installDb({
      transition: approvalTransition({
        required_roles: JSON.stringify([APPROVER_ROLE, CREATOR_ROLE])
      })
    })

    const app = buildPipelinesApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/pipelines/instance/workflows/wf-1/transition',
      payload: { transition_id: 'tx-approve' }
    })

    expect(res.statusCode).toBe(200)
  })

  it('fails open (allows) when required_roles holds malformed JSON', async () => {
    // Documents current behaviour: parseJson returns null on a parse failure and
    // the gate is skipped. A corrupted rule must not silently become a lockout,
    // but note this is fail-OPEN, not fail-closed.
    asCreator()
    installDb({ transition: approvalTransition({ required_roles: '{not json' }) })

    const app = buildPipelinesApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/pipelines/instance/workflows/wf-1/transition',
      payload: { transition_id: 'tx-approve' }
    })

    expect(res.statusCode).toBe(200)
  })
})

// ─── Guard ordering ────────────────────────────────────────────────────────
// The route checks instance → completed → transition → from_state → auto_trigger
// → required_roles. Ordering is a real contract: an unauthorised caller must not
// be able to distinguish "wrong role" from "wrong state" in a way that leaks
// pipeline shape, and conversely the cheap structural checks must not be
// skippable by holding the right role.

describe('POST /pipelines/instance/:collection/:item/transition — guard ordering around the role gate', () => {
  it('404s a missing instance before consulting roles', async () => {
    asCreator()
    installDb({ instance: undefined })

    const app = buildPipelinesApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/pipelines/instance/workflows/wf-1/transition',
      payload: { transition_id: 'tx-approve' }
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'No pipeline instance for this item' })
  })

  it('400s an already-completed pipeline when the transition does not leave the current terminal state', async () => {
    asApprover()
    // The uncancel escape hatch (2026-08-28) lets a transition whose
    // from_state IS the current terminal state execute — so the completed
    // guard only fires when the transition starts somewhere else. Park the
    // instance in a state tx-approve does NOT leave from.
    installDb({ instance: { ...baseInstance, current_state: 'st-done', completed_at: new Date() } })

    const app = buildPipelinesApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/pipelines/instance/workflows/wf-1/transition',
      payload: { transition_id: 'tx-approve' }
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'Pipeline is already completed' })
  })

  it('400s a from_state mismatch before the role gate — an unauthorised caller sees 400, not 403', async () => {
    asCreator()
    installDb({ instance: { ...baseInstance, current_state: 'st-draft' } })

    const app = buildPipelinesApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/pipelines/instance/workflows/wf-1/transition',
      payload: { transition_id: 'tx-approve' }
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({
      error: 'Transition is not valid from the current state'
    })
  })

  it('400s an auto_trigger transition even for an authorised approver', async () => {
    asApprover()
    installDb({ transition: approvalTransition({ auto_trigger: true }) })

    const app = buildPipelinesApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/pipelines/instance/workflows/wf-1/transition',
      payload: { transition_id: 'tx-approve' }
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({
      error: 'Automatic transitions cannot be executed manually'
    })
  })

  it('400s a missing transition_id before any lookup', async () => {
    asCreator()
    installDb()

    const app = buildPipelinesApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/pipelines/instance/workflows/wf-1/transition',
      payload: {}
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'transition_id is required' })
  })
})

// ─── Bulk transition ───────────────────────────────────────────────────────

describe('POST /items/:collection/bulk-transition — required_roles gating', () => {
  it('403s the whole batch when the caller lacks a required role', async () => {
    asCreator()
    const instanceUpdate = vi.fn(() => Promise.resolve(1))
    installDb({ instanceUpdate })

    const app = buildItemsApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/items/workflows/bulk-transition',
      payload: { ids: ['wf-1', 'wf-2'], transition_id: 'tx-approve' }
    })

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toEqual({
      error: 'You do not have permission for this transition'
    })
    // No item in the batch is advanced — the check is batch-wide, not per item.
    expect(instanceUpdate).not.toHaveBeenCalled()
  })

  it('advances the batch when the caller holds a required role', async () => {
    asApprover()
    const instanceUpdate = vi.fn(() => Promise.resolve(1))
    installDb({ instanceUpdate })

    const app = buildItemsApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/items/workflows/bulk-transition',
      payload: { ids: ['wf-1', 'wf-2'], transition_id: 'tx-approve' }
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { succeeded: number; failed: number }
    expect(body.succeeded).toBe(2)
    expect(body.failed).toBe(0)
    expect(instanceUpdate).toHaveBeenCalledTimes(2)
  })

  it('lets an admin bypass required_roles on the bulk route', async () => {
    asAdmin()
    const instanceUpdate = vi.fn(() => Promise.resolve(1))
    installDb({ instanceUpdate })

    const app = buildItemsApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/items/workflows/bulk-transition',
      payload: { ids: ['wf-1'], transition_id: 'tx-approve' }
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ succeeded: 1, failed: 0 })
  })

  it('404s an unknown transition before the role gate', async () => {
    asCreator()
    installDb({ transition: undefined })

    const app = buildItemsApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/items/workflows/bulk-transition',
      payload: { ids: ['wf-1'], transition_id: 'tx-nope' }
    })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'Transition not found' })
  })

  it('400s an empty ids array', async () => {
    asApprover()
    installDb()

    const app = buildItemsApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/items/workflows/bulk-transition',
      payload: { ids: [], transition_id: 'tx-approve' }
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'ids array required' })
  })

  it('counts a from_state mismatch as failed without advancing it', async () => {
    asApprover()
    const instanceUpdate = vi.fn(() => Promise.resolve(1))
    installDb({
      instance: { ...baseInstance, current_state: 'st-draft' },
      instanceUpdate
    })

    const app = buildItemsApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/items/workflows/bulk-transition',
      payload: { ids: ['wf-1'], transition_id: 'tx-approve' }
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as {
      succeeded: number
      failed: number
      errors: Array<{ item: string; error: string }>
    }
    expect(body.succeeded).toBe(0)
    expect(body.failed).toBe(1)
    expect(instanceUpdate).not.toHaveBeenCalled()
    // Documents a rough edge: state-mismatch failures carry no per-item reason,
    // so the caller cannot tell them apart from a missing instance.
    expect(body.errors).toEqual([])
  })
})
