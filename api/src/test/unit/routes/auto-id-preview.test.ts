import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock auth/workspace middleware so routes don't need real auth in these
// tests, and stamp req.user / req.workspaceId so downstream code has values.
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: { id: string; role?: string } }) => {
    req.user = { id: 'test-user', role: 'user' }
  })
}))

vi.mock('../../../middleware/workspace.js', () => ({
  resolveWorkspace: vi.fn(async (req: { workspaceId?: string }) => {
    req.workspaceId = 'ws-1'
  })
}))

vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { itemsRoutes } from '../../../routes/items.js'
import { can } from '../../../services/permissions.js'

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(itemsRoutes, { prefix: '/items' })
  return app
}

// Routes a knex-style `db(table)` call to the right chain mock by table name.
function makeDbMock(opts: {
  fieldRows: Array<{ field: string; options: string | null }>
  recordRow?: Record<string, unknown>
}) {
  return vi.fn((table: string) => {
    if (table === 'nivaro_fields') {
      return {
        where: vi.fn(() => ({
          andWhereRaw: vi.fn(() => ({
            select: vi.fn(() => Promise.resolve(opts.fieldRows))
          }))
        }))
      }
    }
    // Target collection table — used for the record_id → current suffix lookup.
    return {
      where: vi.fn(() => ({
        first: vi.fn(() => Promise.resolve(opts.recordRow))
      }))
    }
  })
}

afterEach(() => vi.clearAllMocks())

describe('POST /items/:collection/auto-id-preview', () => {
  it('400s when the field has no auto_id config', async () => {
    vi.mocked(db).mockImplementation(makeDbMock({ fieldRows: [] }) as unknown as typeof db)

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/items/invoices-no-config/auto-id-preview',
      payload: { field: 'sku' }
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as { error: string }
    expect(body.error).toBe('Field has no auto_id config')
  })

  it('200s with a placeholder preview when only draft values are supplied', async () => {
    vi.mocked(db).mockImplementation(
      makeDbMock({
        fieldRows: [
          { field: 'sku', options: JSON.stringify({ auto_id: { pattern: 'INV-{seq4}' } }) }
        ]
      }) as unknown as typeof db
    )

    const app = buildApp()
    await app.ready()

    // Distinct collection name per test case — `autoIdFieldsFor` now caches
    // `nivaro_fields` lookups per collection for 30s, so reusing a collection
    // name across cases with different mocked field rows would read a stale
    // cache entry from an earlier test in this file.
    const res = await app.inject({
      method: 'POST',
      url: '/items/invoices-draft-preview/auto-id-preview',
      payload: { field: 'sku', values: {} }
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { preview: string }
    expect(body.preview).toBe('INV-####')
  })

  it('200s with the real suffix when record_id resolves an existing value', async () => {
    vi.mocked(db).mockImplementation(
      makeDbMock({
        fieldRows: [
          { field: 'sku', options: JSON.stringify({ auto_id: { pattern: 'INV-{seq4}' } }) }
        ],
        recordRow: { sku: 'INV-0007' }
      }) as unknown as typeof db
    )

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/items/invoices-record-preview/auto-id-preview',
      payload: { field: 'sku', record_id: 42 }
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { preview: string }
    expect(body.preview).toBe('INV-0007')
  })

  it('403s when the caller lacks read permission on the collection', async () => {
    vi.mocked(can).mockResolvedValueOnce(false)
    vi.mocked(db).mockImplementation(makeDbMock({ fieldRows: [] }) as unknown as typeof db)

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/items/invoices-forbidden/auto-id-preview',
      payload: { field: 'sku' }
    })

    expect(res.statusCode).toBe(403)
  })
})
