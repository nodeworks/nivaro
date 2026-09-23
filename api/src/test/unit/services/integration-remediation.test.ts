import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// resendSubmission (the one function that actually sends) reaches both of
// these through a dynamic `await import(...)`, deliberately, to keep them
// out of this module's static import graph — vi.mock still intercepts a
// dynamic import the same way it intercepts a static one, same precedent as
// ai-integration-tool.test.ts. Mocked at the very top, before importing the
// real service under test, matching this file's other db/services mocks.
vi.mock('../../../routes/erp-submissions.js', () => ({ sendPayload: vi.fn() }))
vi.mock('../../../services/erp-submission-status.js', () => ({
  applySendOutcome: vi.fn(async () => {}),
  propagateSubmissionStatus: vi.fn(async () => {})
}))

import { db } from '../../../db/index.js'
import { sendPayload } from '../../../routes/erp-submissions.js'
import {
  applySendOutcome,
  propagateSubmissionStatus
} from '../../../services/erp-submission-status.js'
import {
  clearObligationKinds,
  registerObligationKind
} from '../../../services/integration-obligations.js'
import {
  RETRYABLE_CLASSES,
  classifyError,
  isClosedOutcome,
  nextRetryAt,
  remediationEnabled,
  runMissingRefirePass,
  runRetryPass,
  sendNow
} from '../../../services/integration-remediation.js'

describe('classifyError', () => {
  it('reads a 5xx and a network failure as transient', () => {
    expect(classifyError(503, null)).toBe('transient')
    expect(classifyError(0, null, new Error('connect ECONNREFUSED'))).toBe('transient')
    expect(classifyError(null, null, new Error('fetch failed (ETIMEDOUT)'))).toBe('transient')
  })

  it('reads 429 as rate limited', () => {
    expect(classifyError(429, null)).toBe('rate_limited')
  })

  it('reads 401 and 403 as auth', () => {
    expect(classifyError(401, null)).toBe('auth')
    expect(classifyError(403, null)).toBe('auth')
  })

  it('reads 404 as not_found — the endpoint is wrong, not the moment', () => {
    expect(classifyError(404, null)).toBe('not_found')
  })

  it('reads a 4xx that is none of those as validation', () => {
    expect(classifyError(422, null)).toBe('validation')
    expect(classifyError(400, { message: 'RequesterEmail field is required' })).toBe('validation')
  })

  it('reads a 2xx whose BODY rejects as validation — some partners answer 200 and refuse', () => {
    expect(classifyError(200, { status: 'ERROR', detail: 'not in the list of values' })).toBe(
      'validation'
    )
  })

  it('leaves a plain 2xx unclassified — it is not a failure at all', () => {
    expect(classifyError(200, { status: 'OK' })).toBe('unknown')
  })

  it('reads an unrecognisable failure as unknown rather than guessing it is safe to retry', () => {
    expect(classifyError(null, null)).toBe('unknown')
  })
})

describe('nextRetryAt', () => {
  const at = new Date('2026-09-22T12:00:00Z')

  it('walks the ladder 1, 5, 30, 120 minutes', () => {
    expect(nextRetryAt(0, at)?.toISOString()).toBe('2026-09-22T12:01:00.000Z')
    expect(nextRetryAt(1, at)?.toISOString()).toBe('2026-09-22T12:05:00.000Z')
    expect(nextRetryAt(2, at)?.toISOString()).toBe('2026-09-22T12:30:00.000Z')
    expect(nextRetryAt(3, at)?.toISOString()).toBe('2026-09-22T14:00:00.000Z')
  })

  it('holds at the last rung for the fifth attempt', () => {
    expect(nextRetryAt(4, at)?.toISOString()).toBe('2026-09-22T14:00:00.000Z')
  })

  it('gives up after five', () => {
    expect(nextRetryAt(5, at)).toBeNull()
    expect(nextRetryAt(9, at)).toBeNull()
  })
})

describe('what may be retried', () => {
  it('never retries a validation or not_found failure — repeating it cannot help', () => {
    expect(RETRYABLE_CLASSES).not.toContain('validation')
    expect(RETRYABLE_CLASSES).not.toContain('not_found')
  })

  it('retries the classes a later attempt could plausibly land', () => {
    expect(RETRYABLE_CLASSES).toEqual(['transient', 'rate_limited', 'auth'])
  })
})

describe('isClosedOutcome', () => {
  it('treats sent/skipped/superseded as closed', () => {
    expect(isClosedOutcome('sent')).toBe(true)
    expect(isClosedOutcome('skipped')).toBe(true)
    expect(isClosedOutcome('superseded')).toBe(true)
  })

  it('treats every open outcome, including missing, as not closed', () => {
    expect(isClosedOutcome('pending')).toBe(false)
    expect(isClosedOutcome('failed')).toBe(false)
    expect(isClosedOutcome('overdue')).toBe(false)
    expect(isClosedOutcome('missing')).toBe(false)
  })
})

