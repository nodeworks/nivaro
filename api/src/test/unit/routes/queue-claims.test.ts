import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Claiming is how an approver takes ownership of work off a shared worklist.
// Two things must hold: (1) visibility — you cannot claim out of a queue you
// were never allowed to read, and (2) the write-through — claiming self-adds
// you as a pipeline instance owner, and releasing removes only the grant the
// claim itself created (added_by = self), never an owner-group grant.

const APPROVER_ROLE = 'role-workflow-approver'
const OTHER_ROLE = 'role-other'

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
  })
}))

vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/realtime.js', () => ({ broadcastCollectionUpdate: vi.fn() }))
vi.mock('../../../functions/queue-materialization-jobs.js', () => ({
  enqueueQueueMaterializationBackfill: vi.fn(async () => {})
}))
vi.mock('../../../services/queues.js', () => ({
  fetchQueueItems: vi.fn(async () => ({ items: [{ collection: 'workflows', item_id: 'wf-1' }] })),
  fetchQueueWorkload: vi.fn(async () => ({})),
  computeAvailableExtraFields: vi.fn(async () => []),
  computeExtraFieldMeta: vi.fn(async () => ({})),
  isDisplayOnlySourceChange: vi.fn(() => false),
  normalizeDisplayConfig: vi.fn((v: unknown) => v),
  parsePaginationParams: vi.fn(() => ({ page: 1, pageSize: 50 })),
  validateAggregates: vi.fn(() => null),
  validateColumnFormats: vi.fn(() => null)
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { canReadQueue, queuesRoutes } from '../../../routes/queues.js'
import { fetchQueueItems } from '../../../services/queues.js'

function buildApp() {
  const app = Fastify({ logger: false })
  // The claim route broadcasts over app.io; decorate a no-op stand-in.
  app.decorate('io', { to: () => ({ emit: () => true }), emit: () => true } as unknown as typeof app.io)
  app.register(queuesRoutes, { prefix: '/queues' })
  return app
}

const sharedQueue = {
  id: 'q-1',
  name: 'Pending approvals',
  owner: 'user-owner',
  is_shared: true,
  role_id: null,
  claims_enabled: true
}

interface Fx {
  queue?: Record<string, unknown> | undefined
  claim?: Record<string, unknown> | undefined
  instance?: Record<string, unknown> | undefined
  owner?: Record<string, unknown> | undefined
  claimInsert?: ReturnType<typeof vi.fn>
  claimDelete?: ReturnType<typeof vi.fn>
  ownerInsert?: ReturnType<typeof vi.fn>
  ownerDelete?: ReturnType<typeof vi.fn>
  ownerWhereSpy?: ReturnType<typeof vi.fn>
}

function makeDbMock(fx: Fx) {
  const queue = Object.hasOwn(fx, 'queue') ? fx.queue : sharedQueue
  const instance = Object.hasOwn(fx, 'instance') ? fx.instance : { id: 'inst-1' }

  return vi.fn((table: string) => {
    switch (table) {
      case 'nivaro_queues':
        return { where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(queue)) })) }
      case 'nivaro_queue_claims':
        return {
          where: vi.fn(() => ({
            first: vi.fn(() => Promise.resolve(fx.claim)),
            delete: fx.claimDelete ?? vi.fn(() => Promise.resolve(1))
          })),
          insert: fx.claimInsert ?? vi.fn((_row: unknown) => Promise.resolve([1]))
        }
      case 'nivaro_workflow_instances':
        return { where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(instance)) })) }
      case 'nivaro_pipeline_instance_owners':
        return {
          where: vi.fn((...args: unknown[]) => {
            fx.ownerWhereSpy?.(...args)
            return {
              first: vi.fn(() => Promise.resolve(fx.owner)),
              delete: fx.ownerDelete ?? vi.fn(() => Promise.resolve(1))
            }
          }),
          insert: fx.ownerInsert ?? vi.fn((_row: unknown) => Promise.resolve([1]))
        }
      default:
        throw new Error(`unexpected table: ${table}`)
    }
  })
}

function installDb(fx: Fx = {}) {
  vi.mocked(db).mockImplementation(makeDbMock(fx) as unknown as typeof db)
}

async function post(path: string, payload: Record<string, unknown>) {
  const app = buildApp()
  await app.ready()
  return app.inject({ method: 'POST', url: path, payload })
}

const claimBody = { source_collection: 'workflows', item_id: 'wf-1' }

afterEach(() => {
  vi.clearAllMocks()
  vi.mocked(fetchQueueItems).mockImplementation(
    async () =>
      ({ items: [{ collection: 'workflows', item_id: 'wf-1' }] }) as unknown as Awaited<
        ReturnType<typeof fetchQueueItems>
      >
  )
  login('user-approver', APPROVER_ROLE)
})

// ─── canReadQueue (pure) ───────────────────────────────────────────────────

