import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

// A list read the database gave up on answers 503 with code LIST_TIMEOUT —
// clients show "took too long — Retry" on the code, never "0 items".

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'ADMIN-1', role: 'ADMIN-ROLE' }
    req.isAdmin = true
  }
}))
vi.mock('../../../middleware/workspace.js', () => ({ resolveWorkspace: async () => {} }))
vi.mock('../../../services/idempotency.js', () => ({
  idempotencyPreHandler: () => async () => {}
}))
const svc = vi.hoisted(() => ({
  readItems: vi.fn(),
  getActualColumns: vi.fn(async () => new Set(['id']))
}))
vi.mock('../../../services/items.js', async (orig) => ({
  ...(await orig<object>()),
  ...svc
}))

import { itemsRoutes } from '../../../routes/items.js'
import { ListTimeoutError } from '../../../services/items.js'

async function app() {
  const a = Fastify()
  await a.register(itemsRoutes, { prefix: '/api/items' })
  return a
}

describe('GET /items/:collection — statement timeout', () => {
  it('a search answers 503 LIST_TIMEOUT with the search message', async () => {
    svc.readItems.mockRejectedValueOnce(new ListTimeoutError(true))
    const res = await (await app()).inject({ url: '/api/items/workflows?search=NOKIA' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message:
        'This search took too long to finish. Try again, or search for something more specific.',
      code: 'LIST_TIMEOUT'
    })
  })

  it('a plain list answers 503 LIST_TIMEOUT with the list message', async () => {
    svc.readItems.mockRejectedValueOnce(new ListTimeoutError(false))
    const res = await (await app()).inject({ url: '/api/items/workflows' })
    expect(res.statusCode).toBe(503)
    expect(res.json().code).toBe('LIST_TIMEOUT')
    expect(res.json().message).toMatch(/took too long to load/)
  })

  it('the export route answers the same', async () => {
    svc.readItems.mockRejectedValueOnce(new ListTimeoutError(false))
    const res = await (await app()).inject({ url: '/api/items/workflows/export' })
    expect(res.statusCode).toBe(503)
    expect(res.json().code).toBe('LIST_TIMEOUT')
  })
})