// ─── The gate: off by default, every sending function returns without
// touching the send path ────────────────────────────────────────────────

const mockedDb = () => vi.mocked(db as unknown as (table: string) => unknown)

function settingsChain(enabled: boolean | null) {
  const chain = {
    first: vi.fn().mockResolvedValue(
      enabled === null ? undefined : { integration_remediation_enabled: enabled }
    )
  }
  return chain
}

describe('the deployment switch — off by default', () => {
  afterEach(() => vi.clearAllMocks())

  it('remediationEnabled reads nivaro_settings.integration_remediation_enabled', async () => {
    mockedDb().mockReturnValue(settingsChain(true) as unknown as ReturnType<typeof db>)
    expect(await remediationEnabled()).toBe(true)

    mockedDb().mockReturnValue(settingsChain(false) as unknown as ReturnType<typeof db>)
    expect(await remediationEnabled()).toBe(false)
  })

  it('remediationEnabled defaults to false when the row/column is absent, and never throws', async () => {
    mockedDb().mockReturnValue(settingsChain(null) as unknown as ReturnType<typeof db>)
    expect(await remediationEnabled()).toBe(false)

    mockedDb().mockImplementation((() => {
      throw new Error('down')
    }) as never)
    expect(await remediationEnabled()).toBe(false)
  })

  it('sendNow returns without touching the ledger while the switch is off', async () => {
    mockedDb().mockClear()
    mockedDb().mockReturnValue(settingsChain(false) as unknown as ReturnType<typeof db>)

    const r = await sendNow(1, 'user-1')

    expect(r.detail).toMatch(/off/i)
    // Only the settings probe ran — never a read of the obligation itself.
    expect(db).toHaveBeenCalledTimes(1)
    expect(db).toHaveBeenCalledWith('nivaro_settings')
  })

  it('runRetryPass returns all-zero without touching the ledger while the switch is off', async () => {
    mockedDb().mockClear()
    mockedDb().mockReturnValue(settingsChain(false) as unknown as ReturnType<typeof db>)

    const r = await runRetryPass()

    expect(r).toEqual({ retried: 0, gaveUp: 0 })
    expect(db).toHaveBeenCalledTimes(1)
  })

  it('runMissingRefirePass returns all-zero without touching the ledger while the switch is off', async () => {
    mockedDb().mockClear()
    mockedDb().mockReturnValue(settingsChain(false) as unknown as ReturnType<typeof db>)

    const r = await runMissingRefirePass()

    expect(r).toEqual({ refired: 0, queued: 0 })
    expect(db).toHaveBeenCalledTimes(1)
  })
})

// ─── sendNow, gate ON ───────────────────────────────────────────────────

function chain(overrides: Record<string, unknown> = {}) {
  const c: Record<string, unknown> = {
    where: vi.fn(),
    whereIn: vi.fn(),
    whereNotNull: vi.fn(),
    whereNull: vi.fn(),
    orderBy: vi.fn(),
    join: vi.fn(),
    leftJoin: vi.fn(),
    limit: vi.fn(),
    select: vi.fn().mockResolvedValue([]),
    first: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }
  for (const k of ['where', 'whereIn', 'whereNotNull', 'whereNull', 'orderBy', 'join', 'leftJoin', 'limit']) {
    if (!(k in overrides)) (c[k] as ReturnType<typeof vi.fn>).mockReturnValue(c)
  }
  return c
}

describe('sendNow — gate on', () => {
  beforeEach(() => clearObligationKinds())
  afterEach(() => vi.clearAllMocks())

  it('reports "no such obligation" and touches nothing else when the row does not exist', async () => {
    const settings = settingsChain(true)
    const obligations = chain({ first: vi.fn().mockResolvedValue(undefined) })
    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_settings') return settings
      if (table === 'nivaro_integration_obligations') return obligations
      throw new Error(`unexpected table: ${table}`)
    }) as never)

    const r = await sendNow(999, 'user-1')
    expect(r.detail).toBe('no such obligation')
  })

  it('reports "nothing to re-send" for a missing obligation with no prior submission to repeat', async () => {
    const settings = settingsChain(true)
    const obligations = chain({
      first: vi
        .fn()
        .mockResolvedValue({ id: 1, api: 'Partner', collection: 'workflows', item: '1', submission_id: null })
    })
    const priorLookup = chain({ first: vi.fn().mockResolvedValue(undefined) })
    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_settings') return settings
      if (table === 'nivaro_integration_obligations') return obligations
      if (table === 'nivaro_erp_submissions as es') return priorLookup
      throw new Error(`unexpected table: ${table}`)
    }) as never)

    const r = await sendNow(1, 'user-1')
    expect(r.detail).toMatch(/nothing to re-send/)
  })
})

