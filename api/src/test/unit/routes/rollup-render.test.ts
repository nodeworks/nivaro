import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock auth middleware so routes don't need real sessions in these tests —
// same idiom as review-list-render.test.ts's route harness.
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
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/review-list.js', () => ({
  resolveReviewListRows: vi.fn(async () => ({
    rows: [],
    columns: { group_meta: [], line_columns: [] },
    truncated: false
  })),
  validateReviewListConfig: vi.fn(() => null)
}))
vi.mock('../../../services/rollup.js', () => ({
  resolveRollupRows: vi.fn(async () => ({
    rows: [],
    columns: { levels: [], leaf_columns: [], measures: [] },
    truncated: false
  })),
  validateRollupConfig: vi.fn(() => null)
}))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { widgetsInternalRoutes } from '../../../routes/widgets-internal.js'
import { can } from '../../../services/permissions.js'
import { resolveRollupRows, validateRollupConfig } from '../../../services/rollup.js'

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(widgetsInternalRoutes, { prefix: '/widgets-internal' })
  return app
}

afterEach(() => vi.clearAllMocks())

// ─── render dispatch ────────────────────────────────────────────────────────

const rollupConfig = {
  host_collection: 'workflows',
  collection: 'unit_workflows',
  path: [
    { kind: 'm2o', field: 'workflow_line' },
    { kind: 'm2o', field: 'workflow' }
  ],
  levels: [{ field: 'unit_type' }],
  measures: [{ key: 'total', label: 'Total', sum: 'allocated_amount' }]
}

function makeRenderDbMock(widgetRow: Record<string, unknown> | undefined) {
  return vi.fn((table: string) => {
    if (table === 'nivaro_widgets') {
      return { where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(widgetRow)) })) }
    }
    throw new Error(`unexpected table: ${table}`)
  })
}

describe('POST /widgets-internal/:id/render — rollup dispatch', () => {
  it('flows inputs.record_id through to the service and returns its result', async () => {
    vi.mocked(db).mockImplementation(
      makeRenderDbMock({
        id: 1,
        widget_type: 'rollup',
        config: JSON.stringify(rollupConfig)
      }) as unknown as typeof db
    )
    const expected = {
      rows: [
        {
          id: 'uw-1',
          levels: ['dpt-1'],
          level_labels: ['Conduit'],
          values: {},
          measures: { total: 100 }
        }
      ],
      columns: { levels: [], leaf_columns: [], measures: [] },
      truncated: false
    }
    vi.mocked(resolveRollupRows).mockResolvedValueOnce(expected)

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/widgets-internal/1/render',
      payload: { inputs: { record_id: '373944' } }
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ data: expected })
    expect(vi.mocked(resolveRollupRows)).toHaveBeenCalledWith(db, rollupConfig, '373944')
  })

  it('403s when the caller lacks read permission on config.collection', async () => {
    vi.mocked(db).mockImplementation(
      makeRenderDbMock({
        id: 1,
        widget_type: 'rollup',
        config: JSON.stringify(rollupConfig)
      }) as unknown as typeof db
    )
    vi.mocked(can).mockResolvedValueOnce(false)

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/widgets-internal/1/render',
      payload: { inputs: { record_id: '373944' } }
    })

    expect(res.statusCode).toBe(403)
    expect(vi.mocked(resolveRollupRows)).not.toHaveBeenCalled()
  })

  it('400s when inputs.record_id is missing', async () => {
    vi.mocked(db).mockImplementation(
      makeRenderDbMock({
        id: 1,
        widget_type: 'rollup',
        config: JSON.stringify(rollupConfig)
      }) as unknown as typeof db
    )

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/widgets-internal/1/render',
      payload: { inputs: {} }
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/record_id/)
    expect(vi.mocked(resolveRollupRows)).not.toHaveBeenCalled()
  })

  it('400s when the service rejects a malformed stored config', async () => {
    vi.mocked(db).mockImplementation(
      makeRenderDbMock({
        id: 1,
        widget_type: 'rollup',
        config: JSON.stringify(rollupConfig)
      }) as unknown as typeof db
    )
    vi.mocked(resolveRollupRows).mockRejectedValueOnce(
      Object.assign(new Error('rollup: levels must be a non-empty array of at most 3 entries'), {
        statusCode: 400
      })
    )

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/widgets-internal/1/render',
      payload: { inputs: { record_id: '373944' } }
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/levels/)
  })
})

