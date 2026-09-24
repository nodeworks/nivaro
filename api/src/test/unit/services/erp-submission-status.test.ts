import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import { resetRequesterColumnProbe } from '../../../services/erp-requester-columns.js'
import {
  applySendOutcome,
  outcomeForSubmission,
  propagateSubmissionStatus
} from '../../../services/erp-submission-status.js'
import { resolveObligation } from '../../../services/integration-obligations.js'

vi.mock('../../../services/integration-obligations.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../services/integration-obligations.js')
  >('../../../services/integration-obligations.js')
  return { ...actual, resolveObligation: vi.fn(async () => {}) }
})

// The global db mock (test/setup.ts) has no `.schema` — every test in this
// file that doesn't care about migration 350's column probe gets a default
// "the columns are here" so the existing requested_by/requested_via
// assertions below keep meaning what they say. The dedicated "columns
// missing" describe block below overrides this per test.
type SchemaDb = { schema: { hasColumn: ReturnType<typeof vi.fn> } }
beforeEach(() => {
  ;(db as unknown as SchemaDb).schema = { hasColumn: vi.fn().mockResolvedValue(true) }
})
afterEach(() => {
  resetRequesterColumnProbe()
})

describe('outcomeForSubmission', () => {
  it('maps the five submission statuses onto the three obligation outcomes', () => {
    expect(outcomeForSubmission('accepted')).toBe('sent')
    expect(outcomeForSubmission('rejected')).toBe('failed')
    expect(outcomeForSubmission('failed')).toBe('failed')
    expect(outcomeForSubmission('pending')).toBe('pending')
    expect(outcomeForSubmission('submitted')).toBe('pending')
  })
})

describe('propagateSubmissionStatus', () => {
  afterEach(() => vi.clearAllMocks())

  it('is a no-op when there is no obligation to move', async () => {
    await propagateSubmissionStatus({ submissionId: 1, status: 'accepted', obligationId: null })
    expect(resolveObligation).not.toHaveBeenCalled()
  })

  it('moves the obligation through the same status mapping outcomeForSubmission defines', async () => {
    await propagateSubmissionStatus({
      submissionId: 1,
      status: 'rejected',
      error: 'HTTP 422: bad',
      obligationId: 9
    })
    expect(resolveObligation).toHaveBeenCalledWith(9, {
      outcome: 'failed',
      reason: 'HTTP 422: bad',
      submission_id: 1
    })
  })
})

// ─── applySendOutcome — the shared row-update every sender now calls ───────

const mockedDb = () => vi.mocked(db as unknown as (table: string) => unknown)

function updateChain() {
  const c = { where: vi.fn(), update: vi.fn().mockResolvedValue(1) }
  c.where.mockReturnValue(c)
  return c
}

describe('applySendOutcome', () => {
  afterEach(() => vi.clearAllMocks())

  it('advances attempts, writes the response and keeps the prior external_ref when the outcome has none', async () => {
    const c = updateChain()
    mockedDb().mockReturnValue(c as unknown as ReturnType<typeof db>)

    await applySendOutcome({
      submissionId: 5,
      outcome: {
        status: 'pending',
        external_ref: null,
        error: null,
        response: { ok: true },
        http_status: 200
      },
      priorExternalRef: 'OLD-REF',
      priorAttempts: 3
    })

    expect(c.where).toHaveBeenCalledWith({ id: 5 })
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>
    expect(patch.status).toBe('pending')
    expect(patch.attempts).toBe(4)
    expect(patch.external_ref).toBe('OLD-REF')
    expect(patch.response).toBe(JSON.stringify({ ok: true }))
    expect(patch.error_class).toBeNull()
    expect(patch.updated_at).toBeInstanceOf(Date)
  })

  it("prefers the outcome's own external_ref over the prior one when both are present", async () => {
    const c = updateChain()
    mockedDb().mockReturnValue(c as unknown as ReturnType<typeof db>)

    await applySendOutcome({
      submissionId: 5,
      outcome: {
        status: 'accepted',
        external_ref: 'NEW-REF',
        error: null,
        response: { ok: true },
        http_status: 200
      },
      priorExternalRef: 'OLD-REF',
      priorAttempts: 0
    })

    const patch = c.update.mock.calls[0][0] as Record<string, unknown>
    expect(patch.external_ref).toBe('NEW-REF')
    expect(patch.error_class).toBeNull()
  })

  it('#628 — writes error_class for a failed outcome, classified from the real http_status', async () => {
    const c = updateChain()
    mockedDb().mockReturnValue(c as unknown as ReturnType<typeof db>)

    await applySendOutcome({
      submissionId: 5,
      outcome: {
        status: 'failed',
        external_ref: null,
        error: 'HTTP 404: not found',
        response: { message: 'gone' },
        http_status: 404
      },
      priorExternalRef: null,
      priorAttempts: 0
    })

    const patch = c.update.mock.calls[0][0] as Record<string, unknown>
    expect(patch.error_class).toBe('not_found')
  })

  it('writes error_class for a rejected outcome too, not only "failed"', async () => {
    const c = updateChain()
    mockedDb().mockReturnValue(c as unknown as ReturnType<typeof db>)

    await applySendOutcome({
      submissionId: 5,
      outcome: {
        status: 'rejected',
        external_ref: null,
        error: 'HTTP 503: retry later',
        response: null,
        http_status: 503
      },
      priorExternalRef: null,
      priorAttempts: 0
    })

    const patch = c.update.mock.calls[0][0] as Record<string, unknown>
    expect(patch.error_class).toBe('transient')
  })

  it('classifies from the error text when the sender never supplied an http_status', async () => {
    const c = updateChain()
    mockedDb().mockReturnValue(c as unknown as ReturnType<typeof db>)

    await applySendOutcome({
      submissionId: 5,
      outcome: {
        status: 'failed',
        external_ref: null,
        error: 'connect ECONNREFUSED',
        response: null
        // http_status omitted — a thrown network failure never got one.
      },
      priorExternalRef: null,
      priorAttempts: 0
    })

    const patch = c.update.mock.calls[0][0] as Record<string, unknown>
    expect(patch.error_class).toBe('transient')
  })
})

