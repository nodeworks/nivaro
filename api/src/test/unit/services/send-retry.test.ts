import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: {} }))

import {
  nextSweepRun,
  planRetry,
  REMEDIATION_LADDER,
  type RetryContext,
  type RetryRowFacts,
  scheduledPolicy
} from '../../../services/send-retry.js'
import { cleanReferenceLabel, referenceLabelOf } from '../../../services/send-status.js'

const NOW = Date.parse('2026-11-14T15:42:00Z')
const row = (o: Partial<RetryRowFacts> = {}): RetryRowFacts => ({
  status: 'failed',
  error_class: 'transient',
  attempts: 1,
  retry_count: 0,
  next_retry_at: null,
  updated_at: new Date(NOW - 60_000).toISOString(),
  has_body: true,
  ...o
})
// Ticks are the due time itself unless a test says otherwise.
const ctx = (o: Partial<RetryContext> = {}): RetryContext => ({
  now: NOW,
  api: 'Ledger',
  policy: null,
  apiHasPolicy: false,
  remediationOn: false,
  obligation: null,
  tick: (_s, due) => due,
  ...o
})

describe('planRetry (rt6 #18)', () => {
  it('only failed sends get a plan', () => {
    for (const status of ['sending', 'pending', 'accepted'])
      expect(planRetry(row({ status }), ctx())).toBeNull()
  })

  it('policy sweep: next_retry_at, attempt n of max+1', () => {
    const due = new Date(NOW + 7 * 60_000)
    const p = planRetry(
      row({ retry_count: 1, next_retry_at: due }),
      ctx({ policy: { max_attempts: 4, backoff_minutes: 5 }, apiHasPolicy: true })
    )
    expect(p).toEqual({ retry: { at: due.toISOString(), attempt: 3, of: 5 }, no_retry: null })
  })

  it('policy sweep: a first failure goes on the next tick', () => {
    const tick = new Date(NOW + 8 * 60_000)
    const p = planRetry(
      row(),
      ctx({
        policy: { max_attempts: 2, backoff_minutes: 5 },
        apiHasPolicy: true,
        tick: (sweep) => (sweep === 'erp-auto-retry' ? tick : null)
      })
    )
    expect(p?.retry).toEqual({ at: tick.toISOString(), attempt: 2, of: 3 })
  })

  it('policy sweep: out of attempts, paused, or a refusal repetition cannot fix', () => {
    const policy = { max_attempts: 2, backoff_minutes: 5 }
    expect(planRetry(row({ retry_count: 2 }), ctx({ policy, apiHasPolicy: true }))).toEqual({
      retry: null,
      no_retry: 'all 3 attempts were made'
    })
    expect(planRetry(row(), ctx({ policy, apiHasPolicy: true, tick: () => null }))?.no_retry).toBe(
      'automatic retries are paused'
    )
    expect(
      planRetry(row({ error_class: 'validation' }), ctx({ policy, apiHasPolicy: true }))?.no_retry
    ).toBe('sending the same thing again cannot fix it')
    expect(
      planRetry(row({ status: 'rejected' }), ctx({ policy, apiHasPolicy: true }))?.no_retry
    ).toBe('sending the same thing again cannot fix it')
    // The policy sweep takes unknown / auth / unclassified failures too.
    for (const error_class of ['auth', 'unknown', null])
      expect(
        planRetry(row({ error_class }), ctx({ policy, apiHasPolicy: true }))?.retry
      ).not.toBeNull()
  })

  it('nothing stored to send: never retried', () => {
    expect(
      planRetry(row({ has_body: false }), ctx({ policy: { max_attempts: 3, backoff_minutes: 1 } }))
    ).toEqual({ retry: null, no_retry: 'there is nothing stored to send again' })
  })

  it('remediation ladder: only with the switch on and an open obligation', () => {
    expect(planRetry(row(), ctx())?.no_retry).toBe('automatic retries are not set up for Ledger')
    expect(planRetry(row(), ctx({ remediationOn: true }))?.no_retry).toBe(
      'automatic retries are not set up for Ledger'
    )
    const last = NOW - 60_000
    const p = planRetry(
      row({ attempts: 2, updated_at: new Date(last).toISOString() }),
      ctx({ remediationOn: true, obligation: 'failed' })
    )
    expect(p?.retry).toEqual({
      at: new Date(last + REMEDIATION_LADDER[2] * 60_000).toISOString(),
      attempt: 3,
      of: REMEDIATION_LADDER.length
    })
  })

  it('remediation ladder: never for an API with any retry policy (even inline-only)', () => {
    expect(
      planRetry(row(), ctx({ remediationOn: true, obligation: 'failed', apiHasPolicy: true }))
        ?.no_retry
    ).toBe('automatic retries are not set up for Ledger')
  })

  it('remediation ladder: gave up, used up, or a class it does not retry', () => {
    const on = { remediationOn: true, obligation: 'failed' as const }
    expect(planRetry(row(), ctx({ ...on, obligation: 'gave_up' }))?.no_retry).toBe(
      'all 5 attempts were made'
    )
    expect(planRetry(row({ attempts: 5 }), ctx(on))?.no_retry).toBe('all 5 attempts were made')
    expect(planRetry(row({ error_class: 'unknown' }), ctx(on))?.no_retry).toBe(
      'it is not clear that sending it again would help'
    )
    // A due time already passed is "now" (the next tick).
    const p = planRetry(row({ attempts: 1, updated_at: new Date(NOW - 3_600_000) }), ctx(on))
    expect(p?.retry?.at).toBe(new Date(NOW).toISOString())
  })
})

