import { beforeEach, describe, expect, it, vi } from 'vitest'

// Army 5 (2026-11-06): mails named the requester (the binding's creator
// fallback) as an approver; a Send Back to a step that skips came straight
// back and still wrote history + mail.

const engine = vi.hoisted(() => ({
  resolveStateOwners: vi.fn(),
  activeOwnersOnly: vi.fn(async (o: Array<{ id: string }>) => o),
  nextSkipTransition: vi.fn()
}))

const tables = vi.hoisted(() => ({
  states: new Map<string, Record<string, unknown>>(),
  inserts: [] as Array<{ table: string; row: unknown }>,
  updates: [] as Array<{ table: string; row: unknown }>
}))

/** A tiny db fake: states by id, everything else answers "nothing", writes recorded. */
function fakeDb() {
  const chain = (table: string): any => {
    let wanted: string | undefined
    let wantedIn: string[] | undefined
    const q: any = {
      where: (w: Record<string, unknown>) => {
        if (w && typeof w === 'object' && 'id' in w) wanted = String(w.id)
        return q
      },
      whereNot: () => q,
      whereNull: () => q,
      whereNotNull: () => q,
      whereIn: (_col: string, ids: unknown[]) => {
        wantedIn = (ids ?? []).map(String)
        return q
      },
      orderBy: () => q,
      limit: () => q,
      select: () => q,
      pluck: () => q,
      first: async () =>
        table === 'nivaro_workflow_states' && wanted ? tables.states.get(wanted) : undefined,
      insert: (row: unknown) => {
        tables.inserts.push({ table, row })
        return { returning: async () => [{ id: 1 }] }
      },
      update: async (row: unknown) => {
        tables.updates.push({ table, row })
        return 1
      },
      // biome-ignore lint/suspicious/noThenProperty: the fake query is awaitable like knex's
      then: (res: (v: unknown) => void) =>
        res(
          table === 'nivaro_workflow_states' && wantedIn
            ? wantedIn.map((id) => tables.states.get(id)).filter(Boolean)
            : []
        )
    }
    return q
  }
  return chain
}