describe('applySendOutcome — who started each attempt (migration 350)', () => {
  afterEach(() => vi.clearAllMocks())

  it('stamps the new attempt with its own requester and the captured one with the row’s', async () => {
    const sub = {
      where: vi.fn(),
      update: vi.fn().mockResolvedValue(1),
      first: vi.fn().mockResolvedValue({
        payload: '{"endpoint_path":"/x","body":{}}',
        response: null,
        status: 'failed',
        last_error: 'HTTP 500',
        updated_at: new Date('2026-09-20T10:00:00Z'),
        created_at: new Date('2026-09-20T10:00:00Z'),
        requested_by: 'ORIGINAL-USER',
        requested_via: 'transition'
      })
    }
    sub.where.mockReturnValue(sub)
    const att = {
      where: vi.fn(),
      first: vi.fn().mockResolvedValue(undefined),
      insert: vi.fn().mockResolvedValue([1])
    }
    att.where.mockReturnValue(att)
    mockedDb().mockImplementation(((table: string) =>
      table === 'nivaro_erp_submission_attempts' ? att : sub) as never)

    await applySendOutcome({
      submissionId: 9,
      outcome: { status: 'failed', external_ref: null, error: 'HTTP 500', response: null },
      priorExternalRef: null,
      priorAttempts: 1,
      requestedBy: 'RETRYING-USER',
      requestedVia: 'retry'
    })

    const rows = att.insert.mock.calls.map((c) => c[0] as Record<string, unknown>)
    const captured = rows.find((r) => r.attempt === 1)
    const fresh = rows.find((r) => r.attempt === 2)
    expect(captured).toMatchObject({
      source: 'captured',
      requested_by: 'ORIGINAL-USER',
      requested_via: 'transition'
    })
    expect(fresh).toMatchObject({
      source: 'send',
      requested_by: 'RETRYING-USER',
      requested_via: 'retry'
    })
    // The submission row itself keeps the ORIGINAL send's requester.
    const patch = sub.update.mock.calls[0][0] as Record<string, unknown>
    expect(patch).not.toHaveProperty('requested_by')
  })
})

// ─── The columns are missing (migration 350 has not reached this database) ─
//
// A writer that names requested_by/requested_via unconditionally would fail
// its WHOLE insert against a real database missing them — not drop the two
// fields, lose the row. Everything below proves the opposite: the SELECT
// never names a missing column, and both the captured and the fresh attempt
// insert land, just without the two fields this database doesn't have yet.
describe('applySendOutcome — the requester columns are missing on this database', () => {
  afterEach(() => vi.clearAllMocks())

  it('drops requested_by/requested_via — the SELECT and both inserts still happen', async () => {
    ;(db as unknown as { schema: { hasColumn: ReturnType<typeof vi.fn> } }).schema.hasColumn = vi
      .fn()
      .mockResolvedValue(false)

    const sub = {
      where: vi.fn(),
      update: vi.fn().mockResolvedValue(1),
      first: vi.fn().mockResolvedValue({
        payload: '{"endpoint_path":"/x","body":{}}',
        response: null,
        status: 'failed',
        last_error: 'HTTP 500',
        updated_at: new Date('2026-09-20T10:00:00Z'),
        created_at: new Date('2026-09-20T10:00:00Z')
        // no requested_by / requested_via — this database hasn't run
        // migration 350, so the row simply has no such columns.
      })
    }
    sub.where.mockReturnValue(sub)
    const att = {
      where: vi.fn(),
      first: vi.fn().mockResolvedValue(undefined),
      insert: vi.fn().mockResolvedValue([1])
    }
    att.where.mockReturnValue(att)
    mockedDb().mockImplementation(((table: string) =>
      table === 'nivaro_erp_submission_attempts' ? att : sub) as never)

    await applySendOutcome({
      submissionId: 9,
      outcome: { status: 'failed', external_ref: null, error: 'HTTP 500', response: null },
      priorExternalRef: null,
      priorAttempts: 1,
      requestedBy: 'RETRYING-USER',
      requestedVia: 'retry'
    })

    // The captured-attempt SELECT never names a column this database lacks.
    expect(sub.first).toHaveBeenCalledWith(
      'payload',
      'response',
      'status',
      'last_error',
      'updated_at',
      'created_at'
    )
    // Both the captured attempt (from the prior send) and the fresh one
    // still land — a missing column drops the two fields, never the row.
    expect(att.insert).toHaveBeenCalledTimes(2)
    for (const call of att.insert.mock.calls) {
      const row = call[0] as Record<string, unknown>
      expect(row).not.toHaveProperty('requested_by')
      expect(row).not.toHaveProperty('requested_via')
    }
    // The submission row's own update still happens too.
    expect(sub.update).toHaveBeenCalledTimes(1)
  })
})
