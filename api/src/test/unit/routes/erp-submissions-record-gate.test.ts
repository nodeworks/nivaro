import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// army3: ERP submission routes judged only collection-level can(), so any
// approver could read the stored partner payloads of — and re-send — pushes
// on records outside their User Scope, and re-send ACCEPTED pushes. The
// create route was an ad-hoc push of the raw row to any API/endpoint.
// Now: create is admin-only; history/attempts need the record visible;
// retries need what a PATCH would (recordRefusal 'update'); a non-admin only
// re-sends failed/rejected pushes. No partner is ever called from this file.

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: unknown; isAdmin?: boolean; headers: never }) => {
    req.user = { id: 'approver', role: 'r1' }
    req.isAdmin = (req.headers as Record<string, string>)['x-test-admin'] === '1'
  }),
  requireAdmin: vi.fn(async (req: { user?: unknown; isAdmin?: boolean; headers: never }) => {
    req.user = { id: 'approver', role: 'r1' }
    req.isAdmin = (req.headers as Record<string, string>)['x-test-admin'] === '1'
    if (!req.isAdmin) throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
  })
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/external-apis.js', () => ({ callExternalApi: vi.fn() }))
vi.mock('../../../services/erp-record-gate.js', () => ({ recordRefusal: vi.fn(async () => null) }))

import { db } from '../../../db/index.js'
import { erpSubmissionsRoutes } from '../../../routes/erp-submissions.js'
import { recordRefusal } from '../../../services/erp-record-gate.js'
import { callExternalApi } from '../../../services/external-apis.js'

const ROW = {
  id: 7,
  collection: 'workflows',
  item: '1001',
  external_api: 9,
  external_ref: null,
  status: 'failed',
  attempts: 1,
  last_error: 'boom',
  // A null body: an allowed retry stops at 409 no_body, after every gate, before any send.
  payload: JSON.stringify({ endpoint_path: '/x', body: null, secret_paths: [] }),
  response: null,
  obligation_id: null,
  created_at: new Date(),
  updated_at: new Date()
}

function table(rows: unknown[]) {
  const q: Record<string, unknown> = {}
  for (const m of ['where', 'whereIn', 'whereBetween', 'orderBy', 'limit', 'select']) {
    q[m] = vi.fn(() => q)
  }
  q.first = vi.fn(async () => rows[0])
  q.catch = vi.fn(() => Promise.resolve(rows))
  // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
  q.then = (ok: (r: unknown[]) => unknown, fail?: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(ok, fail)
  return q
}

function app() {
  const a = Fastify({ logger: false })
  a.register(erpSubmissionsRoutes)
  return a
}

const refuse404 = { code: 404, body: { error: 'Not found' } }
const refuse403 = { code: 403, body: { error: 'Forbidden' } }

afterEach(() => vi.clearAllMocks())

describe('POST / (ad-hoc submit) is admin-only', () => {
  const body = { collection: 'workflows', item: 1, external_api: 9, endpoint_path: '/x' }
  it('refuses a non-admin before reading the row', async () => {
    const res = await app().inject({ method: 'POST', url: '/', payload: body })
    expect(res.statusCode).toBe(403)
    expect(db).not.toHaveBeenCalled()
    expect(callExternalApi).not.toHaveBeenCalled()
  })
  it('lets an admin through to the record read', async () => {
    vi.mocked(db).mockImplementation((() => table([])) as never)
    const res = await app().inject({
      method: 'POST',
      url: '/',
      payload: body,
      headers: { 'x-test-admin': '1' }
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /:collection/:item history', () => {
  it('answers 404 for a record the caller cannot see', async () => {
    vi.mocked(recordRefusal).mockResolvedValueOnce(refuse404)
    vi.mocked(db).mockImplementation((() => table([ROW])) as never)
    const res = await app().inject({ method: 'GET', url: '/workflows/1001' })
    expect(res.statusCode).toBe(404)
    expect(recordRefusal).toHaveBeenCalledWith(expect.anything(), 'workflows', '1001', 'read')
  })
  it('lists the history for an in-scope reader', async () => {
    vi.mocked(db).mockImplementation((() => table([ROW])) as never)
    const res = await app().inject({ method: 'GET', url: '/workflows/1001' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toHaveLength(1)
  })
})

describe('GET /:id/attempts', () => {
  it('answers 404 when the submission’s record is out of scope', async () => {
    vi.mocked(recordRefusal).mockResolvedValueOnce(refuse404)
    vi.mocked(db).mockImplementation((() => table([ROW])) as never)
    const res = await app().inject({ method: 'GET', url: '/7/attempts' })
    expect(res.statusCode).toBe(404)
    expect(recordRefusal).toHaveBeenCalledWith(expect.anything(), 'workflows', '1001', 'read')
  })
  it('answers the attempts for an in-scope reader', async () => {
    vi.mocked(db).mockImplementation((() => table([ROW])) as never)
    const res = await app().inject({ method: 'GET', url: '/7/attempts' })
    expect(res.statusCode).toBe(200)
  })
})

describe('POST /:id/retry', () => {
  it('refuses a caller who may not change the record', async () => {
    vi.mocked(recordRefusal).mockResolvedValueOnce(refuse403)
    vi.mocked(db).mockImplementation((() => table([ROW])) as never)
    const res = await app().inject({ method: 'POST', url: '/7/retry' })
    expect(res.statusCode).toBe(403)
    expect(recordRefusal).toHaveBeenCalledWith(expect.anything(), 'workflows', '1001', 'update')
    expect(callExternalApi).not.toHaveBeenCalled()
  })
  it('never lets a non-admin re-send an accepted push (409)', async () => {
    vi.mocked(db).mockImplementation((() => table([{ ...ROW, status: 'accepted' }])) as never)
    const res = await app().inject({ method: 'POST', url: '/7/retry' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('NOT_RETRYABLE')
    expect(callExternalApi).not.toHaveBeenCalled()
  })
  it('an admin may re-send an accepted push (reaches the body check)', async () => {
    vi.mocked(db).mockImplementation((() => table([{ ...ROW, status: 'accepted' }])) as never)
    const res = await app().inject({
      method: 'POST',
      url: '/7/retry',
      headers: { 'x-test-admin': '1' }
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('no_body')
  })
  it('an allowed caller retrying a failed push passes every gate', async () => {
    vi.mocked(db).mockImplementation((() => table([ROW])) as never)
    const res = await app().inject({ method: 'POST', url: '/7/retry' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('no_body')
  })
})

describe('POST /bulk-retry', () => {
  it('reports a hidden record as missing and a locked one as forbidden', async () => {
    vi.mocked(recordRefusal).mockResolvedValueOnce(refuse404).mockResolvedValueOnce(refuse403)
    vi.mocked(db).mockImplementation((() => table([ROW])) as never)
    const res = await app().inject({ method: 'POST', url: '/bulk-retry', payload: { ids: [7, 8] } })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.results).toEqual([
      { id: 7, status: 'missing' },
      { id: 8, status: 'forbidden' }
    ])
  })
  it('an allowed caller reaches the body check', async () => {
    vi.mocked(db).mockImplementation((() => table([ROW])) as never)
    const res = await app().inject({ method: 'POST', url: '/bulk-retry', payload: { ids: [7] } })
    expect(res.json().data.results[0]).toEqual({
      id: 7,
      status: 'skipped',
      error: 'This submission has no body to resend'
    })
  })
})
