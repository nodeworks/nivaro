import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock the requireAdmin middleware so routes don't need real auth in these
// tests, and stamp req.user so logActivity has something to read.
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { user?: { id: string } }) => {
    req.user = { id: 'test-admin' }
  })
}))

vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))

vi.mock('../../../hooks/ai-validation.js', () => ({
  AI_SETTINGS_DEFAULTS: {
    validation_enabled: false,
    validation_mode: 'soft',
    validation_rules: [],
    duplicate_detection_enabled: false,
    duplicate_threshold: 0.85
  },
  invalidateAiSettingsCache: vi.fn()
}))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { aiSettingsRoutes } from '../../../routes/ai-settings.js'

// Minimal in-memory single-row table: models nivaro_ai_collection_settings for
// one collection across the GET (fetch) → PATCH (fetch existing, update or
// insert, refetch) sequence the route performs.
function makeTableMock(initialRow: Record<string, unknown> | undefined) {
  let row = initialRow
  const chain = {
    where: vi.fn(() => chain),
    first: vi.fn(() => Promise.resolve(row)),
    update: vi.fn((patch: Record<string, unknown>) => {
      row = { ...row, ...patch }
      return Promise.resolve(1)
    }),
    insert: vi.fn((newRow: Record<string, unknown>) => {
      row = newRow
      return Promise.resolve([1])
    })
  }
  return chain
}

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(aiSettingsRoutes, { prefix: '/ai-settings' })
  return app
}

afterEach(() => vi.clearAllMocks())

const sumCapRule = {
  type: 'sum_cap',
  severity: 'warn',
  sum_field: 'amount',
  group_by: 'invoice_id',
  cap: { relation: 'invoice_id', field: 'total' },
  message: 'Cap exceeded'
}

describe('GET /ai-settings/:collection', () => {
  it('preserves rule objects with a string type, drops everything else', async () => {
    const storedRules = [
      'Content must be professional',
      sumCapRule,
      { foo: 'bar' }, // no `type` — dropped
      5, // not a string or object — dropped
      null // dropped
    ]
    const table = makeTableMock({
      collection: 'invoices',
      validation_enabled: 1,
      validation_mode: 'hard',
      validation_rules: JSON.stringify(storedRules),
      duplicate_detection_enabled: 0,
      duplicate_threshold: 0.85
    })
    vi.mocked(db).mockReturnValue(table as unknown as ReturnType<typeof db>)

    const app = buildApp()
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/ai-settings/invoices' })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { data: { validation_rules: unknown[] } }
    expect(body.data.validation_rules).toEqual(['Content must be professional', sumCapRule])
  })
})

describe('PATCH /ai-settings/:collection', () => {
  it('round-trips a mixed array: trims/filters strings, keeps valid sum_cap objects, drops garbage', async () => {
    const table = makeTableMock({
      collection: 'invoices',
      validation_enabled: 0,
      validation_mode: 'soft',
      validation_rules: JSON.stringify([]),
      duplicate_detection_enabled: 0,
      duplicate_threshold: 0.85
    })
    vi.mocked(db).mockReturnValue(table as unknown as ReturnType<typeof db>)

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'PATCH',
      url: '/ai-settings/invoices',
      payload: {
        validation_rules: [
          '  Content must be professional  ',
          sumCapRule,
          { type: 'sum_cap', severity: 'bogus' }, // fails isSumCapRule — dropped
          '   ', // blank — dropped
          42 // garbage — dropped
        ]
      }
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { data: { validation_rules: unknown[] } }
    expect(body.data.validation_rules).toEqual(['Content must be professional', sumCapRule])

    // Persisted JSON matches what was returned (not "[object Object]").
    const persisted = JSON.parse(table.update.mock.calls[0][0].validation_rules as string)
    expect(persisted).toEqual(['Content must be professional', sumCapRule])
  })

  it('rejects a non-array validation_rules payload', async () => {
    const table = makeTableMock({ collection: 'invoices', validation_rules: JSON.stringify([]) })
    vi.mocked(db).mockReturnValue(table as unknown as ReturnType<typeof db>)

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'PATCH',
      url: '/ai-settings/invoices',
      payload: { validation_rules: 'not-an-array' }
    })

    expect(res.statusCode).toBe(400)
  })

  it('rejects system collections', async () => {
    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'PATCH',
      url: '/ai-settings/nivaro_users',
      payload: { validation_enabled: true }
    })

    expect(res.statusCode).toBe(403)
  })
})
