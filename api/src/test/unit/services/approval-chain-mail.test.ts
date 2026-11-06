import { describe, expect, it, vi } from 'vitest'

// Army 5 b13-N3 (cancel mail: ✓ by the canceller, later steps "skipped") and
// b13-N5 (suspended / fallback people in the approval-path block).

const env = vi.hoisted(() => ({
  chain: null as unknown,
  users: [] as Array<Record<string, unknown>>,
  stalled: new Set<string>()
}))

vi.mock('../../../db/index.js', () => ({
  db: (table: string) => {
    const q: any = {
      where: () => q,
      whereIn: () => q,
      select: async () => (table === 'nivaro_users' ? env.users : []),
      first: async () =>
        table === 'nivaro_workflow_instances'
          ? { id: 'I-1', collection: 'workflows', item: '372962', current_state: 'CAN' }
          : undefined
    }
    return q
  }
}))
vi.mock('../../../services/pipeline-chain.js', () => ({
  computeStateChain: async () => env.chain
}))
vi.mock('../../../services/owner-gap-notice.js', () => ({
  stalledStates: async () => env.stalled
}))
const KIM = { id: 'U-KIM', first_name: 'Kim', last_name: 'Lee', email: 'k@x' }
const JOE = { id: 'U-JOE', first_name: 'Joseph', last_name: 'Paolillo', email: 'j@x' }
const REQ = { id: 'U-REQ', first_name: 'Peter', last_name: 'Moniz', email: 'p@x' }
vi.mock('../../../services/pipeline-engine.js', () => ({
  // assigned owners only: the requester fallback is not returned with skipFallback
  resolveStateOwnersBatch: async (reqs: Array<{ key: string }>, _db: unknown, o: any) =>
    new Map(reqs.map((r) => [r.key, o?.skipFallback ? [KIM, JOE] : [KIM, JOE, REQ]])),
  activeOwnersOnly: async (owners: Array<{ id: string }>) => owners.filter((x) => x.id !== JOE.id)
}))

import { buildApprovalChain, chainStepStatus } from '../../../services/approval-chain.js'
import { renderMailTemplate } from '../../../services/mail.js'

const st = (id: string, key: string, sort: number, extra: Record<string, unknown> = {}) => ({
  id,
  key,
  label: key,
  sort,
  template: 'T',
  ...extra
})
const entry = { owners: [KIM, JOE, REQ], skipped: false, skip_reasons: [], on_path: true }

describe('chainStepStatus', () => {
  const base = {
    isCurrent: false,
    sort: 1,
    currentSort: 9,
    reached: false,
    predictedSkip: false,
    cancel: null,
    id: 'X'
  }
  it('keeps the old rules without a cancel', () => {
    expect(chainStepStatus({ ...base, reached: true })).toBe('done')
    expect(chainStepStatus(base)).toBe('skipped')
    expect(chainStepStatus({ ...base, sort: 10 })).toBe('upcoming')
    expect(chainStepStatus({ ...base, isCurrent: true })).toBe('current')
  })
  it('a cancel marks its from-step canceled and what follows not reached', () => {
    const cancel = { fromId: 'L1', fromSort: 2 }
    expect(chainStepStatus({ ...base, id: 'l1', sort: 2, reached: true, cancel })).toBe('canceled')
    expect(chainStepStatus({ ...base, id: 'L2', sort: 3, cancel })).toBe('not_reached')
    expect(chainStepStatus({ ...base, id: 'S', sort: 0, reached: true, cancel })).toBe('done')
  })
})

describe('buildApprovalChain (mail)', () => {
  it('a canceled record: L1 canceled by the canceller, later steps not reached', async () => {
    env.users = [{ id: 'U-LEE', first_name: 'Lee', last_name: 'Herzog', email: 'l@x' }]
    env.chain = {
      currentStateId: 'CAN',
      states: [
        st('S', 'started', 0, { is_initial: true }),
        st('L1', 'waiting_on_l1', 1),
        st('L2', 'waiting_on_l2', 2),
        st('DONE', 'completed', 8, { is_terminal: true }),
        st('CAN', 'canceled', 9, { is_terminal: true })
      ],
      history: [
        { from_state: null, to_state: 'S', timestamp: '2026-11-06T16:00:00Z', user: 'U-K' },
        { from_state: 'S', to_state: 'L1', timestamp: '2026-11-06T16:05:00Z', user: 'U-K' },
        { from_state: 'L1', to_state: 'CAN', timestamp: '2026-11-06T16:40:00Z', user: 'U-LEE' }
      ],
      entries: Object.fromEntries(['S', 'L1', 'L2', 'DONE', 'CAN'].map((k) => [k, entry]))
    }
    const steps = await buildApprovalChain('I-1')
    const by = Object.fromEntries(steps.map((s) => [s.key, s]))
    expect(by.waiting_on_l1).toMatchObject({ status: 'canceled', by: 'Lee Herzog' })
    expect(by.waiting_on_l2.status).toBe('not_reached')
    expect(by.completed.status).toBe('not_reached')
    expect(by.canceled.status).toBe('current')
    expect(by.started.status).toBe('done')
  })

  it('names assigned, active owners only — no requester fallback, no suspended person', async () => {
    env.users = []
    env.stalled = new Set()
    env.chain = {
      currentStateId: 'ER',
      states: [st('S', 'started', 0, { is_initial: true }), st('ER', 'engineering_review', 1)],
      history: [{ from_state: 'S', to_state: 'ER', timestamp: '2026-11-06T16:00:00Z', user: null }],
      entries: { S: entry, ER: entry }
    }
    const steps = await buildApprovalChain('I-1')
    expect(steps.find((s) => s.key === 'engineering_review')?.owners).toEqual(['Kim Lee'])
  })
})

describe('approval-chain partial', () => {
  it('renders canceled, not reached and no approver lines', async () => {
    const html = await renderMailTemplate('workflow_canceled', {
      friendly_id: 'CR26-81411',
      approval_chain: [
        {
          status: 'canceled',
          label: 'Level 1',
          by: 'Lee Herzog',
          at: '2026-11-06T16:40:00Z',
          owners: []
        },
        { status: 'not_reached', label: 'Level 2', owners: [] },
        { status: 'current', label: 'Engineering Review', owners: [], no_approver: true }
      ]
    })
    expect(html).toContain('canceled by Lee Herzog')
    expect(html).toContain('not reached')
    expect(html).toContain('no approver is set for this step yet, an administrator has been told')
    expect(html).not.toContain('&#10003;')
  })
})
