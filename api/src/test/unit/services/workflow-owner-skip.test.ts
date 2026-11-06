import { beforeEach, describe, expect, it, vi } from 'vitest'

// Any query against the fake answers "nothing": chainable, awaitable to undefined.
function nothingDb() {
  const chain: any = new Proxy(() => chain, {
    get: (_t, prop) => {
      if (prop === 'then') return (res: (v: unknown) => void) => res(undefined)
      return () => chain
    },
    apply: () => chain
  })
  return chain
}

const engine = vi.hoisted(() => ({
  resolveStateOwners: vi.fn(),
  activeOwnersOnly: vi.fn(async (o: Array<{ id: string }>) => o),
  nextSkipTransition: vi.fn()
}))

vi.mock('../../../db/index.js', () => ({ db: nothingDb() }))
vi.mock('../../../services/pipeline-engine.js', () => engine)
vi.mock('../../../services/pipeline-subject.js', () => ({
  ADDENDUM_COLLECTION: 'nivaro_addendums',
  addendumLabel: () => '',
  fetchPipelineRecord: async () => ({}),
  loadAddendums: async () => new Map(),
  resolvePipelineSubject: async (collection: string, itemId: string) => ({ collection, itemId })
}))
vi.mock('../../../services/app-links.js', () => ({
  recordLink: async (c: string, i: string) => `https://portal.test/records/${c}/${i}`
}))
vi.mock('../../../services/mail-record-card.js', () => ({ buildRecordCard: async () => null }))
vi.mock('../../../services/approval-chain.js', () => ({ buildApprovalChain: async () => [] }))
vi.mock('../../../services/approval-brief.js', () => ({ buildApprovalBrief: async () => null }))
vi.mock('../../../services/latest-comment.js', () => ({ latestPeopleComment: async () => null }))

import {
  buildTransitionEventPayload,
  type DeferredTransitionEvent,
  evaluateSkipCriteriaDetailed,
  flushChainEvents
} from '../../../services/workflow-transitions.js'

const CREATOR = { id: 'U-CREATOR', email: 'creator@x.test', first_name: 'Mike', last_name: 'James' }
const OWNER = { id: 'U-OWNER', email: 'owner@x.test', first_name: 'Tim', last_name: 'D' }
const SUSPENDED = { id: 'U-GONE', email: 'gone@x.test', first_name: 'Ron', last_name: 'L' }

/** A states table holding one state with skip_if_no_owners on. */
function statesDb(state: Record<string, unknown>) {
  return ((table: string) => ({
    where: () => ({
      first: async () => (table === 'nivaro_workflow_states' ? state : undefined)
    })
  })) as any
}

describe('skip if no owners — the creator fallback is not an owner (army4 a15-1)', () => {
  beforeEach(() => {
    engine.resolveStateOwners.mockReset()
    // The binding's owner fallback (user_created) resolves the creator unless
    // the caller asks for the assigned owners only.
    engine.resolveStateOwners.mockImplementation(
      async (
        _s: string,
        _i: unknown,
        _c: string,
        _it: string,
        _db: unknown,
        opts?: { skipFallback?: boolean }
      ) => (opts?.skipFallback ? [] : [CREATOR])
    )
  })

  it('a step whose only owner is the creator fallback skips', async () => {
    const r = await evaluateSkipCriteriaDetailed(
      'S-FIN',
      {},
      'I-1',
      'inventory_request',
      '37653',
      statesDb({ id: 'S-FIN', skip_if_no_owners: true, skip_criteria: null })
    )
    expect(r.skipped).toBe(true)
    expect(engine.resolveStateOwners.mock.calls[0][5]).toEqual({ skipFallback: true })
  })

  it('the no_owners criterion judges assigned owners only too', async () => {
    const r = await evaluateSkipCriteriaDetailed(
      'S-FIN',
      {},
      'I-1',
      'inventory_request',
      '37653',
      statesDb({
        id: 'S-FIN',
        skip_if_no_owners: false,
        skip_criteria: JSON.stringify({ mode: 'all', conditions: [{ type: 'no_owners' }] })
      })
    )
    expect(r.skipped).toBe(true)
  })

  it('a step with an assigned owner does not skip', async () => {
    engine.resolveStateOwners.mockImplementation(async () => [OWNER])
    const r = await evaluateSkipCriteriaDetailed(
      'S-FIN',
      {},
      'I-1',
      'inventory_request',
      '37653',
      statesDb({ id: 'S-FIN', skip_if_no_owners: true, skip_criteria: null })
    )
    expect(r.skipped).toBe(false)
  })
})

