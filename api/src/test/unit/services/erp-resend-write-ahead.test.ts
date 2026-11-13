import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A resend into a submission's own row (Retry, Send now, the retry sweeps) writes ahead: the
// attempt the row holds is kept, then the row reads `sending` with answer_by until the answer
// lands on it. A process that stops mid-call leaves it `sending` — never the failure a retry
// would repeat. A row already `sending` (someone else's resend is out) is not taken.

type Row = Record<string, unknown>
const store = vi.hoisted(() => ({
  subs: [] as Array<Record<string, unknown>>,
  attempts: [] as Array<Record<string, unknown>>
}))

function query(name: string) {
  const rows = name === 'nivaro_erp_submission_attempts' ? store.attempts : store.subs
  const filters: Array<(r: Row) => boolean> = []
  const matched = () => rows.filter((r) => filters.every((f) => f(r)))
  const q: Record<string, unknown> = {
    where(a: Row) {
      for (const [k, v] of Object.entries(a)) filters.push((r) => r[k] === v)
      return q
    },
    whereNot(col: string, v: unknown) {
      filters.push((r) => r[col] !== v)
      return q
    },
    first: async () => matched()[0],
    insert: async (row: Row) => {
      rows.push(row)
      return [1]
    },
    update: async (patch: Row) => {
      const hit = matched()
      for (const r of hit) Object.assign(r, patch)
      return hit.length
    }
  }
  return q
}

vi.mock('../../../db/index.js', () => {
  const db = (name: string) => query(name)
  ;(db as unknown as { schema: unknown }).schema = { hasColumn: async () => false }
  return { db }
})
vi.mock('../../../services/record-events.js', () => ({
  announceSubmissionAspect: vi.fn(async () => undefined),
  announceRecordAspect: vi.fn()
}))

import { resetChainColumnProbe } from '../../../services/chain-columns.js'
import { resetRequesterColumnProbe } from '../../../services/erp-requester-columns.js'
import { markResendStarting } from '../../../services/erp-submission-status.js'
import { isUnansweredStale } from '../../../services/erp-unanswered.js'

const NOW = new Date('2026-11-13T15:00:00Z')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  store.subs = [
    {
      id: 50,
      status: 'failed',
      attempts: 1,
      payload: JSON.stringify({ endpoint_path: '/orders', body: { a: 1 }, secret_paths: [] }),
      response: null,
      last_error: 'HTTP 503',
      created_at: new Date(NOW.getTime() - 3_600_000),
      updated_at: new Date(NOW.getTime() - 3_600_000)
    }
  ]
  store.attempts = []
})
afterEach(() => {
  vi.useRealTimers()
  resetRequesterColumnProbe()
  resetChainColumnProbe()
})

describe('markResendStarting', () => {
  it('keeps the failure it replaces as an attempt, then marks the row sending with answer_by', async () => {
    expect(await markResendStarting(50, 1, 30_000)).toBe(true)
    // The attempt the row held is not lost to the overwrite.
    expect(store.attempts).toHaveLength(1)
    expect(store.attempts[0]).toMatchObject({
      submission_id: 50,
      attempt: 1,
      status: 'failed',
      source: 'captured'
    })
    const row = store.subs[0]
    expect(row.status).toBe('sending')
    const payload = JSON.parse(String(row.payload))
    expect(payload).toMatchObject({ endpoint_path: '/orders', body: { a: 1 }, secret_paths: [] })
    // 30 s call + 60 s margin.
    expect(payload.answer_by).toBe(new Date(NOW.getTime() + 90_000).toISOString())
    // A crash now leaves it reading in flight, then "may have been received".
    expect(isUnansweredStale(row as never, NOW.getTime() + 60_000)).toBe(false)
    expect(isUnansweredStale(row as never, NOW.getTime() + 91_000)).toBe(true)
  })

  it('a row already sending is not taken (another resend is out)', async () => {
    store.subs[0].status = 'sending'
    expect(await markResendStarting(50, 1)).toBe(false)
    expect(store.attempts).toHaveLength(0)
    expect(store.subs[0].status).toBe('sending')
  })

  it('an unknown row is not taken', async () => {
    expect(await markResendStarting(999, 1)).toBe(false)
  })
})