describe('canReadQueue', () => {
  const req = (id: string, role: string | null, isAdmin = false) =>
    ({ user: { id, role }, isAdmin }) as unknown as Parameters<typeof canReadQueue>[1]

  it('lets an admin read any queue', () => {
    const priv = { ...sharedQueue, is_shared: false, owner: 'someone-else' }
    expect(canReadQueue(priv as never, req('x', null, true))).toBe(true)
  })

  it('lets the owner read their own unshared queue', () => {
    const priv = { ...sharedQueue, is_shared: false }
    expect(canReadQueue(priv as never, req('user-owner', null))).toBe(true)
  })

  it('denies a non-owner on an unshared queue', () => {
    const priv = { ...sharedQueue, is_shared: false }
    expect(canReadQueue(priv as never, req('user-approver', APPROVER_ROLE))).toBe(false)
  })

  it('allows any authenticated user on a shared queue with no role restriction', () => {
    expect(canReadQueue(sharedQueue as never, req('anyone', OTHER_ROLE))).toBe(true)
  })

  it('allows a role-scoped shared queue only for that role', () => {
    const scoped = { ...sharedQueue, role_id: APPROVER_ROLE }
    expect(canReadQueue(scoped as never, req('u', APPROVER_ROLE))).toBe(true)
    expect(canReadQueue(scoped as never, req('u', OTHER_ROLE))).toBe(false)
  })

  it('denies a role-scoped shared queue for a user with no role', () => {
    const scoped = { ...sharedQueue, role_id: APPROVER_ROLE }
    expect(canReadQueue(scoped as never, req('u', null))).toBe(false)
  })
})

// ─── Claim ─────────────────────────────────────────────────────────────────

describe('POST /queues/:id/claim', () => {
  it('400s without source_collection or item_id', async () => {
    installDb()
    const res = await post('/queues/q-1/claim', { item_id: 'wf-1' })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({
      error: 'source_collection and item_id are required'
    })
  })

  it('404s an unknown queue', async () => {
    installDb({ queue: undefined })
    const res = await post('/queues/q-1/claim', claimBody)
    expect(res.statusCode).toBe(404)
  })

  it('403s a user who cannot read the queue', async () => {
    login('user-outsider', OTHER_ROLE)
    const claimInsert = vi.fn((_row: unknown) => Promise.resolve([1]))
    installDb({ queue: { ...sharedQueue, role_id: APPROVER_ROLE }, claimInsert })

    const res = await post('/queues/q-1/claim', claimBody)

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toEqual({ error: 'Forbidden' })
    expect(claimInsert).not.toHaveBeenCalled()
  })

  it('403s when claiming is disabled on the queue', async () => {
    const claimInsert = vi.fn((_row: unknown) => Promise.resolve([1]))
    installDb({ queue: { ...sharedQueue, claims_enabled: false }, claimInsert })

    const res = await post('/queues/q-1/claim', claimBody)

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toEqual({ error: 'Claiming is disabled for this queue' })
    expect(claimInsert).not.toHaveBeenCalled()
  })

  it('404s an item that is not actually in the queue — membership is re-verified server-side', async () => {
    vi.mocked(fetchQueueItems).mockImplementation(
      async () => ({ items: [] }) as unknown as Awaited<ReturnType<typeof fetchQueueItems>>
    )
    const claimInsert = vi.fn((_row: unknown) => Promise.resolve([1]))
    installDb({ claimInsert })

    const res = await post('/queues/q-1/claim', claimBody)

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'Item not found in this queue' })
    expect(claimInsert).not.toHaveBeenCalled()
  })

  it('201s and records the claim for the caller', async () => {
    const claimInsert = vi.fn((_row: unknown) => Promise.resolve([1]))
    installDb({ claimInsert })

    const res = await post('/queues/q-1/claim', claimBody)

    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toEqual({ data: { claimed: true } })
    expect(claimInsert.mock.calls[0][0]).toMatchObject({
      queue_id: 'q-1',
      source_collection: 'workflows',
      item_id: 'wf-1',
      claimed_by: 'user-approver'
    })
  })

  it('is idempotent — an existing claim is not duplicated', async () => {
    const claimInsert = vi.fn((_row: unknown) => Promise.resolve([1]))
    installDb({ claim: { id: 1, claimed_by: 'user-approver' }, claimInsert })

    const res = await post('/queues/q-1/claim', claimBody)

    expect(res.statusCode).toBe(201)
    expect(claimInsert).not.toHaveBeenCalled()
  })

  it('write-through: self-adds the claimer as a pipeline instance owner', async () => {
    const ownerInsert = vi.fn((_row: unknown) => Promise.resolve([1]))
    installDb({ ownerInsert })

    await post('/queues/q-1/claim', claimBody)

    expect(ownerInsert).toHaveBeenCalledTimes(1)
    expect(ownerInsert.mock.calls[0][0]).toMatchObject({
      instance: 'inst-1',
      state: null,
      user: 'user-approver',
      added_by: 'user-approver'
    })
  })

  it('does not duplicate an owner grant the user already holds', async () => {
    const ownerInsert = vi.fn((_row: unknown) => Promise.resolve([1]))
    installDb({ owner: { id: 9 }, ownerInsert })

    await post('/queues/q-1/claim', claimBody)

    expect(ownerInsert).not.toHaveBeenCalled()
  })

  it('skips the owner write-through when no workflow instance exists', async () => {
    const ownerInsert = vi.fn((_row: unknown) => Promise.resolve([1]))
    installDb({ instance: undefined, ownerInsert })

    const res = await post('/queues/q-1/claim', claimBody)

    expect(res.statusCode).toBe(201)
    expect(ownerInsert).not.toHaveBeenCalled()
  })

  it("skips the owner write-through for a 'tasks' source, whose item_id is not a record id", async () => {
    vi.mocked(fetchQueueItems).mockImplementation(
      async () =>
        ({ items: [{ collection: 'tasks', item_id: 't-1' }] }) as unknown as Awaited<
          ReturnType<typeof fetchQueueItems>
        >
    )
    const ownerInsert = vi.fn((_row: unknown) => Promise.resolve([1]))
    installDb({ ownerInsert })

    const res = await post('/queues/q-1/claim', {
      source_collection: 'tasks',
      item_id: 't-1'
    })

    expect(res.statusCode).toBe(201)
    expect(ownerInsert).not.toHaveBeenCalled()
  })
})