describe('runRetryPass — gate on', () => {
  afterEach(() => vi.clearAllMocks())

  it('gives up a row past the ladder and marks it failed with a "gave up:" reason', async () => {
    const settings = settingsChain(true)
    const old = new Date('2020-01-01T00:00:00Z')
    const obligations: Record<string, unknown> = chain({
      select: vi
        .fn()
        .mockResolvedValue([{ id: 5, submission_id: 50, attempts: 5, updated_at: old }])
    })
    const updateChain = { where: vi.fn(), update: vi.fn().mockResolvedValue(1) }
    updateChain.where.mockReturnValue(updateChain)

    let obligationsCall = 0
    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_settings') return settings
      if (table === 'nivaro_integration_obligations as o') return obligations
      if (table === 'nivaro_integration_obligations') {
        obligationsCall++
        return updateChain
      }
      throw new Error(`unexpected table: ${table}`)
    }) as never)

    const r = await runRetryPass()

    expect(r).toEqual({ retried: 0, gaveUp: 1 })
    expect(obligationsCall).toBe(1)
    const patch = updateChain.update.mock.calls[0][0] as Record<string, unknown>
    expect(patch.outcome).toBe('failed')
    expect(patch.reason).toMatch(/^gave up:/)
  })
})

// ─── The actual send: resendSubmission, exercised through its three callers
// (sendPayload/applySendOutcome/propagateSubmissionStatus mocked above, so
// this proves the ORCHESTRATION — who gets called with what — without
// hitting a real network or a real submission row). ────────────────────────

describe('sendNow — actually sends (resendSubmission)', () => {
  afterEach(() => vi.clearAllMocks())

  it("re-sends the obligation's OWN submission through sendPayload, then moves the submission row and the obligation", async () => {
    const settings = settingsChain(true)
    const obligations = chain({
      first: vi.fn().mockResolvedValue({
        id: 1,
        api: 'Partner',
        collection: 'workflows',
        item: '1',
        submission_id: 50
      })
    })
    const submissionRow = chain({
      first: vi.fn().mockResolvedValue({
        external_api: 7,
        payload: JSON.stringify({ endpoint_path: '/orders', body: { a: 1 } }),
        external_ref: null,
        attempts: 2
      })
    })
    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_settings') return settings
      if (table === 'nivaro_integration_obligations') return obligations
      if (table === 'nivaro_erp_submissions') return submissionRow
      throw new Error(`unexpected table: ${table}`)
    }) as never)

    vi.mocked(sendPayload).mockResolvedValue({
      status: 'accepted',
      external_ref: 'REF-1',
      error: null,
      response: { status: 'OK' },
      http_status: 200
    })

    const r = await sendNow(1, 'user-1')

    // Through the SAME path the original send used — same guards, same
    // side effects — never a bypass.
    expect(sendPayload).toHaveBeenCalledWith(
      7,
      { endpoint_path: '/orders', body: { a: 1 } },
      'user-1'
    )
    expect(applySendOutcome).toHaveBeenCalledWith({
      submissionId: 50,
      outcome: expect.objectContaining({ status: 'accepted' }),
      priorExternalRef: null,
      priorAttempts: 2
    })
    expect(propagateSubmissionStatus).toHaveBeenCalledWith({
      submissionId: 50,
      status: 'accepted',
      error: null,
      obligationId: 1
    })
    expect(r.detail).toBe('re-sent: accepted')
  })

  it('reports what the payload could not survive without ever calling sendPayload — unreadable stored payload', async () => {
    const settings = settingsChain(true)
    const obligations = chain({
      first: vi.fn().mockResolvedValue({
        id: 1,
        api: 'Partner',
        collection: 'workflows',
        item: '1',
        submission_id: 50
      })
    })
    const submissionRow = chain({
      first: vi.fn().mockResolvedValue({
        external_api: 7,
        payload: 'not json',
        external_ref: null,
        attempts: 0
      })
    })
    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_settings') return settings
      if (table === 'nivaro_integration_obligations') return obligations
      if (table === 'nivaro_erp_submissions') return submissionRow
      throw new Error(`unexpected table: ${table}`)
    }) as never)

    const r = await sendNow(1, 'user-1')

    expect(sendPayload).not.toHaveBeenCalled()
    expect(r.detail).toMatch(/not readable/)
  })
})