vi.mock('../../../db/index.js', () => ({ db: fakeDb() }))
vi.mock('../../../services/pipeline-engine.js', () => engine)
vi.mock('../../../services/pipeline-subject.js', () => ({
  ADDENDUM_COLLECTION: 'nivaro_addendums',
  addendumLabel: () => '',
  fetchPipelineRecord: async () => ({ requisition_amount: 5000 }),
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
vi.mock('../../../services/workflow-actions.js', () => ({
  runTransitionActions: vi.fn(async () => ({ blockedError: null, blockedClass: null })),
  TransitionBlockedError: class extends Error {}
}))

import {
  applyTransition,
  bouncesBack,
  buildTransitionEventPayload,
  noTargetMessage,
  TransitionNoTargetError
} from '../../../services/workflow-transitions.js'

const CREATOR = { id: 'U-CREATOR', email: 'creator@x.test', first_name: 'Kristina', last_name: 'D' }
const OWNER = { id: 'U-OWNER', email: 'owner@x.test', first_name: 'Nick', last_name: 'D' }

describe('payload owners leave the creator fallback out (b13-N1)', () => {
  beforeEach(() => {
    engine.resolveStateOwners.mockReset()
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

  const base = {
    instance: { id: 'I-1', collection: 'inventory_request', item: '37777', template: 'T' },
    prevStateObj: null,
    transitionId: null,
    transitionLabel: 'Created',
    source: 'start',
    comment: null,
    userId: CREATOR.id,
    enteredPrevAt: null
  }

  it('a step held only by the creator fallback has no owners and no owner emails', async () => {
    const p = await buildTransitionEventPayload({
      ...base,
      newStateObj: { id: 'S-ER', key: 'engineering_review', label: 'Engineering Review' } as any
    })
    expect(p.owners).toEqual([])
    expect(p.owner_emails).toBe('')
    expect(p.recipient_reasons).toEqual({})
    expect(engine.resolveStateOwners.mock.calls[0][5]).toEqual({ skipFallback: true })
  })

  it('assigned owners still come through', async () => {
    engine.resolveStateOwners.mockImplementation(async (_s: string, ...rest: unknown[]) =>
      (rest[4] as { skipFallback?: boolean })?.skipFallback ? [OWNER] : [OWNER, CREATOR]
    )
    const p = await buildTransitionEventPayload({
      ...base,
      newStateObj: { id: 'S-WS', key: 'warehouse_submission', label: 'Warehouse Submission' } as any
    })
    expect(p.owner_emails).toBe('owner@x.test')
  })
})

describe('a manual move that would bounce back is refused (b06-N6 / b13-N4)', () => {
  it('bouncesBack: only a skipped target that resolves to the current state', () => {
    expect(bouncesBack('WS', 'FR', 'WS')).toBe(true)
    expect(bouncesBack('ws', 'FR', 'WS')).toBe(true)
    // a deliberate self-loop
    expect(bouncesBack('WS', 'WS', 'WS')).toBe(false)
    // skipped onward to somewhere else
    expect(bouncesBack('ER', 'FR', 'WS')).toBe(false)
    expect(bouncesBack(null, 'FR', 'WS')).toBe(false)
  })

  it('says why in plain words', () => {
    expect(noTargetMessage('Finance Review', true)).toBe(
      "Finance Review has no reviewers for this request, so it can't be sent there."
    )
    expect(noTargetMessage('Finance Review', false, 'Amount under limit')).toBe(
      "Finance Review is skipped for this request (Amount under limit), so it can't be sent there."
    )
  })

  it('a 409 with a code', () => {
    const e = new TransitionNoTargetError('x')
    expect(e.statusCode).toBe(409)
    expect(e.code).toBe('NO_TARGET_OWNERS')
  })

  it('applyTransition refuses before writing history or moving the instance', async () => {
    tables.states.clear()
    tables.inserts.length = 0
    tables.updates.length = 0
    tables.states.set('WS', {
      id: 'WS',
      template: 'T',
      key: 'warehouse_submission',
      label: 'Warehouse Submission',
      is_initial: false,
      is_terminal: false,
      skip_if_no_owners: false,
      skip_criteria: null
    })
    tables.states.set('FR', {
      id: 'FR',
      template: 'T',
      key: 'finance_review',
      label: 'Finance Review',
      is_initial: false,
      is_terminal: false,
      skip_if_no_owners: true,
      skip_criteria: null
    })
    engine.resolveStateOwners.mockReset()
    engine.resolveStateOwners.mockImplementation(async () => [])
    engine.nextSkipTransition.mockReset()
    engine.nextSkipTransition.mockImplementation(async () => ({ to_state: 'WS' }))

    await expect(
      applyTransition({
        instance: {
          id: 'I-1',
          collection: 'inventory_request',
          item: '37782',
          template: 'T',
          current_state: 'WS'
        } as any,
        transition: { id: 'TX', to_state: 'FR', label: 'Send Back' } as any,
        userId: OWNER.id,
        comment: 'send-back to Finance Review',
        source: 'manual'
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'NO_TARGET_OWNERS',
      message: "Finance Review has no reviewers for this request, so it can't be sent there."
    })
    expect(tables.inserts.filter((i) => i.table === 'nivaro_workflow_history')).toEqual([])
    expect(tables.updates.filter((u) => u.table === 'nivaro_workflow_instances')).toEqual([])
  })

  // Army 9 b06: at Level 5 a $5,000 request offered "Send Back → Level 3"
  // (skipped by threshold). Level 4 is not skipped here, so the engine would
  // have landed it on Level 4 — not a bounce, not what was asked. Refused.
  it('refuses a send back to a step this record skips, even when it would not bounce', async () => {
    tables.states.clear()
    tables.inserts.length = 0
    tables.updates.length = 0
    const base = { template: 'T', is_initial: false, is_terminal: false, skip_if_no_owners: false }
    tables.states.set('L3', {
      ...base,
      id: 'L3',
      key: 'l3',
      label: 'Waiting on Level 3 Approval',
      sort: 4,
      skip_criteria: JSON.stringify({
        mode: 'any',
        conditions: [{ type: 'field_compare', field: 'requisition_amount', op: 'lt', value: 20000 }]
      })
    })
    tables.states.set('L4', {
      ...base,
      id: 'L4',
      key: 'l4',
      label: 'Waiting on Level 4 Approval',
      sort: 5,
      skip_criteria: null
    })
    tables.states.set('L5', {
      ...base,
      id: 'L5',
      key: 'l5',
      label: 'Waiting on Level 5 Approval',
      sort: 6,
      skip_criteria: null
    })
    engine.nextSkipTransition.mockReset()
    engine.nextSkipTransition.mockImplementation(async () => ({ to_state: 'L4' }))

    await expect(
      applyTransition({
        instance: {
          id: 'I-2',
          collection: 'workflows',
          item: '372986',
          template: 'T',
          current_state: 'L5'
        } as any,
        transition: { id: 'TX-L3', to_state: 'L3', label: 'Send Back' } as any,
        userId: OWNER.id,
        comment: 'back to L3',
        source: 'manual'
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'TARGET_SKIPPED',
      message: expect.stringMatching(
        /^Waiting on Level 3 Approval is skipped for this request \(.*is below 20,000\), so it can't be sent there\.$/
      )
    })
    expect(tables.inserts.filter((i) => i.table === 'nivaro_workflow_history')).toEqual([])
    expect(tables.updates.filter((u) => u.table === 'nivaro_workflow_instances')).toEqual([])
  })
})