describe('nextSweepRun', () => {
  it('the cron run at or after the due time; paused = none', () => {
    const due = new Date('2026-11-14T15:41:30Z')
    const at = nextSweepRun('erp-auto-retry', due, { expression: '*/10 * * * *', timezone: 'UTC' })
    expect(at?.toISOString()).toBe('2026-11-14T15:50:00.000Z')
    const exact = new Date('2026-11-14T15:45:00Z')
    expect(
      nextSweepRun('integration-reconcile', exact, {
        expression: '*/15 * * * *',
        timezone: 'UTC'
      })?.toISOString()
    ).toBe('2026-11-14T15:45:00.000Z')
    expect(nextSweepRun('erp-auto-retry', due, { expression: '*/10 * * * *', paused: true })).toBe(
      null
    )
  })

  it('falls back to the default schedule when the registry has none', () => {
    const at = nextSweepRun('integration-reconcile', new Date('2026-11-14T15:46:00Z'), null)
    expect(at && at.getUTCMinutes() % 15).toBe(0)
  })
})

describe('scheduledPolicy', () => {
  it('both halves, or nothing (an inline-only policy schedules no retry)', () => {
    expect(scheduledPolicy('{"max_attempts":3,"backoff_minutes":5}')).toEqual({
      max_attempts: 3,
      backoff_minutes: 5
    })
    expect(scheduledPolicy({ max_attempts: 30, backoff_minutes: 1 })?.max_attempts).toBe(10)
    expect(scheduledPolicy('{"inline_retries":2}')).toBeNull()
    expect(scheduledPolicy(null)).toBeNull()
    expect(scheduledPolicy('not json')).toBeNull()
  })
})

describe('reference label', () => {
  it('reads and cleans the label stored in integration_config', () => {
    expect(referenceLabelOf('{"reference_label":"PO","skip_sends":[]}')).toBe('PO')
    expect(referenceLabelOf({ reference_label: '  Sales\norder  ' })).toBe('Sales order')
    expect(referenceLabelOf('{"skip_sends":[]}')).toBeNull()
    expect(referenceLabelOf('nope')).toBeNull()
    expect(cleanReferenceLabel('<b>PO</b>')).toBe('b PO /b')
    expect(cleanReferenceLabel('x'.repeat(60))?.length).toBe(40)
    expect(cleanReferenceLabel('   ')).toBeNull()
  })
})
