import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A person's own request body goes to the items service marked `callerPayload`
// — that mark is what makes dropServerSetFields drop `readonly` and
// `admin_only_edit` fields from a non-admin's values (items-write-scope.test.ts
// covers the drop itself). Routes that forward a body without it let a
// non-admin set an admin-only field through Zapier, record restore or imports.
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'cj', role: 'R' }
    req.isAdmin = false
  },
  checkApiKeyScope: () => true,
  requireAdmin: async () => {}
}))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => null)
}))
const items = vi.hoisted(() => ({
  createOne: vi.fn(async (..._a: unknown[]) => ({ id: 1 })),
  updateOne: vi.fn(async (..._a: unknown[]) => ({ id: 1 })),
  readItems: vi.fn(async () => [])
}))
vi.mock('../../../services/items.js', () => items)
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => {
    const c: Record<string, unknown> = {}
    c.where = () => c
    c.first = async () => ({ collection: 'workflows' })
    return c
  })
}))

import { zapierRoutes } from '../../../routes/zapier.js'

async function post(url: string, payload: Record<string, unknown>) {
  const app = Fastify({ logger: false })
  await app.register(zapierRoutes, { prefix: '/zapier' })
  return app.inject({ method: 'POST', url: `/zapier${url}`, payload })
}

describe('zapier actions forward the caller payload mark', () => {
  beforeEach(() => {
    items.createOne.mockClear()
    items.updateOne.mockClear()
  })

  it('update-item', async () => {
    const r = await post('/actions/update-item', {
      collection: 'workflows',
      id: 7,
      data: { requisition_id: 'R1' }
    })
    expect(r.statusCode).toBe(200)
    expect(items.updateOne.mock.calls[0][6]).toEqual({ callerPayload: true })
  })

  it('create-item', async () => {
    const r = await post('/actions/create-item', {
      collection: 'workflows',
      data: { requisition_id: 'R1' }
    })
    expect(r.statusCode).toBe(201)
    expect(items.createOne.mock.calls[0][5]).toEqual({ callerPayload: true })
  })
})
