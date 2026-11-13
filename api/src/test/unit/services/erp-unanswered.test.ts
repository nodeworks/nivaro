import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  ANSWER_MARGIN_MS,
  answerByFor,
  answerDeadline,
  erpActionTimeoutMs,
  isUnansweredStale,
  MAX_SEND_TIMEOUT_MS,
  sendingLabel,
  unansweredRefusal
} from '../../../services/erp-unanswered.js'

const T0 = new Date('2026-11-12T20:00:00Z')

describe('when an unanswered send stops reading as in flight', () => {
  it('uses the timeout the action sends with (default 120 s, 5 s floor, 10 min ceiling)', () => {
    expect(erpActionTimeoutMs({})).toBe(120_000)
    expect(erpActionTimeoutMs({ timeout_ms: 1_000 })).toBe(5_000)
    expect(erpActionTimeoutMs({ timeout_ms: 3_600_000 })).toBe(MAX_SEND_TIMEOUT_MS)
    expect(answerByFor(T0, 120_000).getTime()).toBe(T0.getTime() + 120_000 + ANSWER_MARGIN_MS)
  })

  it('reads answer_by from the stored request, else the longest timeout any push has', () => {
    const answerBy = new Date(T0.getTime() + 180_000).toISOString()
    const row = {
      created_at: T0,
      payload: JSON.stringify({ endpoint_path: '/x', answer_by: answerBy })
    }
    expect(answerDeadline(row)).toBe(T0.getTime() + 180_000)
    expect(isUnansweredStale(row, T0.getTime() + 179_000)).toBe(false)
    expect(isUnansweredStale(row, T0.getTime() + 181_000)).toBe(true)
    // An older row without answer_by is never called stale too early.
    const old = { created_at: T0, payload: JSON.stringify({ endpoint_path: '/x' }) }
    expect(answerDeadline(old)).toBe(T0.getTime() + MAX_SEND_TIMEOUT_MS + ANSWER_MARGIN_MS)
    expect(answerDeadline({ created_at: T0, payload: 'not json' })).toBe(
      T0.getTime() + MAX_SEND_TIMEOUT_MS + ANSWER_MARGIN_MS
    )
  })

  it('labels it for people', () => {
    expect(sendingLabel(false)).toBe('Sending…')
    expect(sendingLabel(true)).toBe('No answer — may have been received')
  })
})

describe('the refusal', () => {
  const send = { started_at: T0.toISOString(), api_name: 'MDSi' }
  it('in flight: wait for it', () => {
    expect(
      unansweredRefusal({
        send: { ...send, stale: false },
        moveLabel: 'Submit to Warehouse',
        when: 'x',
        now: T0.getTime() + 40_000
      })
    ).toBe(
      'Submit to Warehouse is still being sent to MDSi (started 40 seconds ago). Wait for it to finish.'
    )
  })

  it('stale: the partner may have it, check first and mark it', () => {
    expect(
      unansweredRefusal({
        send: { ...send, stale: true },
        moveLabel: 'Submit to Warehouse',
        when: 'Thu, Nov 12 at 3:00 PM EST'
      })
    ).toBe(
      'MDSi may already have this order: the last send on Thu, Nov 12 at 3:00 PM EST got no answer before the app stopped. Check MDSi before sending again, then mark that send as received or not received in Integrations, ERP submissions.'
    )
  })

  it('without the partner name it still reads as a sentence', () => {
    const text = unansweredRefusal({
      send: { ...send, api_name: null, stale: true },
      moveLabel: 'Submit',
      when: 'then'
    })
    expect(text.startsWith('The other system may already have this order')).toBe(true)
    expect(text).toContain('Check the other system before')
  })
})
