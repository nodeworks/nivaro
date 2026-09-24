import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import { gatherSubmissionFacts } from '../../../services/submission-detail.js'

type Chain = Record<string, ReturnType<typeof vi.fn>>

/** A knex-shaped chain: every method is chainable EXCEPT `first`/`select`,
 *  which resolve like the real query builder's terminal calls do — real
 *  Promises, so a trailing `.catch()` (as `gatherSubmissionFacts` always
 *  appends) works without any special-casing. `modify` actually invokes its
 *  callback with the chain (as real knex does), so a `.where(...)` called
 *  from inside `.modify()` lands on the same spy as everything else. */
function makeChain(overrides: Partial<{ first: unknown; select: unknown[] }> = {}): Chain {
  const chain: Chain = {}
  for (const m of [
    'where',
    'orWhere',
    'andWhere',
    'whereIn',
    'whereNotIn',
    'whereNull',
    'whereNotNull',
    'whereBetween',
    'orderBy',
    'orderByRaw',
    'limit',
    'offset',
    'join',
    'leftJoin',
    'rightJoin',
    'groupBy',
    'having',
    'distinct'
  ]) {
    chain[m] = vi.fn(() => chain)
  }
  chain.modify = vi.fn((fn: (qb: Chain) => void) => {
    fn(chain)
    return chain
  })
  chain.first = vi.fn(() => Promise.resolve(overrides.first ?? null))
  chain.select = vi.fn(() => Promise.resolve(overrides.select ?? []))
  return chain
}

const CREATED = new Date('2026-09-21T18:42:03.000Z')
const TRANSITION_ID = 'AAAAAAAA-BBBB-CCCC-DDDD-000000000001'

function baseSubmissionRow(over: Record<string, unknown> = {}) {
  return {
    id: 82,
    collection: 'workflows',
    item: '1001',
    external_api: 9,
    status: 'failed',
    attempts: 1,
    payload: null,
    created_at: CREATED,
    updated_at: CREATED,
    error_class: null,
    obligation_id: null,
    ...over
  }
}

afterEach(() => vi.clearAllMocks())

