import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock auth middleware so routes don't need real sessions in these tests —
// same idiom as transition-requirements.test.ts's route harness.
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

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { widgetsInternalRoutes } from '../../../routes/widgets-internal.js'
import { can } from '../../../services/permissions.js'
import { resolveReviewListRows, validateReviewListConfig } from '../../../services/review-list.js'

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(widgetsInternalRoutes, { prefix: '/widgets-internal' })
  return app
}

afterEach(() => vi.clearAllMocks())

// ─── render dispatch ────────────────────────────────────────────────────────

const reviewListConfig = {
  host_collection: 'workflows',
  collection: 'invoices',
  path: [
    { kind: 'm2o', field: 'purchase_order' },
    { kind: 'm2m', field: 'workflows' }
  ],
  group_by: 'invoice_id',
  status: { field: 'efp_review_status', options: [{ value: 'x', label: 'X', color: 'slate' }] }
}

function makeRenderDbMock(widgetRow: Record<string, unknown> | undefined) {
  return vi.fn((table: string) => {
    if (table === 'nivaro_widgets') {
      return { where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(widgetRow)) })) }
    }
    throw new Error(`unexpected table: ${table}`)
  })
}

describe('POST /widgets-internal/:id/render — review_list dispatch', () => {
  it('flows inputs.record_id through to the service and returns its result', async () => {
    vi.mocked(db).mockImplementation(
      makeRenderDbMock({
        id: 1,
        widget_type: 'review_list',
        config: JSON.stringify(reviewListConfig)
      }) as unknown as typeof db
    )
    const expected = {
      rows: [
        { id: 'inv-1', group: 'g', values: {}, status: 'x', stamp_user: null, stamp_date: null }
      ],
      columns: { group_meta: [], line_columns: [] },
      truncated: false
    }
    vi.mocked(resolveReviewListRows).mockResolvedValueOnce(expected)

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/widgets-internal/1/render',
      payload: { inputs: { record_id: '373944' } }
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ data: expected })
    expect(vi.mocked(resolveReviewListRows)).toHaveBeenCalledWith(db, reviewListConfig, '373944')
  })

  it('403s when the caller lacks read permission on config.collection', async () => {
    vi.mocked(db).mockImplementation(
      makeRenderDbMock({
        id: 1,
        widget_type: 'review_list',
        config: JSON.stringify(reviewListConfig)
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
    expect(vi.mocked(resolveReviewListRows)).not.toHaveBeenCalled()
  })

  it('400s when inputs.record_id is missing', async () => {
    vi.mocked(db).mockImplementation(
      makeRenderDbMock({
        id: 1,
        widget_type: 'review_list',
        config: JSON.stringify(reviewListConfig)
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
    expect(vi.mocked(resolveReviewListRows)).not.toHaveBeenCalled()
  })

  it('400s when the service rejects a malformed stored config', async () => {
    vi.mocked(db).mockImplementation(
      makeRenderDbMock({
        id: 1,
        widget_type: 'review_list',
        config: JSON.stringify(reviewListConfig)
      }) as unknown as typeof db
    )
    vi.mocked(resolveReviewListRows).mockRejectedValueOnce(
      Object.assign(new Error('review_list: group_by must be a valid identifier'), {
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
    expect(JSON.parse(res.body).error).toMatch(/group_by/)
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

describe('POST /widgets-internal — review_list config validation', () => {
  it('400s with the validator message when config is invalid', async () => {
    vi.mocked(db).mockImplementation(makeWidgetsDbMock({}) as unknown as typeof db)
    vi.mocked(validateReviewListConfig).mockReturnValueOnce('group_by must be a valid identifier')

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/widgets-internal/',
      payload: { name: 'Invoice Approvals', widget_type: 'review_list', config: { bad: true } }
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('group_by must be a valid identifier')
  })

  it('201s and creates the widget when config is valid', async () => {
    vi.mocked(db).mockImplementation(
      makeWidgetsDbMock({
        insertedRow: {
          id: 5,
          name: 'Invoice Approvals',
          widget_type: 'review_list',
          config: JSON.stringify(reviewListConfig),
          inputs: null
        }
      }) as unknown as typeof db
    )
    vi.mocked(validateReviewListConfig).mockReturnValueOnce(null)

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/widgets-internal/',
      payload: { name: 'Invoice Approvals', widget_type: 'review_list', config: reviewListConfig }
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body) as { data: { widget_type: string } }
    expect(body.data.widget_type).toBe('review_list')
  })

  it('does not validate config for non-review_list widget types', async () => {
    vi.mocked(db).mockImplementation(
      makeWidgetsDbMock({
        insertedRow: { id: 6, name: 'Stat', widget_type: 'stat', config: null, inputs: null }
      }) as unknown as typeof db
    )

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'POST',
      url: '/widgets-internal/',
      payload: {
        name: 'Stat',
        widget_type: 'stat',
        config: { collection: 'invoices', field: 'id' }
      }
    })

    expect(res.statusCode).toBe(201)
    expect(vi.mocked(validateReviewListConfig)).not.toHaveBeenCalled()
  })
})

describe('PATCH /widgets-internal/:id — review_list config validation', () => {
  it('400s using the existing widget_type when the PATCH body omits widget_type', async () => {
    vi.mocked(db).mockImplementation(
      makeWidgetsDbMock({
        existing: { id: 7, widget_type: 'review_list', config: JSON.stringify(reviewListConfig) }
      }) as unknown as typeof db
    )
    vi.mocked(validateReviewListConfig).mockReturnValueOnce(
      'status.options must be a non-empty array'
    )

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'PATCH',
      url: '/widgets-internal/7',
      payload: { config: { status: { field: 'x', options: [] } } }
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('status.options must be a non-empty array')
  })

  it('200s and updates the widget when config is valid', async () => {
    vi.mocked(db).mockImplementation(
      makeWidgetsDbMock({
        existing: { id: 7, widget_type: 'review_list', config: JSON.stringify(reviewListConfig) }
      }) as unknown as typeof db
    )
    vi.mocked(validateReviewListConfig).mockReturnValueOnce(null)

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'PATCH',
      url: '/widgets-internal/7',
      payload: { config: reviewListConfig }
    })

    expect(res.statusCode).toBe(200)
  })

  it('validates against the incoming widget_type when the PATCH switches type to review_list', async () => {
    vi.mocked(db).mockImplementation(
      makeWidgetsDbMock({
        existing: { id: 8, widget_type: 'list', config: '{}' }
      }) as unknown as typeof db
    )
    vi.mocked(validateReviewListConfig).mockReturnValueOnce('collection must be a valid identifier')

    const app = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'PATCH',
      url: '/widgets-internal/8',
      payload: { widget_type: 'review_list', config: { bad: true } }
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('collection must be a valid identifier')
  })
})