describe('transition payload owners', () => {
  beforeEach(() => {
    engine.resolveStateOwners.mockReset()
    engine.activeOwnersOnly.mockReset()
    // Suspended people are left out of what anyone is told.
    engine.activeOwnersOnly.mockImplementation(async (o: Array<{ id: string }>) =>
      o.filter((x) => x.id !== SUSPENDED.id)
    )
  })

  const base = {
    instance: { id: 'I-1', collection: 'workflows', item: '372936', template: 'T' },
    transitionId: 'TX',
    transitionLabel: 'Cancel Workflow',
    source: 'manual',
    comment: null,
    userId: null,
    enteredPrevAt: null
  }

  it('owners and owner_emails leave suspended people out (army4 a14-4)', async () => {
    engine.resolveStateOwners.mockImplementation(async () => [SUSPENDED, OWNER])
    const p = await buildTransitionEventPayload({
      ...base,
      newStateObj: { id: 'S-L1', key: 'l1', label: 'Level 1', is_terminal: false } as any,
      prevStateObj: null
    })
    expect((p.owners as Array<{ id: string }>).map((o) => o.id)).toEqual([OWNER.id])
    expect(p.owner_emails).toBe('owner@x.test')
    expect(p.previous_owner_emails).toBe('')
    expect(p.final_in_chain).toBe(true)
  })

  it('previous_owner_emails = the FROM state’s assigned, active owners', async () => {
    engine.resolveStateOwners.mockImplementation(
      async (
        stateId: string,
        _i: unknown,
        _c: string,
        _it: string,
        _db: unknown,
        opts?: { skipFallback?: boolean }
      ) => {
        if (stateId === 'S-CANCELED') return []
        // the step it left: two owners (one suspended) + the creator fallback
        return opts?.skipFallback ? [OWNER, SUSPENDED] : [OWNER, SUSPENDED, CREATOR]
      }
    )
    const p = await buildTransitionEventPayload({
      ...base,
      newStateObj: {
        id: 'S-CANCELED',
        key: 'canceled',
        label: 'Canceled',
        is_terminal: true
      } as any,
      prevStateObj: { id: 'S-L1', key: 'l1', label: 'Level 1' }
    })
    expect(p.previous_owner_emails).toBe('owner@x.test')
    expect((p.previous_owners as Array<{ id: string }>).map((o) => o.id)).toEqual([OWNER.id])
    const prevCall = engine.resolveStateOwners.mock.calls.find((c) => c[0] === 'S-L1')
    expect(prevCall?.[5]).toEqual({ skipFallback: true })
  })

  it('a failed previous-owner read never breaks the payload', async () => {
    engine.resolveStateOwners.mockImplementation(async (stateId: string) => {
      if (stateId === 'S-L1') throw new Error('db down')
      return [OWNER]
    })
    const p = await buildTransitionEventPayload({
      ...base,
      newStateObj: { id: 'S-L2', key: 'l2', label: 'Level 2', is_terminal: false } as any,
      prevStateObj: { id: 'S-L1', key: 'l1', label: 'Level 1' }
    })
    expect(p.previous_owner_emails).toBe('')
    expect(p.owner_emails).toBe('owner@x.test')
  })
})

describe('auto chain events (army4 a14-5)', () => {
  it('every hop fires in order; only the last says final_in_chain', () => {
    const fired: string[] = []
    const ev = (key: string): DeferredTransitionEvent => {
      const payload: Record<string, unknown> = {
        to_state: { key, label: key },
        final_in_chain: true
      }
      return { payload, fire: () => fired.push(`${key}:${payload.final_in_chain}`) }
    }
    const events = [ev('order_submission'), ev('completed')]
    const kept = [...events]
    flushChainEvents(events)
    expect(fired).toEqual(['order_submission:false', 'completed:true'])
    for (const e of kept) {
      expect(e.payload.chain_final_state).toEqual({ key: 'completed', label: 'completed' })
      expect(e.payload.chain_length).toBe(2)
    }
    expect(events).toHaveLength(0)
  })

  it('a throwing hop does not stop the rest', () => {
    const fired: string[] = []
    flushChainEvents([
      {
        payload: { to_state: { key: 'a' } },
        fire: () => {
          throw new Error('x')
        }
      },
      { payload: { to_state: { key: 'b' } }, fire: () => fired.push('b') }
    ])
    expect(fired).toEqual(['b'])
  })

  it('nothing collected = nothing fired', () => {
    expect(() => flushChainEvents([])).not.toThrow()
  })
})
