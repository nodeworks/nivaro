import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Pinned collections (shared, admin-managed): GET answers only what the caller may read,
 * in the stored order; PUT is admin-only, drops names that are not registered collections
 * and logs the change.
 */

const ADMIN = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', role: 'r-admin' }
const PERSON = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', role: 'r-person' }
let caller: { id: string; role: string } = ADMIN
let callerIsAdmin = true

vi.mock('../middleware/authenticate.js', () => ({
  requireAuth: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = caller
    req.isAdmin = callerIsAdmin
  },
  requireAdmin: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = caller
    req.isAdmin = callerIsAdmin
    if (!callerIsAdmin) {
      const err = new Error('Forbidden') as Error & { statusCode: number }
      err.statusCode = 403
      throw err
    }
  }
}))
vi.mock('../middleware/workspace.js', () => ({
  isDefaultWorkspace: (id: string) => id === '00000000-0000-0000-0000-000000000001',
  resolveWorkspace: async (req: { workspaceId?: string }) => {
    req.workspaceId = '00000000-0000-0000-0000-000000000001'
  }
}))
const logActivity = vi.fn().mockResolvedValue(1)
vi.mock('../services/activity.js', () => ({ logActivity: (...a: unknown[]) => logActivity(...a) }))

/** What the person role may read. */
const PERSON_READS = new Set(['workflows', 'invoices', 'vendors'])
vi.mock('../services/permissions.js', () => ({
  can: async (user: { role: string }, action: string, collection: string) =>
    action === 'read' && (user.role === 'r-admin' || PERSON_READS.has(collection))
}))

const REGISTERED = new Set(['workflows', 'invoices', 'vendors', 'purchase_orders', 'budgets'])
let stored: string[] = []
const saved: Array<{ workspace: string; list: string[] }> = []
vi.mock('../services/collection-pins.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/collection-pins.js')>()
  return {
    ...real,
    loadPins: async () => [...stored],
    savePins: async (workspace: string, list: string[]) => {
      saved.push({ workspace, list })
      stored = [...list]
    },
    registeredCollections: async (_ws: string, names: string[]) =>
      new Set(names.filter((n) => REGISTERED.has(n)))
  }
})

import { collectionPinRoutes } from './collection-pins.js'

async function build() {
  const app = Fastify()
  await app.register(collectionPinRoutes)
  await app.ready()
  return app
}

afterEach(() => {
  caller = ADMIN
  callerIsAdmin = true
  stored = []
  saved.length = 0
  logActivity.mockClear()
})

describe('GET /collection-pins', () => {
  it('answers the stored order for an admin', async () => {
    stored = ['purchase_orders', 'workflows', 'invoices']
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.collections).toEqual(['purchase_orders', 'workflows', 'invoices'])
  })

  it('never names a collection the reader cannot read, and keeps the order', async () => {
    caller = PERSON
    callerIsAdmin = false
    stored = ['purchase_orders', 'vendors', 'budgets', 'workflows']
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.collections).toEqual(['vendors', 'workflows'])
  })

  it('drops pins whose collection is no longer registered', async () => {
    stored = ['workflows', 'gone_table', 'invoices']
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.json().data.collections).toEqual(['workflows', 'invoices'])
  })
})

describe('PUT /collection-pins', () => {
  it('is refused for a non-admin and stores nothing', async () => {
    caller = PERSON
    callerIsAdmin = false
    const app = await build()
    const res = await app.inject({
      method: 'PUT',
      url: '/',
      payload: { collections: ['workflows'] }
    })
    expect(res.statusCode).toBe(403)
    expect(saved).toEqual([])
    expect(logActivity).not.toHaveBeenCalled()
  })

  it('stores the order given, dropping unknown and repeated names', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'PUT',
      url: '/',
      payload: { collections: ['invoices', 'not_a_table', 'workflows', 'invoices'] }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.collections).toEqual(['invoices', 'workflows'])
    expect(saved).toEqual([
      { workspace: '00000000-0000-0000-0000-000000000001', list: ['invoices', 'workflows'] }
    ])
  })

  it('logs what changed in words', async () => {
    stored = ['workflows', 'invoices']
    const app = await build()
    await app.inject({
      method: 'PUT',
      url: '/',
      payload: { collections: ['invoices', 'vendors'] }
    })
    expect(logActivity).toHaveBeenCalledTimes(1)
    const entry = logActivity.mock.calls[0][0] as { comment: string; collection: string }
    expect(entry.collection).toBe('nivaro_extension_settings')
    expect(entry.comment).toContain('pinned vendors')
    expect(entry.comment).toContain('unpinned workflows')
  })

  it('logs nothing when the list did not change', async () => {
    stored = ['workflows', 'invoices']
    const app = await build()
    const res = await app.inject({
      method: 'PUT',
      url: '/',
      payload: { collections: ['workflows', 'invoices'] }
    })
    expect(res.statusCode).toBe(200)
    expect(logActivity).not.toHaveBeenCalled()
  })

  it('refuses a body that is not a list of names', async () => {
    const app = await build()
    const res = await app.inject({ method: 'PUT', url: '/', payload: { collections: 'workflows' } })
    expect(res.statusCode).toBe(400)
    expect(saved).toEqual([])
  })

  it('refuses more than the cap', async () => {
    const app = await build()
    const many = Array.from({ length: 30 }, (_, i) => `t_${i}`)
    const res = await app.inject({ method: 'PUT', url: '/', payload: { collections: many } })
    expect(res.statusCode).toBe(400)
  })
})
