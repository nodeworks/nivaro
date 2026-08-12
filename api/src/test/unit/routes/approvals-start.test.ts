import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The creator half of the approval contract: POST /approvals/start is what a
// workflow creator calls to put a record into the sign-off ladder. Its gates
// decide whether an approval can exist at all, so a hole here means records
// bypass sign-off entirely (or pile up duplicate pending approvals).
//
// Gate ladder (routes/approvals.ts:400-425):
//   400 missing fields → 403 can(read, collection) → 404 chain → 400 inactive
//   → 400 collection mismatch → 400 no steps → 409 duplicate pending
// then: insert instance at steps[0].step_order and notify ONLY step 0.

const CREATOR_ROLE = 'role-workflow-creator'

const currentUser: { id: string; role: string | null; isAdmin: boolean } = {
  id: 'user-creator',
  role: CREATOR_ROLE,
  isAdmin: false
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
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser: vi.fn(async () => {}) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../routes/message-actions.js', () => ({ sendApprovalCard: vi.fn(async () => {}) }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { approvalsRoutes } from '../../../routes/approvals.js'
import { notifyUser } from '../../../services/notification-channels.js'
import { can } from '../../../services/permissions.js'

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

const steps = [
  {
    id: 1,
    chain: 7,
    step_order: 0,
    approver: 'user-manager',
    approver_role: null,
    label: 'Manager'
  },
  { id: 2, chain: 7, step_order: 1, approver: 'user-vp', approver_role: null, label: 'VP' }
]

interface Fx {
  chain?: Record<string, unknown> | undefined
  steps?: Array<Record<string, unknown>>
  /** A pending instance already on this item => duplicate guard trips. */
  existing?: Record<string, unknown> | undefined
  instanceInsert?: ReturnType<typeof vi.fn>
}

function makeDbMock(fx: Fx) {
  const chainRow = Object.hasOwn(fx, 'chain') ? fx.chain : chain
  const stepRows = fx.steps ?? steps
  const insert =
    fx.instanceInsert ??
    vi.fn((_row: unknown) => ({
      returning: vi.fn(() =>
        Promise.resolve([
          {
            id: 42,
            chain: 7,
            collection: 'workflows',
            item: 'wf-1',
            current_step: 0,
            status: 'pending',
            started_by: 'user-creator',
            created_at: new Date()
          }
        ])
      )
    }))

  return vi.fn((table: string) => {
    switch (table) {
      case 'nivaro_approval_chains':
        return { where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(chainRow)) })) }
      case 'nivaro_approval_chain_steps':
        return { where: vi.fn(() => ({ orderBy: vi.fn(() => Promise.resolve(stepRows)) })) }
      case 'nivaro_approval_instances':
        return {
          where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(fx.existing)) })),
          insert
        }
      case 'nivaro_users':
        return { where: vi.fn(() => ({ select: vi.fn(() => Promise.resolve([])) })) }
      default:
        throw new Error(`unexpected table: ${table}`)
    }
  })
}

function installDb(fx: Fx = {}) {
  vi.mocked(db).mockImplementation(makeDbMock(fx) as unknown as typeof db)
}

async function start(payload: Record<string, unknown>) {
  const app = buildApp()
  await app.ready()
  return app.inject({ method: 'POST', url: '/approvals/start', payload })
}

afterEach(() => {
  vi.clearAllMocks()
  vi.mocked(can).mockImplementation(async () => true)
  currentUser.id = 'user-creator'
  currentUser.role = CREATOR_ROLE
  currentUser.isAdmin = false
})

