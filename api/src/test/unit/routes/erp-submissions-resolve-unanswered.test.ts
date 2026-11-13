import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A send that never got an answer (status `sending`, past its timeout) holds the
// next send of the same push until an administrator checks the partner and says
// what happened: not received → the row fails and the next press sends again;
// received → the row is accepted (the order number may be noted). Only a person
// who is an administrator, signed in as themselves, may do it. No partner is
// ever called from this file.

type Row = Record<string, unknown>

const store = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  hidden: false
}))

vi.mock('../../../middleware/authenticate.js', () => {
  const who = (req: Record<string, unknown>) => {
    const h = req.headers as Record<string, string>
    req.user = {
      id: 'U-ROB',
      first_name: 'Rob',
      last_name: 'Lee',
      account_kind: h['x-kind'] ?? null
    }
    req.isAdmin = h['x-admin'] === '1'
    req.authMethod = h['x-auth'] ?? 'session'
    if (h['x-masq']) req.masqueradeAdminId = h['x-masq']
  }
  return {
    authenticate: vi.fn(async (req: Record<string, unknown>) => who(req)),
    requireAdmin: vi.fn(async (req: Record<string, unknown>) => {
      who(req)
      if (!req.isAdmin) throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    })
  }
})

function query(_name: string) {
  const filters: Array<(r: Row) => boolean> = []
  const matched = () => store.rows.filter((r) => filters.every((f) => f(r)))
  const q: Record<string, unknown> = {
    where(a: unknown) {
      if (a && typeof a === 'object')
        for (const [k, v] of Object.entries(a as Row)) filters.push((r) => r[k] === v)
      return q
    },
    first: async () => {
      const r = matched()[0]
      return r ? { ...r } : undefined
    },
    update: async (patch: Row) => {
      const hit = matched()
      for (const r of hit) Object.assign(r, patch)
      return hit.length
    }
  }
  return q
}