describe('runMissingRefirePass — gate on', () => {
  beforeEach(() => clearObligationKinds())
  afterEach(() => vi.clearAllMocks())

  it('queues a kind that declares itself unsafe to re-fire, and never even looks for a prior submission', async () => {
    registerObligationKind({
      api: 'Partner',
      kind: 'inbound',
      collection: 'workflows',
      label: 'x',
      safe_to_refire: false,
      expect: async () => []
    })
    const settings = settingsChain(true)
    const missingRows = chain({
      select: vi
        .fn()
        .mockResolvedValue([{ id: 10, api: 'Partner', kind: 'inbound', collection: 'workflows', item: '1' }])
    })
    const updateChain = { where: vi.fn(), update: vi.fn().mockResolvedValue(1) }
    updateChain.where.mockReturnValue(updateChain)
    const obligationsQueue: unknown[] = [missingRows, updateChain]

    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_settings') return settings
      if (table === 'nivaro_integration_obligations') {
        const next = obligationsQueue.shift()
        if (!next) throw new Error('unscripted extra call on nivaro_integration_obligations')
        return next
      }
      throw new Error(`unexpected table: ${table}`)
    }) as never)

    const r = await runMissingRefirePass()

    expect(r).toEqual({ refired: 0, queued: 1 })
    expect(sendPayload).not.toHaveBeenCalled()
    const patch = updateChain.update.mock.calls[0][0] as Record<string, unknown>
    expect(patch.outcome).toBe('failed')
    expect(patch.reason).toMatch(/^gave up: this kind is never re-fired/)
  })

  it('re-fires from the most recent prior request for the same record + API when the kind allows it', async () => {
    registerObligationKind({
      api: 'Partner',
      kind: 'outbound',
      collection: 'workflows',
      label: 'x',
      expect: async () => []
    })
    const settings = settingsChain(true)
    const missingRows = chain({
      select: vi
        .fn()
        .mockResolvedValue([{ id: 11, api: 'Partner', kind: 'outbound', collection: 'workflows', item: '2' }])
    })
    const priorLookup = chain({ first: vi.fn().mockResolvedValue({ id: 77 }) })
    const submissionRow = chain({
      first: vi.fn().mockResolvedValue({
        external_api: 7,
        payload: JSON.stringify({ endpoint_path: '/orders', body: { a: 1 } }),
        external_ref: null,
        attempts: 0
      })
    })
    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_settings') return settings
      if (table === 'nivaro_integration_obligations') return missingRows
      if (table === 'nivaro_erp_submissions as es') return priorLookup
      if (table === 'nivaro_erp_submissions') return submissionRow
      throw new Error(`unexpected table: ${table}`)
    }) as never)

    vi.mocked(sendPayload).mockResolvedValue({
      status: 'pending',
      external_ref: null,
      error: null,
      response: { status: 'received' },
      http_status: 202
    })

    const r = await runMissingRefirePass()

    expect(r).toEqual({ refired: 1, queued: 0 })
    expect(sendPayload).toHaveBeenCalledWith(7, { endpoint_path: '/orders', body: { a: 1 } }, undefined)
    expect(propagateSubmissionStatus).toHaveBeenCalledWith({
      submissionId: 77,
      status: 'pending',
      error: null,
      obligationId: 11
    })
  })

  it('queues a missing obligation with no prior request to repeat, without ever calling sendPayload', async () => {
    registerObligationKind({
      api: 'Partner',
      kind: 'outbound',
      collection: 'workflows',
      label: 'x',
      expect: async () => []
    })
    const settings = settingsChain(true)
    const missingRows = chain({
      select: vi
        .fn()
        .mockResolvedValue([{ id: 12, api: 'Partner', kind: 'outbound', collection: 'workflows', item: '3' }])
    })
    const priorLookup = chain({ first: vi.fn().mockResolvedValue(undefined) })
    const updateChain = { where: vi.fn(), update: vi.fn().mockResolvedValue(1) }
    updateChain.where.mockReturnValue(updateChain)
    const obligationsQueue: unknown[] = [missingRows, updateChain]

    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_settings') return settings
      if (table === 'nivaro_integration_obligations') {
        const next = obligationsQueue.shift()
        if (!next) throw new Error('unscripted extra call on nivaro_integration_obligations')
        return next
      }
      if (table === 'nivaro_erp_submissions as es') return priorLookup
      throw new Error(`unexpected table: ${table}`)
    }) as never)

    const r = await runMissingRefirePass()

    expect(r).toEqual({ refired: 0, queued: 1 })
    expect(sendPayload).not.toHaveBeenCalled()
    const patch = updateChain.update.mock.calls[0][0] as Record<string, unknown>
    expect(patch.outcome).toBe('failed')
    expect(patch.reason).toMatch(/^gave up: no earlier request to repeat/)
  })
})
