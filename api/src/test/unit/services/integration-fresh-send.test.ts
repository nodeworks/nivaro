import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The partner is never called: sendPayload is the one function that sends,
// reached through a dynamic import (vi.mock intercepts it the same way).
vi.mock('../../../routes/erp-submissions.js', () => ({ sendPayload: vi.fn() }))
vi.mock('../../../services/erp-submission-status.js', () => ({
  applySendOutcome: vi.fn(async () => {}),
  markResendStarting: vi.fn(async () => true),
  propagateSubmissionStatus: vi.fn(async () => {})
}))
// The unanswered-send check has its own tests (erp-unanswered / remediation-unanswered):
// here nothing earlier is waiting on an answer.
vi.mock('../../../services/erp-unanswered.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/erp-unanswered.js')>()),
  unansweredHold: vi.fn(async () => null)
}))

vi.mock('../../../services/workflow-actions.js', () => ({
  buildErpPushForCurrentState: vi.fn()
}))

import { db } from '../../../db/index.js'
import { sendPayload } from '../../../routes/erp-submissions.js'
import {
  applySendOutcome,
  propagateSubmissionStatus
} from '../../../services/erp-submission-status.js'
import { unansweredHold } from '../../../services/erp-unanswered.js'
import {
  clearObligationKinds,
  registerObligationKind
} from '../../../services/integration-obligations.js'
import {
  freshSendPreview,
  freshSendRefusal,
  runMissingRefirePass,
  sendFresh,
  sendNow,
  sendOptionsFor
} from '../../../services/integration-remediation.js'
import { buildErpPushForCurrentState } from '../../../services/workflow-actions.js'

const mockedDb = () => vi.mocked(db as unknown as (table: string) => unknown)

function chain(first: unknown) {
  const c: Record<string, unknown> = {}
  for (const k of ['where', 'whereIn', 'whereNull', 'whereRaw', 'orderBy', 'limit', 'join']) {
    c[k] = vi.fn(() => c)
  }
  c.first = vi.fn().mockResolvedValue(first)
  c.select = vi.fn().mockResolvedValue([])
  return c
}

const OBLIGATION = {
  id: 7,
  api: 'LinX',
  kind: 'wf.nuvolo_status',
  collection: 'workflows',
  item: '372931',
  submission_id: null,
  outcome: 'missing'
}

type Kind = Parameters<typeof registerObligationKind>[0]

function linxKind(overrides: Partial<Kind> = {}): Kind {
  return {
    api: 'LinX',
    kind: 'wf.nuvolo_status',
    collection: 'workflows',
    label: 'LinX — workflow status write-back',
    endpoint_path: '/api/efp/v1/projectupdate',
    safe_to_refire: false,
    expect: async () => [],
    fresh_request: vi.fn(async () => ({
      endpoint_path: '/api/efp/v1/projectupdate',
      body: { project_number: 'CPJ0007656', Status: 'Waiting On Level 3 Approval' },
      summary: 'Waiting on Level 3 Approval, requisition PW27-81371, no PO'
    })),
    ...overrides
  } as Kind
}

/** db wiring: settings on, the obligation row, the LinX api row, the submissions insert. */
function wire(opts: { remediation?: boolean } = {}) {
  const submissions: Record<string, ReturnType<typeof vi.fn>> = {
    insert: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 901 }]) }))
  }
  mockedDb().mockImplementation(((table: string) => {
    if (table === 'nivaro_settings') {
      return chain({ integration_remediation_enabled: opts.remediation ?? true })
    }
    if (table === 'nivaro_integration_obligations') return chain(OBLIGATION)
    if (table === 'nivaro_external_apis') return chain({ id: 12 })
    if (table === 'nivaro_erp_submissions') return submissions
    throw new Error(`unexpected table: ${table}`)
  }) as never)
  return { submissions }
}

describe('freshSendRefusal / sendOptionsFor', () => {
  it('offers current data only for a kind that can rebuild it and is not a person’s send', () => {
    expect(freshSendRefusal(linxKind())).toBeNull()
    expect(freshSendRefusal(linxKind({ fresh_request: undefined }))).toMatch(/cannot rebuild/)
    expect(freshSendRefusal(linxKind({ human: true }))).toMatch(/belongs to a person/)
    expect(freshSendRefusal(undefined)).toMatch(/no longer registered/)
  })

  it('a missing LinX row offers "Send current data" and not a repeat; a failed one offers both', () => {
    expect(sendOptionsFor(linxKind(), { submission_id: null })).toEqual({
      can_resend: false,
      can_send_current: true
    })
    expect(sendOptionsFor(linxKind(), { submission_id: 55 })).toEqual({
      can_resend: true,
      can_send_current: true
    })
  })
})

