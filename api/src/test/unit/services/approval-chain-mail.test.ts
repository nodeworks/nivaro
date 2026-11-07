import { describe, expect, it, vi } from 'vitest'

// Army 5 b13-N3 (cancel mail: ✓ by the canceller, later steps "skipped") and
// b13-N5 (suspended / fallback people in the approval-path block).

const env = vi.hoisted(() => ({
  chain: null as unknown,
  users: [] as Array<Record<string, unknown>>,
  stalled: new Set<string>(),
  creatorActs: false,
  assigned: null as null | Array<Record<string, unknown>>,
  requester: null as null | {
    id: string
    name: string
    email: string | null
    created_at: string | null
  }
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
  stalledStates: async () => env.stalled,
  creatorActsInState: async () => env.creatorActs,
  recordRequester: async () => env.requester
}))
const KIM = { id: 'U-KIM', first_name: 'Kim', last_name: 'Lee', email: 'k@x' }
const JOE = { id: 'U-JOE', first_name: 'Joseph', last_name: 'Paolillo', email: 'j@x' }
const REQ = { id: 'U-REQ', first_name: 'Peter', last_name: 'Moniz', email: 'p@x' }
vi.mock('../../../services/pipeline-engine.js', () => ({
  // assigned owners only: the requester fallback is not returned with skipFallback
  resolveStateOwnersBatch: async (reqs: Array<{ key: string }>, _db: unknown, o: any) =>
    new Map(
      reqs.map((r) => [r.key, env.assigned ?? (o?.skipFallback ? [KIM, JOE] : [KIM, JOE, REQ])])
    ),
  activeOwnersOnly: async (owners: Array<{ id: string }>) => owners.filter((x) => x.id !== JOE.id)
}))

import {
  buildApprovalChain,
  capOwnerNames,
  chainStepStatus
} from '../../../services/approval-chain.js'
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

describe('buildApprovalChain (army 6)', () => {
  it('N1: an auto-started record names its creator and created date on Started', async () => {
    env.users = []
    env.stalled = new Set()
    env.creatorActs = false
    env.requester = {
      id: 'U-REQ',
      name: 'Peter Moniz',
      email: 'p@x',
      created_at: '2026-11-07T15:00:00.000Z'
    }
    env.chain = {
      currentStateId: 'ER',
      states: [st('S', 'started', 0, { is_initial: true }), st('ER', 'engineering_review', 1)],
      history: [{ from_state: 'S', to_state: 'ER', timestamp: '2026-11-07T15:00:01Z', user: null }],
      entries: { S: entry, ER: entry }
    }
    const steps = await buildApprovalChain('I-1')
    expect(steps.find((s) => s.key === 'started')).toMatchObject({
      status: 'done',
      by: 'Peter Moniz',
      at: '2026-11-07T15:00:01.000Z'
    })
  })

  it('N1: a named starter is kept', async () => {
    env.users = [{ id: 'U-K', first_name: 'Kristina', last_name: 'Davison', email: 'k@x' }]
    env.chain = {
      currentStateId: 'ER',
      states: [st('S', 'started', 0, { is_initial: true }), st('ER', 'engineering_review', 1)],
      history: [
        { from_state: 'S', to_state: 'ER', timestamp: '2026-11-06T16:00:00Z', user: 'U-K' }
      ],
      entries: { S: entry, ER: entry }
    }
    const steps = await buildApprovalChain('I-1')
    expect(steps.find((s) => s.key === 'started')?.by).toBe('Kristina Davison')
  })

  it("M44: an ownerless step that is the requester's move names the requester", async () => {
    env.users = []
    env.stalled = new Set()
    env.creatorActs = true
    env.requester = { id: 'U-REQ', name: 'Peter Moniz', email: 'p@x', created_at: null }
    env.chain = {
      currentStateId: 'WS',
      states: [st('S', 'started', 0, { is_initial: true }), st('WS', 'warehouse_submission', 1)],
      history: [{ from_state: 'S', to_state: 'WS', timestamp: '2026-11-06T16:00:00Z', user: null }],
      entries: { S: entry, WS: { ...entry, owners: [] } }
    }
    env.assigned = [] // nobody assigned
    const steps = await buildApprovalChain('I-1')
    env.assigned = null
    const ws = steps.find((s) => s.key === 'warehouse_submission')
    expect(ws).toMatchObject({ status: 'current', owners: [] })
    expect(ws?.requester).toEqual({ name: 'Peter Moniz', email: 'p@x' })
    expect(ws?.no_approver).toBeUndefined()
    env.creatorActs = false
    env.requester = null
  })
})