describe('gatherSubmissionFacts — history + record-edit query construction (Task 15d fix round 1)', () => {
  it('history query: filters on the exact transition when the obligation names one, and windows ±15s', async () => {
    const submissionRow = makeChain({ first: baseSubmissionRow() })
    const apiChain = makeChain({ first: { id: 9, name: 'Partner', owner_user: null } })
    const obligationChain = makeChain({
      first: {
        id: 7,
        kind: 'x',
        api: 'Partner',
        trigger: 'transition',
        trigger_ref: TRANSITION_ID,
        outcome: 'failed',
        reason: null,
        due_at: null,
        resolved_at: null,
        created_at: CREATED
      }
    })
    const transitionChain = makeChain({
      first: {
        id: TRANSITION_ID,
        label: 'Submit',
        auto_trigger: false,
        template_id: 'TPL-1',
        template_name: 'Orders'
      }
    })
    const attemptsChain = makeChain({ select: [] })
    const activityChain = makeChain({ select: [], first: null })
    const logsChain = makeChain({ select: [] })
    const historyChain = makeChain({ first: null })
    const usersChain = makeChain({ select: [] })

    vi.mocked(db).mockImplementation(((table: string) => {
      if (table === 'nivaro_erp_submissions') return submissionRow
      if (table === 'nivaro_external_apis') return apiChain
      if (table === 'nivaro_integration_obligations') return obligationChain
      if (table === 'nivaro_workflow_transitions as t') return transitionChain
      if (table === 'nivaro_erp_submission_attempts') return attemptsChain
      if (table === 'nivaro_activity') return activityChain
      if (table === 'nivaro_external_api_logs') return logsChain
      if (table === 'nivaro_workflow_history as h') return historyChain
      if (table === 'nivaro_users') return usersChain
      throw new Error(`unexpected table: ${table}`)
    }) as never)
    ;(db as unknown as { raw: ReturnType<typeof vi.fn> }).raw = vi.fn().mockResolvedValue([])

    const facts = await gatherSubmissionFacts(82)

    expect(facts).not.toBeNull()
    // Exact transition filter — never a clock-only guess when the
    // obligation already names one.
    expect(historyChain.where).toHaveBeenCalledWith('h.transition', TRANSITION_ID)
    // ±15s (was ±60s — a wider window risked matching an unrelated later
    // transition on a record with several).
    const bounds = historyChain.whereBetween.mock.calls[0][1] as [Date, Date]
    expect(bounds[0].getTime()).toBe(CREATED.getTime() - 15_000)
    expect(bounds[1].getTime()).toBe(CREATED.getTime() + 15_000)
  })

  it("history query: no exact filter when the obligation's trigger_ref does not resolve to a transition", async () => {
    const submissionRow = makeChain({ first: baseSubmissionRow() })
    const apiChain = makeChain({ first: null })
    const obligationChain = makeChain({ first: null })
    const attemptsChain = makeChain({ select: [] })
    const activityChain = makeChain({ select: [], first: null })
    const logsChain = makeChain({ select: [] })
    const historyChain = makeChain({ first: null })
    const usersChain = makeChain({ select: [] })

    vi.mocked(db).mockImplementation(((table: string) => {
      if (table === 'nivaro_erp_submissions') return submissionRow
      if (table === 'nivaro_external_apis') return apiChain
      if (table === 'nivaro_integration_obligations') return obligationChain
      if (table === 'nivaro_erp_submission_attempts') return attemptsChain
      if (table === 'nivaro_activity') return activityChain
      if (table === 'nivaro_external_api_logs') return logsChain
      if (table === 'nivaro_workflow_history as h') return historyChain
      if (table === 'nivaro_users') return usersChain
      throw new Error(`unexpected table: ${table}`)
    }) as never)
    ;(db as unknown as { raw: ReturnType<typeof vi.fn> }).raw = vi.fn().mockResolvedValue([])

    await gatherSubmissionFacts(82)

    for (const call of historyChain.where.mock.calls) {
      expect(call[0]).not.toBe('h.transition')
    }
  })

  it('record-edit query: windows −3s / +1s', async () => {
    const submissionRow = makeChain({ first: baseSubmissionRow() })
    const apiChain = makeChain({ first: null })
    const obligationChain = makeChain({ first: null })
    const attemptsChain = makeChain({ select: [] })
    const activityChain = makeChain({ select: [], first: null })
    const logsChain = makeChain({ select: [] })
    const historyChain = makeChain({ first: null })
    const usersChain = makeChain({ select: [] })

    vi.mocked(db).mockImplementation(((table: string) => {
      if (table === 'nivaro_erp_submissions') return submissionRow
      if (table === 'nivaro_external_apis') return apiChain
      if (table === 'nivaro_integration_obligations') return obligationChain
      if (table === 'nivaro_erp_submission_attempts') return attemptsChain
      if (table === 'nivaro_activity') return activityChain
      if (table === 'nivaro_external_api_logs') return logsChain
      if (table === 'nivaro_workflow_history as h') return historyChain
      if (table === 'nivaro_users') return usersChain
      throw new Error(`unexpected table: ${table}`)
    }) as never)
    ;(db as unknown as { raw: ReturnType<typeof vi.fn> }).raw = vi.fn().mockResolvedValue([])

    await gatherSubmissionFacts(82)

    // The record-edit query is the ONLY .whereBetween call this test's
    // 'nivaro_activity' chain sees (the Promise.all activity fetch's own
    // nested .where(callback) never invokes .whereBetween on THIS chain
    // directly — the mock ignores the callback body).
    const bounds = activityChain.whereBetween.mock.calls[0][1] as [Date, Date]
    expect(bounds[0].getTime()).toBe(CREATED.getTime() - 3_000)
    expect(bounds[1].getTime()).toBe(CREATED.getTime() + 1_000)
  })
})
