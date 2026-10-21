import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// PDF generation renders (or attaches) a record through a layout. Any signed-in caller reaches
// it, and it changes no configuration, so the config-write hook (routes/index.ts) must neither
// flush the metadata caches nor push config:update to every open form for it.

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: { id: string; role?: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-user', role: 'user' }
    req.isAdmin = false
  }),
  requireAdmin: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-admin' }
    req.isAdmin = true
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../db/index.js', () => {
  // Every read finds nothing: the layout is gone, so the handlers answer 404.
  const builder: Record<string, unknown> = {}
  for (const m of ['where', 'whereIn', 'select', 'orderBy']) builder[m] = () => builder
  builder.first = async () => undefined
  const d = vi.fn(() => builder)
  return {
    db: Object.assign(d, { transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(d)) })
  }
})

import { collectionLayoutsRoutes } from '../../../routes/collection-layouts.js'
import { isConfigWrite } from '../../../services/config-live.js'

let lastWasConfigWrite: boolean | null = null
function buildApp() {
  const app = Fastify({ logger: false })
  app.addHook('onResponse', async (req) => {
    // Mounted under /collection-layouts here; under /api/collection-layouts in the real app.
    lastWasConfigWrite = isConfigWrite({
      method: req.method,
      url: `/api${req.url}`,
      nvrConfigRead: (req as { nvrConfigRead?: unknown }).nvrConfigRead
    })
  })
  app.register(collectionLayoutsRoutes, { prefix: '/collection-layouts' })
  return app
}

afterEach(() => {
  vi.clearAllMocks()
  lastWasConfigWrite = null
})

describe('PDF generation is not a config write', () => {
  for (const path of ['generate-pdf', 'generate-and-attach']) {
    it(`POST /collection-layouts/:id/${path} marks itself read-only`, async () => {
      const app = buildApp()
      const res = await app.inject({
        method: 'POST',
        url: `/collection-layouts/12/${path}`,
        payload: { collection: 'orders', item_id: 1, attach_field: 'files' }
      })
      expect(res.statusCode).toBe(404)
      expect(lastWasConfigWrite).toBe(false)

      // The same POST without the mark would have counted.
      expect(isConfigWrite({ method: 'POST', url: `/api/collection-layouts/12/${path}` })).toBe(
        true
      )
    })
  }
})