describe('army 8 b13: a long owner list ends "+N more"', () => {
  it('capOwnerNames keeps six names and counts the rest', () => {
    const names = Array.from({ length: 15 }, (_, i) => `Person ${i + 1}`)
    expect(capOwnerNames(names)).toEqual({ owners: names.slice(0, 6), more: 9 })
    expect(capOwnerNames(['A', '', 'B'])).toEqual({ owners: ['A', 'B'], more: 0 })
  })

  it('the step names six assigned owners and the rest as a count', async () => {
    env.users = []
    env.stalled = new Set()
    env.assigned = Array.from({ length: 15 }, (_, i) => ({
      id: `U-${i}`,
      first_name: 'Owner',
      last_name: String(i + 1),
      email: `o${i}@x`
    }))
    env.chain = {
      currentStateId: 'WS',
      states: [st('S', 'started', 0, { is_initial: true }), st('WS', 'warehouse_submission', 1)],
      history: [{ from_state: 'S', to_state: 'WS', timestamp: '2026-11-06T16:00:00Z', user: null }],
      entries: { S: entry, WS: entry }
    }
    const steps = await buildApprovalChain('I-1')
    env.assigned = null
    const ws = steps.find((s) => s.key === 'warehouse_submission')
    expect(ws?.owners).toHaveLength(6)
    expect(ws?.more_owners).toBe(9)
    const html = await renderMailTemplate('workflow_transition', {
      friendly_id: 'MM26INV-37439',
      to_state: { label: 'Warehouse Submission' },
      approval_chain: steps,
      owners: [],
      recipient_email: 'o14@x'
    })
    expect(html).toContain('Owner 6 +9 more')
  })
})

describe('approval-chain partial', () => {
  it('M44: "waiting on you (requester)" to the requester, their name to others', async () => {
    const chain = [
      {
        status: 'current',
        label: 'Warehouse Submission',
        owners: [],
        requester: { name: 'Peter Moniz', email: 'peter_moniz@x.test' }
      }
    ]
    const mine = await renderMailTemplate('workflow_transition', {
      friendly_id: 'CM26INV-37423',
      to_state: { label: 'Warehouse Submission' },
      approval_chain: chain,
      creator_acts: true,
      requester: { name: 'Peter Moniz', email: 'peter_moniz@x.test' },
      owners: [],
      recipient_email: 'Peter_Moniz@x.test'
    })
    expect(mine).toContain('(requester)')
    expect(mine).toMatch(/waiting on <strong[^>]*>you<\/strong> \(requester\)/)
    expect(mine).toContain('It is now waiting on <strong>you</strong>')
    const theirs = await renderMailTemplate('workflow_transition', {
      friendly_id: 'CM26INV-37423',
      to_state: { label: 'Warehouse Submission' },
      approval_chain: chain,
      creator_acts: true,
      requester: { name: 'Peter Moniz', email: 'peter_moniz@x.test' },
      owners: [],
      recipient_email: 'admin@x.test'
    })
    expect(theirs).toContain('waiting on Peter Moniz (requester)')
    expect(theirs).toContain('It is now waiting on Peter Moniz, the requester.')
  })

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