// ─── create / PATCH validation ──────────────────────────────────────────────

function makeWidgetsDbMock(opts: {
  existing?: Record<string, unknown>
  insertedRow?: Record<string, unknown>
  relations?: unknown[]
}) {
  return vi.fn((table: string) => {
    if (table === 'nivaro_relations') {
      return { select: vi.fn(() => Promise.resolve(opts.relations ?? [])) }
    }
    if (table === 'nivaro_widgets') {
      return {
        where: vi.fn(() => ({
          first: vi.fn(() => Promise.resolve(opts.existing)),
          update: vi.fn(() => Promise.resolve(1))
        })),
        insert: vi.fn(() => Promise.resolve([1])),
        orderBy: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(opts.insertedRow)) }))
      }
    }
    throw new Error(`unexpected table: ${table}`)
  })
}

describe('POST /widgets-internal — rollup config validation', () => {
  it('400s with the validator message when config is invalid', async () => {
    vi.mocked(db).mockImplementation(makeWidgetsDbMock({}) as unknown as typeof db)
    vi.mocked(validateRollupConfig).mockReturnValueOnce(
      'levels must be a non-empty array of at most 3 entries'
    )

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/widgets-internal/',
      payload: { name: 'Deployments', widget_type: 'rollup', config: { bad: true } }
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('levels must be a non-empty array of at most 3 entries')
  })

  it('201s and creates the widget when config is valid', async () => {
    vi.mocked(db).mockImplementation(
      makeWidgetsDbMock({
        insertedRow: {
          id: 5,
          name: 'Deployments',
          widget_type: 'rollup',
          config: JSON.stringify(rollupConfig),
          inputs: null
        }
      }) as unknown as typeof db
    )
    vi.mocked(validateRollupConfig).mockReturnValueOnce(null)

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/widgets-internal/',
      payload: { name: 'Deployments', widget_type: 'rollup', config: rollupConfig }
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body) as { data: { widget_type: string } }
    expect(body.data.widget_type).toBe('rollup')
  })
})

describe('PATCH /widgets-internal/:id — rollup config validation', () => {
  it('400s using the existing widget_type when the PATCH body omits widget_type', async () => {
    vi.mocked(db).mockImplementation(
      makeWidgetsDbMock({
        existing: { id: 7, widget_type: 'rollup', config: JSON.stringify(rollupConfig) }
      }) as unknown as typeof db
    )
    vi.mocked(validateRollupConfig).mockReturnValueOnce(
      'measures must be a non-empty array of at most 4 entries'
    )

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'PATCH',
      url: '/widgets-internal/7',
      payload: { config: { levels: [{ field: 'unit_type' }], measures: [] } }
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe(
      'measures must be a non-empty array of at most 4 entries'
    )
  })

  it('200s and updates the widget when config is valid', async () => {
    vi.mocked(db).mockImplementation(
      makeWidgetsDbMock({
        existing: { id: 7, widget_type: 'rollup', config: JSON.stringify(rollupConfig) }
      }) as unknown as typeof db
    )
    vi.mocked(validateRollupConfig).mockReturnValueOnce(null)

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'PATCH',
      url: '/widgets-internal/7',
      payload: { config: rollupConfig }
    })

    expect(res.statusCode).toBe(200)
  })

  it('validates against the incoming widget_type when the PATCH switches type to rollup', async () => {
    vi.mocked(db).mockImplementation(
      makeWidgetsDbMock({
        existing: { id: 8, widget_type: 'list', config: '{}' }
      }) as unknown as typeof db
    )
    vi.mocked(validateRollupConfig).mockReturnValueOnce('collection must be a valid identifier')

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'PATCH',
      url: '/widgets-internal/8',
      payload: { widget_type: 'rollup', config: { bad: true } }
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('collection must be a valid identifier')
  })
})