describe('sendFresh — a person’s "Send current data"', () => {
  beforeEach(() => clearObligationKinds())
  afterEach(() => vi.clearAllMocks())

  it('rebuilds from current data and sends it through the normal path into a new row', async () => {
    const kind = linxKind()
    registerObligationKind(kind)
    const { submissions } = wire()
    vi.mocked(sendPayload).mockResolvedValue({
      status: 'accepted',
      external_ref: null,
      error: null,
      response: { ok: true },
      http_status: 200
    })

    const r = await sendFresh(7, 'user-rob')

    expect(kind.fresh_request).toHaveBeenCalledWith(expect.anything(), '372931')
    const row = submissions.insert.mock.calls[0][0] as Record<string, unknown>
    expect(row).toMatchObject({
      collection: 'workflows',
      item: '372931',
      external_api: 12,
      // Written before the call: a crash mid-call leaves it `sending` (erp-unanswered.ts).
      status: 'sending',
      attempts: 0,
      obligation_id: 7
    })
    expect(JSON.parse(String(row.payload))).toEqual({
      endpoint_path: '/api/efp/v1/projectupdate',
      body: { project_number: 'CPJ0007656', Status: 'Waiting On Level 3 Approval' },
      secret_paths: [],
      answer_by: expect.any(String)
    })
    expect(sendPayload).toHaveBeenCalledWith(
      12,
      expect.objectContaining({ endpoint_path: '/api/efp/v1/projectupdate' }),
      'user-rob'
    )
    expect(applySendOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ submissionId: 901, priorAttempts: 0, requestedVia: 'resend' })
    )
    expect(propagateSubmissionStatus).toHaveBeenCalledWith(
      expect.objectContaining({ submissionId: 901, status: 'accepted', obligationId: 7 })
    )
    expect(r.detail).toBe(
      'sent current data (Waiting on Level 3 Approval, requisition PW27-81371, no PO): accepted'
    )
  })

  it('an earlier send of it with no answer: refused, no row, nothing sent', async () => {
    registerObligationKind(linxKind())
    const { submissions } = wire()
    vi.mocked(unansweredHold).mockResolvedValueOnce({
      reason:
        'An earlier send to LinX is still waiting for its answer (started 40 seconds ago). Wait for it to finish.',
      send: null,
      checkFailed: false
    })
    const r = await sendFresh(7, 'user-rob')
    expect(r).toEqual({
      detail:
        'An earlier send to LinX is still waiting for its answer (started 40 seconds ago). Wait for it to finish.',
      code: 'unanswered'
    })
    expect(unansweredHold).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'workflows',
        item: '372931',
        apiId: 12,
        endpointPath: '/api/efp/v1/projectupdate'
      })
    )
    expect(submissions.insert).not.toHaveBeenCalled()
    expect(sendPayload).not.toHaveBeenCalled()
  })

  it('a builder refusal (no LinX id) sends nothing and says why', async () => {
    registerObligationKind(
      linxKind({ fresh_request: async () => ({ refused: 'this workflow has no LinX ID' }) })
    )
    const { submissions } = wire()
    const r = await sendFresh(7, 'user-rob')
    expect(r.detail).toBe('not sent: this workflow has no LinX ID')
    expect(submissions.insert).not.toHaveBeenCalled()
    expect(sendPayload).not.toHaveBeenCalled()
  })

  it('refuses a request built for another endpoint (never a sibling push’s shape)', async () => {
    registerObligationKind(
      linxKind({
        fresh_request: async () => ({ endpoint_path: '/other', body: { a: 1 }, summary: 'x' })
      })
    )
    wire()
    const r = await sendFresh(7, 'user-rob')
    expect(r.detail).toMatch(/different endpoint/)
    expect(sendPayload).not.toHaveBeenCalled()
  })

  it('never sends for a kind that belongs to a person (Fusion submit)', async () => {
    registerObligationKind(linxKind({ human: true }))
    wire()
    const r = await sendFresh(7, 'user-rob')
    expect(r.detail).toMatch(/belongs to a person/)
    expect(sendPayload).not.toHaveBeenCalled()
  })

  it('does nothing while remediation is off', async () => {
    registerObligationKind(linxKind())
    wire({ remediation: false })
    const r = await sendFresh(7, 'user-rob')
    expect(r.detail).toMatch(/off/)
    expect(sendPayload).not.toHaveBeenCalled()
  })

  it('the preview names what would be sent and sends nothing', async () => {
    registerObligationKind(linxKind())
    const { submissions } = wire()
    expect(await freshSendPreview(7)).toEqual({
      available: true,
      api: 'LinX',
      summary: 'Waiting on Level 3 Approval, requisition PW27-81371, no PO'
    })
    expect(submissions.insert).not.toHaveBeenCalled()
    expect(sendPayload).not.toHaveBeenCalled()
  })
})

