import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// army3 P9 + audit-core-mz: two surfaces that acted with the integration's
// stored credentials or as a standing global hook were open to every
// signed-in user. Both are admin-only now:
// - POST /external-apis/:id/call and /external-apis/endpoints/:eid/call
// - POST /zapier/hooks and DELETE /zapier/hooks/:id

vi.mock('../../../middleware/authenticate.js', () => {
  const sign = (req: { user?: unknown; isAdmin?: boolean; headers: Record<string, string> }) => {
    req.user = { id: 'approver', role: 'r1' }
    req.isAdmin = req.headers['x-test-admin'] === '1'
  }
  return {
    authenticate: vi.fn(async (req: never) => sign(req)),
    checkApiKeyScope: vi.fn(() => true),
    requireAdmin: vi.fn(async (req: { isAdmin?: boolean }) => {
      sign(req as never)
      if (!req.isAdmin) throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    })
  }
})
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/items.js', () => ({
  createOne: vi.fn(),
  readItems: vi.fn(),
  updateOne: vi.fn()
}))

import { db } from '../../../db/index.js'
import { externalApisRoutes } from '../../../routes/external-apis.js'
import { zapierRoutes } from '../../../routes/zapier.js'

/** Every lookup misses: an admin who passes the gate gets the route's own 404. */
function table() {
  const q: Record<string, unknown> = {}
  for (const m of ['where', 'whereIn', 'orWhere', 'orderBy', 'limit', 'select']) {
    q[m] = vi.fn(() => q)
  }
  q.first = vi.fn(async () => undefined)
  // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
  q.then = (ok: (r: unknown[]) => unknown) => Promise.resolve([]).then(ok)
  return q
}

function app() {
  const a = Fastify({ logger: false })
  a.register(externalApisRoutes, { prefix: '/external-apis' })
  a.register(zapierRoutes, { prefix: '/zapier' })
  return a
}

afterEach(() => vi.clearAllMocks())

const CALLS = [
  { method: 'POST' as const, url: '/external-apis/9/call', payload: { method: 'GET', path: '/' } },
  { method: 'POST' as const, url: '/external-apis/endpoints/fusion-status/call', payload: {} },
  {
    method: 'POST' as const,
    url: '/zapier/hooks',
    payload: { target_url: 'https://hooks.example/x', event: 'create', collection: 'workflows' }
  },
  { method: 'DELETE' as const, url: '/zapier/hooks/12', payload: undefined }
]

describe('admin-only integration surfaces', () => {
  for (const c of CALLS) {
    it(`${c.method} ${c.url} refuses a non-admin before any lookup`, async () => {
      vi.mocked(db).mockImplementation((() => table()) as never)
      const res = await app().inject({ method: c.method, url: c.url, payload: c.payload })
      expect(res.statusCode).toBe(403)
      expect(db).not.toHaveBeenCalled()
    })
    it(`${c.method} ${c.url} lets an admin through the gate`, async () => {
      vi.mocked(db).mockImplementation((() => table()) as never)
      const res = await app().inject({
        method: c.method,
        url: c.url,
        payload: c.payload,
        headers: { 'x-test-admin': '1' }
      })
      expect(res.statusCode).not.toBe(403)
      expect(db).toHaveBeenCalled()
    })
  }
})