vi.mock('../../../db/index.js', () => ({ db: (name: string) => query(name) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/external-apis.js', () => ({ callExternalApi: vi.fn() }))
vi.mock('../../../services/erp-submission-status.js', () => ({
  propagateSubmissionStatus: vi.fn(async () => undefined)
}))
vi.mock('../../../services/auto-transition-memory.js', () => ({
  clearAutoFailures: vi.fn(async () => undefined)
}))
vi.mock('../../../services/record-events.js', () => ({
  announceRecordAspect: vi.fn(),
  announceSubmissionAspect: vi.fn(async () => undefined)
}))
vi.mock('../../../services/instance-guard.js', () => {
  class InstanceAccessError extends Error {
    constructor(
      public statusCode: number,
      message: string
    ) {
      super(message)
    }
  }
  return {
    InstanceAccessError,
    assertInstanceAccess: vi.fn(async () => {
      if (store.hidden) throw new InstanceAccessError(404, 'Not found')
    })
  }
})

import { erpSubmissionsRoutes } from '../../../routes/erp-submissions.js'
import { logActivity } from '../../../services/activity.js'
import { propagateSubmissionStatus } from '../../../services/erp-submission-status.js'
import { callExternalApi } from '../../../services/external-apis.js'
import { assertInstanceAccess } from '../../../services/instance-guard.js'

const NOW = new Date('2026-11-12T20:00:00Z')

function sendingRow(over: Row = {}, minutesAgo = 30): Row {
  const created = new Date(NOW.getTime() - minutesAgo * 60_000)
  return {
    id: 50,
    collection: 'inventory_request',
    item: 'r1',
    external_api: 5,
    external_ref: null,
    status: 'sending',
    attempts: 1,
    last_error: null,
    payload: JSON.stringify({
      endpoint_path: '/orders',
      body: { ref: 'r1' },
      secret_paths: [],
      answer_by: new Date(created.getTime() + 180_000).toISOString()
    }),
    response: null,
    error_class: null,
    obligation_id: 77,
    created_at: created,
    updated_at: created,
    ...over
  }
}

function app() {
  const a = Fastify({ logger: false })
  a.register(erpSubmissionsRoutes)
  return a
}

const ADMIN = { 'x-admin': '1' }

async function resolve(body: Row, headers: Record<string, string> = ADMIN, id = 50) {
  return app().inject({
    method: 'POST',
    url: `/${id}/resolve-unanswered`,
    payload: body,
    headers
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  store.rows = [sendingRow()]
  store.hidden = false
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('POST /:id/resolve-unanswered', () => {
  it('not_received: the row fails with who checked, so the next press sends again', async () => {
    const res = await resolve({ outcome: 'not_received', note: 'Not in Acuity' })
    expect(res.statusCode).toBe(200)
    expect(store.rows[0]).toMatchObject({
      status: 'failed',
      last_error: 'Checked by Rob Lee: not received. Not in Acuity',
      // Never picked up by an automatic resend: the next press is the resend.
      error_class: 'validation'
    })
    expect(res.json().data.status).toBe('failed')
    expect(res.json().message).toMatch(/next time the move is pressed/i)
    expect(propagateSubmissionStatus).toHaveBeenCalledWith(
      expect.objectContaining({ submissionId: 50, status: 'failed', obligationId: 77 })
    )
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'nivaro_erp_submissions',
        item: '50',
        comment: expect.stringContaining('not received')
      })
    )
    expect(callExternalApi).not.toHaveBeenCalled()
  })

  it('received: the row is accepted with the order number, and the answer says the record still needs it', async () => {
    const res = await resolve({ outcome: 'received', order_ref: ' SO-778 ' })
    expect(res.statusCode).toBe(200)
    expect(store.rows[0]).toMatchObject({
      status: 'accepted',
      external_ref: 'SO-778',
      last_error: null,
      error_class: null
    })
    expect(JSON.parse(String(store.rows[0].response))).toMatchObject({
      checked_by: 'Rob Lee',
      outcome: 'received',
      order_ref: 'SO-778'
    })
    expect(res.json().message).toMatch(/record's own fields/i)
    expect(propagateSubmissionStatus).toHaveBeenCalledWith(
      expect.objectContaining({ submissionId: 50, status: 'accepted', obligationId: 77 })
    )
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ comment: expect.stringContaining('received') })
    )
  })

  it('a non-admin gets 403', async () => {
    const res = await resolve({ outcome: 'received' }, {})
    expect(res.statusCode).toBe(403)
    expect(store.rows[0].status).toBe('sending')
  })

  it('an admin token, View-as or a machine account gets 403', async () => {
    for (const headers of [
      { ...ADMIN, 'x-auth': 'static_token' },
      { ...ADMIN, 'x-masq': 'U-OTHER' },
      { ...ADMIN, 'x-kind': 'service' }
    ]) {
      const res = await resolve({ outcome: 'not_received' }, headers)
      expect(res.statusCode).toBe(403)
    }
    expect(store.rows[0].status).toBe('sending')
  })

  it('an unknown id is 404; a record outside the caller’s scope reads as missing', async () => {
    expect((await resolve({ outcome: 'received' }, ADMIN, 999)).statusCode).toBe(404)
    store.hidden = true
    expect((await resolve({ outcome: 'received' })).statusCode).toBe(404)
    expect(assertInstanceAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'U-ROB' }),
      true,
      'inventory_request',
      'r1',
      undefined,
      'read'
    )
    expect(store.rows[0].status).toBe('sending')
  })

  it('a send that already has an outcome is 409', async () => {
    store.rows = [sendingRow({ status: 'accepted' })]
    const res = await resolve({ outcome: 'not_received' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('NOT_UNANSWERED')
    expect(store.rows[0].status).toBe('accepted')
  })

  it('a send still inside its own timeout is 409 (it may still answer)', async () => {
    store.rows = [sendingRow({}, 1)]
    const res = await resolve({ outcome: 'not_received' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('STILL_SENDING')
    expect(store.rows[0].status).toBe('sending')
  })

  it('a missing or unknown outcome is 400', async () => {
    expect((await resolve({})).statusCode).toBe(400)
    expect((await resolve({ outcome: 'maybe' })).statusCode).toBe(400)
  })
})

describe('POST /:id/retry on an unanswered send', () => {
  it('is refused for everyone, admins included: the partner may already have it', async () => {
    const res = await app().inject({ method: 'POST', url: '/50/retry', headers: ADMIN })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('UNANSWERED')
    expect(callExternalApi).not.toHaveBeenCalled()
  })
})