describe('Send now on a stale-unsafe row points at current data instead of refusing', () => {
  beforeEach(() => clearObligationKinds())
  afterEach(() => vi.clearAllMocks())

  it('answers fresh_available and sends nothing by itself', async () => {
    const kind = linxKind()
    registerObligationKind(kind)
    wire()
    const r = await sendNow(7, 'user-rob')
    expect(r.code).toBe('fresh_available')
    expect(r.detail).toMatch(/send the current data instead/)
    expect(kind.fresh_request).not.toHaveBeenCalled()
    expect(sendPayload).not.toHaveBeenCalled()
  })
})

describe('the automatic sweep never fresh-sends', () => {
  beforeEach(() => clearObligationKinds())
  afterEach(() => vi.clearAllMocks())

  it('runMissingRefirePass leaves a fresh-capable, never-refire kind alone', async () => {
    const kind = linxKind()
    registerObligationKind(kind)
    wire()
    const r = await runMissingRefirePass()
    expect(r).toEqual({ refired: 0, queued: 0 })
    expect(kind.fresh_request).not.toHaveBeenCalled()
    expect(sendPayload).not.toHaveBeenCalled()
  })
})

describe('MWF state push — current data from the transition into the current state', () => {
  beforeEach(() => clearObligationKinds())
  afterEach(() => vi.clearAllMocks())

  const mwfKind = (): Kind =>
    ({
      api: 'MWF',
      kind: 'wf.state',
      collection: 'workflows',
      label: 'MWF — workflow state',
      endpoint_path: '/update_workflow.php',
      safe_to_refire: false,
      expect: async () => [],
      fresh_from_transition: { except_states: ['completed'] }
    }) as Kind

  it('offers it, renders through core’s erp_submit builder, and sends through the normal path', async () => {
    registerObligationKind(mwfKind())
    expect(sendOptionsFor(mwfKind(), { submission_id: null }).can_send_current).toBe(true)
    const submissions: Record<string, ReturnType<typeof vi.fn>> = {
      insert: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 902 }]) }))
    }
    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_settings') return chain({ integration_remediation_enabled: true })
      if (table === 'nivaro_integration_obligations') {
        return chain({ ...OBLIGATION, api: 'MWF', kind: 'wf.state' })
      }
      if (table === 'nivaro_erp_submissions') return submissions
      throw new Error(`unexpected table: ${table}`)
    }) as never)
    vi.mocked(buildErpPushForCurrentState).mockResolvedValue({
      api_id: 1,
      endpoint_path: '/update_workflow.php',
      body: { token: '⟦nvr-secret:token⟧', efp_state: 'Waiting On Level 3 Approval' },
      state: { key: 'waiting_on_level_3_approval', label: 'Waiting on Level 3 Approval' },
      transition_label: 'Approve'
    })
    vi.mocked(sendPayload).mockResolvedValue({
      status: 'accepted',
      external_ref: null,
      error: null,
      response: null,
      http_status: 200
    })

    expect((await freshSendPreview(7, 'user-rob')).summary).toBe(
      'Waiting on Level 3 Approval, as “Approve” sends it'
    )
    expect(sendPayload).not.toHaveBeenCalled()

    const r = await sendFresh(7, 'user-rob')
    expect(buildErpPushForCurrentState).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'workflows',
        item: '372931',
        apiName: 'MWF',
        endpointPath: '/update_workflow.php',
        userId: 'user-rob',
        states: { only: undefined, except: ['completed'] }
      })
    )
    const stored = JSON.parse(String(submissions.insert.mock.calls[0][0].payload))
    // The template's own secret slot is the only one a resend may fill.
    expect(stored.secret_paths).toEqual(['/token'])
    expect(sendPayload).toHaveBeenCalledWith(1, expect.anything(), 'user-rob')
    expect(r.detail).toMatch(
      /^sent current data \(Waiting on Level 3 Approval, as “Approve” sends it\): accepted/
    )
  })

  it('a gate refusal reads in plain words and sends nothing', async () => {
    registerObligationKind(mwfKind())
    wire()
    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_settings') return chain({ integration_remediation_enabled: true })
      if (table === 'nivaro_integration_obligations') {
        return chain({ ...OBLIGATION, api: 'MWF', kind: 'wf.state' })
      }
      throw new Error(`unexpected table: ${table}`)
    }) as never)
    vi.mocked(buildErpPushForCurrentState).mockResolvedValue({
      refused: 'skip_when_empty: mwf_queue empty'
    })
    const r = await sendFresh(7, 'user-rob')
    expect(r.detail).toBe('not sent: this record has no MWF queue yet')
    expect(sendPayload).not.toHaveBeenCalled()
  })

  it('the sweep never calls the builder', async () => {
    registerObligationKind(mwfKind())
    wire()
    await runMissingRefirePass()
    expect(buildErpPushForCurrentState).not.toHaveBeenCalled()
  })
})