// ─── Release ───────────────────────────────────────────────────────────────

describe('POST /queues/:id/release', () => {
  it('400s without source_collection or item_id', async () => {
    installDb()
    const res = await post('/queues/q-1/release', {})
    expect(res.statusCode).toBe(400)
  })

  it('403s a user who cannot read the queue', async () => {
    login('user-outsider', OTHER_ROLE)
    installDb({ queue: { ...sharedQueue, role_id: APPROVER_ROLE } })

    const res = await post('/queues/q-1/release', claimBody)
    expect(res.statusCode).toBe(403)
  })

  it('still allows release when claiming has since been disabled', async () => {
    // Otherwise existing claims and their owner grants would be stuck forever.
    const claimDelete = vi.fn(() => Promise.resolve(1))
    installDb({ queue: { ...sharedQueue, claims_enabled: false }, claimDelete })

    const res = await post('/queues/q-1/release', claimBody)

    expect(res.statusCode).toBe(204)
    expect(claimDelete).toHaveBeenCalled()
  })

  it('deletes only the caller’s own claim', async () => {
    const claimDelete = vi.fn(() => Promise.resolve(1))
    const claimWhere = vi.fn(() => ({
      first: vi.fn(() => Promise.resolve(undefined)),
      delete: claimDelete
    }))
    vi.mocked(db).mockImplementation(((table: string) => {
      if (table === 'nivaro_queues') {
        return { where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(sharedQueue)) })) }
      }
      if (table === 'nivaro_queue_claims') return { where: claimWhere }
      if (table === 'nivaro_workflow_instances') {
        return { where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(undefined)) })) }
      }
      throw new Error(`unexpected table: ${table}`)
    }) as unknown as typeof db)

    await post('/queues/q-1/release', claimBody)

    expect(claimWhere).toHaveBeenCalledWith({
      queue_id: 'q-1',
      source_collection: 'workflows',
      item_id: 'wf-1',
      claimed_by: 'user-approver'
    })
  })

  it('removes only the owner grant this claim created (added_by = self)', async () => {
    // An owner-group grant has a different added_by and must survive a release.
    const ownerWhereSpy = vi.fn()
    const ownerDelete = vi.fn(() => Promise.resolve(1))
    installDb({ ownerWhereSpy, ownerDelete })

    await post('/queues/q-1/release', claimBody)

    expect(ownerWhereSpy).toHaveBeenCalledWith({
      instance: 'inst-1',
      user: 'user-approver',
      added_by: 'user-approver'
    })
    expect(ownerDelete).toHaveBeenCalled()
  })

  it("skips the owner cleanup for a 'tasks' source", async () => {
    vi.mocked(fetchQueueItems).mockImplementation(
      async () =>
        ({ items: [{ collection: 'tasks', item_id: 't-1' }] }) as unknown as Awaited<
          ReturnType<typeof fetchQueueItems>
        >
    )
    const ownerDelete = vi.fn(() => Promise.resolve(1))
    installDb({ ownerDelete })

    const res = await post('/queues/q-1/release', {
      source_collection: 'tasks',
      item_id: 't-1'
    })

    expect(res.statusCode).toBe(204)
    expect(ownerDelete).not.toHaveBeenCalled()
  })
})
