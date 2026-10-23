import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// A payload template that refused to render records a failed submission whose stored body is
// null. Nothing may resend it: the retry route answers 409 no_body, bulk retry skips it, the
// auto-retry sweep skips it (and classifies it so it is never selected again), and sendPayload /
// retrySubmissionRow refuse it outright. No partner is ever called from this file.

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: { id: string } }) => {
    req.user = { id: 'test-admin' }
  }),
  requireAdmin: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-admin' }
    req.isAdmin = true
  })
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/external-apis.js', () => ({ callExternalApi: vi.fn() }))

import { db } from '../../../db/index.js'
import {
  erpSubmissionsRoutes,
  retrySubmissionRow,
  runErpAutoRetries,
  sendPayload
} from '../../../routes/erp-submissions.js'
import { callExternalApi } from '../../../services/external-apis.js'

const NO_BODY_ROW = {
  id: 82,
  collection: 'workflows',
  item: '1001',
  external_api: 9,
  external_ref: null,
  status: 'failed',
  attempts: 1,
  last_error: "Payload template 'mwf-workflow-status' rendered no body",
  payload: JSON.stringify({ endpoint_path: '/update_workflow.php', body: null, secret_paths: [] }),
  response: null,
  obligation_id: null,
  error_class: null,
  created_at: new Date(),
  updated_at: new Date()
}

/** A loose knex stand-in: every builder method chains, `first` / await answer `rows`. */
function table(rows: unknown[], updates: unknown[] = []) {
  const q: Record<string, unknown> = {}
  for (const m of ['where', 'whereIn', 'whereNull', 'whereNotNull', 'orderBy', 'limit', 'select']) {
    q[m] = vi.fn(() => q)
  }
  q.first = vi.fn(async () => rows[0])
  q.update = vi.fn((patch: unknown) => {
    updates.push(patch)
    return Promise.resolve(1)
  })
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

afterEach(() => vi.clearAllMocks())

describe('a submission recorded without a body', () => {
  it('POST /:id/retry answers 409 no_body and never calls the partner', async () => {
    vi.mocked(db).mockImplementation((() => table([NO_BODY_ROW])) as never)
    const res = await app().inject({ method: 'POST', url: '/82/retry' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({
      error: 'no_body',
      message: 'This submission has no body to resend'
    })
    expect(callExternalApi).not.toHaveBeenCalled()
  })

  it('bulk retry skips it with the reason', async () => {
    vi.mocked(db).mockImplementation((() => table([NO_BODY_ROW])) as never)
    const res = await app().inject({
      method: 'POST',
      url: '/bulk-retry',
      payload: { ids: [82] }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.results).toEqual([
      { id: 82, status: 'skipped', error: 'This submission has no body to resend' }
    ])
    expect(callExternalApi).not.toHaveBeenCalled()
  })

  it('sendPayload and retrySubmissionRow refuse it', async () => {
    await expect(
      sendPayload(9, { endpoint_path: '/x', body: null as never }, undefined)
    ).rejects.toThrow('This submission has no body to resend')
    await expect(retrySubmissionRow(NO_BODY_ROW, 'u1')).rejects.toMatchObject({
      code: 'no_body'
    })
    expect(callExternalApi).not.toHaveBeenCalled()
  })

  it('the auto-retry sweep skips it and classifies it validation so it is never picked again', async () => {
    const updates: unknown[] = []
    vi.mocked(db).mockImplementation(((t: string) =>
      t === 'nivaro_external_apis'
        ? table([{ id: 9, retry_policy: JSON.stringify({ max_attempts: 3, backoff_minutes: 5 }) }])
        : table([NO_BODY_ROW], updates)) as never)
    const r = await runErpAutoRetries()
    expect(r).toEqual({ attempted: 0, landed: 0 })
    expect(updates).toEqual([{ error_class: 'validation' }])
    expect(callExternalApi).not.toHaveBeenCalled()
  })
})