describe('POST /approvals/start — required fields', () => {
  it('400s a missing chain_id', async () => {
    installDb()
    const res = await start({ collection: 'workflows', item: 'wf-1' })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({
      error: 'chain_id, collection, and item are required'
    })
  })

  it('400s a missing collection', async () => {
    installDb()
    const res = await start({ chain_id: 7, item: 'wf-1' })
    expect(res.statusCode).toBe(400)
  })

  it('400s a missing item', async () => {
    installDb()
    const res = await start({ chain_id: 7, collection: 'workflows' })
    expect(res.statusCode).toBe(400)
  })

  it('400s an empty-string item rather than starting an approval on nothing', async () => {
    installDb()
    const res = await start({ chain_id: 7, collection: 'workflows', item: '' })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /approvals/start — authorization and chain validity', () => {
  it('403s a creator without read permission on the collection', async () => {
    vi.mocked(can).mockImplementation(async () => false)
    const instanceInsert = vi.fn()
    installDb({ instanceInsert })

    const res = await start({ chain_id: 7, collection: 'workflows', item: 'wf-1' })

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toEqual({ error: 'Forbidden' })
    expect(instanceInsert).not.toHaveBeenCalled()
  })

  it('404s an unknown chain', async () => {
    installDb({ chain: undefined })
    const res = await start({ chain_id: 999, collection: 'workflows', item: 'wf-1' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'Chain not found' })
  })

  it('400s an inactive chain', async () => {
    installDb({ chain: { ...chain, is_active: false } })
    const res = await start({ chain_id: 7, collection: 'workflows', item: 'wf-1' })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'Chain is not active' })
  })

  it('400s when the chain belongs to a different collection', async () => {
    installDb()
    const res = await start({ chain_id: 7, collection: 'inventory_request', item: 'ir-1' })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'Chain is configured for workflows' })
  })

  it('accepts any collection when the chain is not pinned to one', async () => {
    installDb({ chain: { ...chain, collection: null } })
    const res = await start({ chain_id: 7, collection: 'inventory_request', item: 'ir-1' })

    expect(res.statusCode).toBe(201)
  })

  it('400s a chain with no steps — an empty ladder must not create an instance', async () => {
    const instanceInsert = vi.fn()
    installDb({ steps: [], instanceInsert })

    const res = await start({ chain_id: 7, collection: 'workflows', item: 'wf-1' })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'Chain has no steps' })
    expect(instanceInsert).not.toHaveBeenCalled()
  })

  it('409s a duplicate pending approval on the same item', async () => {
    const instanceInsert = vi.fn()
    installDb({ existing: { id: 1, status: 'pending' }, instanceInsert })

    const res = await start({ chain_id: 7, collection: 'workflows', item: 'wf-1' })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toEqual({
      error: 'A pending approval already exists for this item'
    })
    expect(instanceInsert).not.toHaveBeenCalled()
  })
})

describe('POST /approvals/start — instance creation', () => {
  it('201s and seeds the instance at the first step, owned by the creator', async () => {
    const returning = vi.fn(() => Promise.resolve([{ id: 42, current_step: 0 }]))
    const instanceInsert = vi.fn((_row: unknown) => ({ returning }))
    installDb({ instanceInsert })

    const res = await start({ chain_id: 7, collection: 'workflows', item: 'wf-1' })

    expect(res.statusCode).toBe(201)
    expect(instanceInsert).toHaveBeenCalledTimes(1)
    expect(instanceInsert.mock.calls[0][0]).toMatchObject({
      chain: 7,
      collection: 'workflows',
      item: 'wf-1',
      current_step: 0,
      status: 'pending',
      started_by: 'user-creator'
    })
  })

  it('seeds current_step from the lowest configured step_order, not a hardcoded 0', async () => {
    const returning = vi.fn(() => Promise.resolve([{ id: 42 }]))
    const instanceInsert = vi.fn((_row: unknown) => ({ returning }))
    installDb({
      steps: [
        {
          id: 1,
          chain: 7,
          step_order: 5,
          approver: 'user-manager',
          approver_role: null,
          label: 'M'
        },
        { id: 2, chain: 7, step_order: 9, approver: 'user-vp', approver_role: null, label: 'VP' }
      ],
      instanceInsert
    })

    await start({ chain_id: 7, collection: 'workflows', item: 'wf-1' })

    expect(instanceInsert.mock.calls[0][0]).toMatchObject({ current_step: 5 })
  })

  it('coerces a numeric item id to a string for storage', async () => {
    const returning = vi.fn(() => Promise.resolve([{ id: 42 }]))
    const instanceInsert = vi.fn((_row: unknown) => ({ returning }))
    installDb({ instanceInsert })

    await start({ chain_id: 7, collection: 'workflows', item: 12345 })

    expect(instanceInsert.mock.calls[0][0]).toMatchObject({ item: '12345' })
  })

  it('notifies only the first step approver, never the whole ladder', async () => {
    installDb()

    await start({ chain_id: 7, collection: 'workflows', item: 'wf-1' })

    expect(vi.mocked(notifyUser)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notifyUser).mock.calls[0][1]).toBe('user-manager')
  })
})
