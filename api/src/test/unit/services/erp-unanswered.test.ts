import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import {
  ANSWER_MARGIN_MS,
  answerByFor,
  answerDeadline,
  erpActionTimeoutMs,
  isUnansweredStale,
  MAX_SEND_TIMEOUT_MS,
  sendingLabel,
  staleUnansweredSends,
  unansweredHold,
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

/** A knex-ish chain whose read answers `rows` (or throws `fail`). */
function reads(rows: unknown[], fail?: Error) {
  const q: Record<string, unknown> = {}
  for (const m of ['leftJoin', 'where', 'orderBy', 'limit']) q[m] = () => q
  q.select = async () => {
    if (fail) throw fail
    return rows
  }
  q.first = async () => ({ name: 'MDSi' })
  return q
}

describe('unansweredHold', () => {
  const key = { collection: 'inventory_request', item: 'r1', apiId: 5, endpointPath: '/orders' }

  it('earlier sends that cannot be read: a hold that says so, naming the partner', async () => {
    vi.mocked(db).mockImplementation(((t: string) =>
      t.startsWith('nivaro_erp_submissions')
        ? reads([], new Error('timeout'))
        : reads([])) as never)
    expect(await unansweredHold(key)).toEqual({
      reason: "Couldn't check earlier sends to MDSi. Try again in a minute.",
      send: null,
      checkFailed: true
    })
  })

  it('nothing unanswered: no hold', async () => {
    vi.mocked(db).mockImplementation((() => reads([])) as never)
    expect(await unansweredHold(key)).toBeNull()
  })

  it('a young one without a move to name (Send now, a retry): the earlier send is still out', async () => {
    const created = new Date(Date.now() - 40_000)
    vi.mocked(db).mockImplementation((() =>
      reads([
        {
          id: 50,
          external_api: 5,
          created_at: created,
          api_name: 'MDSi',
          payload: JSON.stringify({
            endpoint_path: '/orders',
            answer_by: new Date(created.getTime() + 180_000).toISOString()
          })
        }
      ])) as never)
    const hold = await unansweredHold(key)
    expect(hold?.checkFailed).toBe(false)
    expect(hold?.reason).toMatch(
      /^An earlier send to MDSi is still waiting for its answer \(started \d+ seconds ago\)\. Wait for it to finish\.$/
    )
  })
})

describe('staleUnansweredSends (the alert)', () => {
  it('lists only sends past their time, and says which came from a blocking push', async () => {
    const now = Date.parse('2026-11-13T15:00:00Z')
    const row = (id: number, minutesAgo: number, extra: Record<string, unknown> = {}) => {
      const created = new Date(now - minutesAgo * 60_000)
      return {
        id,
        collection: 'inventory_request',
        item: String(id),
        external_api: 5,
        api_name: 'MDSi',
        created_at: created,
        payload: JSON.stringify({
          endpoint_path: '/orders',
          answer_by: new Date(created.getTime() + 180_000).toISOString(),
          ...extra
        })
      }
    }
    vi.mocked(db).mockImplementation((() =>
      reads([row(3, 1), row(2, 30, { blocking: true }), row(1, 60)])) as never)
    expect(await staleUnansweredSends(2000, now)).toEqual([
      {
        id: 2,
        collection: 'inventory_request',
        item: '2',
        api_name: 'MDSi',
        endpoint_path: '/orders',
        started_at: new Date(now - 30 * 60_000).toISOString(),
        blocking: true
      },
      {
        id: 1,
        collection: 'inventory_request',
        item: '1',
        api_name: 'MDSi',
        endpoint_path: '/orders',
        started_at: new Date(now - 60 * 60_000).toISOString(),
        blocking: false
      }
    ])
  })
})
