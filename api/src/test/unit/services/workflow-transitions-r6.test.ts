import { beforeEach, describe, expect, it, vi } from 'vitest'

// Army 6 (2026-11-06): M44 (the requester's own ownerless step), M45 (IR
// cancel tells the approvers), L26 (who/why on the cancel notice), L30
// (creator lane), L66 (why previous owners got the cancel mail).

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
    const q: any = {
      where: (w: Record<string, unknown>) => {
        if (w && typeof w === 'object' && 'id' in w) wanted = String(w.id)
        return q
      },
      whereNot: () => q,
      whereNull: () => q,
      whereNotNull: () => q,
      whereIn: () => q,
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
      then: (res: (v: unknown) => void) => res([])
    }
    return q
  }
  return chain
}

vi.mock('../../../db/index.js', () => ({ db: fakeDb() }))
const gap = vi.hoisted(() => ({
  acts: false,
  requester: null as null | { id: string; name: string; email: string | null; created_at: null }
}))
vi.mock('../../../services/owner-gap-notice.js', () => ({
  creatorActsInState: async () => gap.acts,
  recordRequester: async () => gap.requester,
  retireGapNotices: async () => 0
}))
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
vi.mock('../../../services/workflow-actions.js', () => ({
  runTransitionActions: vi.fn(async () => ({ blockedError: null, blockedClass: null })),
  TransitionBlockedError: class extends Error {}
}))

import {
  buildTransitionEventPayload,
  recipientReasons
} from '../../../services/workflow-transitions.js'

const REQ = { id: 'U-REQ', name: 'Peter Moniz', email: 'peter@x.test', created_at: null }
const ER1 = { id: 'U-ER1', email: 'er1@x.test', first_name: 'Nathan', last_name: 'Huff' }
const ER2 = { id: 'U-ER2', email: 'er2@x.test', first_name: 'Bryan', last_name: 'Meyer' }

const base = {
  instance: { id: 'I-1', collection: 'inventory_request', item: '37806', template: 'T' },
  transitionId: 'TR',
  transitionLabel: 'Approve',
  source: 'manual',
  comment: null as string | null,
  userId: null as string | null,
  enteredPrevAt: null
}
const ER = { id: 'S-ER', key: 'engineering_review', label: 'Engineering Review' } as any
const WS = { id: 'S-WS', key: 'warehouse_submission', label: 'Warehouse Submission' } as any
const CAN = { id: 'S-CAN', key: 'canceled', label: 'Canceled', is_terminal: true } as any

describe("M44: an ownerless step that is the requester's move", () => {
  beforeEach(() => {
    gap.acts = true
    gap.requester = REQ
    engine.resolveStateOwners.mockReset()
    engine.resolveStateOwners.mockImplementation(async () => [])
  })
  it('names the requester as who it waits on, without making them an owner', async () => {
    const p = await buildTransitionEventPayload({ ...base, newStateObj: WS, prevStateObj: ER })
    expect(p.owners).toEqual([])
    expect(p.owner_emails).toBe('')
    expect(p.creator_acts).toBe(true)
    expect(p.waiting_on_emails).toBe('peter@x.test')
    expect(p.requester).toEqual({ name: 'Peter Moniz', email: 'peter@x.test' })
    expect(p.creator_lane).toBe('needs_you')
    expect((p.recipient_reasons as Record<string, string>)['peter@x.test']).toMatch(
      /waiting on you/
    )
    expect(p.cancel_notify_emails).toBe('')
  })
  it('a step nobody owns and the requester cannot move: no waiting-on, FYI lane (L30)', async () => {
    gap.acts = false
    const p = await buildTransitionEventPayload({ ...base, newStateObj: ER, prevStateObj: WS })
    expect(p.creator_acts).toBe(false)
    expect(p.waiting_on_emails).toBe('')
    expect(p.creator_lane).toBe('fyi')
  })
  it("the requester's draft (initial state) is theirs to act on", async () => {
    gap.acts = false
    const p = await buildTransitionEventPayload({
      ...base,
      newStateObj: { id: 'S-0', key: 'started', label: 'Started', is_initial: true } as any,
      prevStateObj: ER
    })
    expect(p.creator_lane).toBe('needs_you')
  })
})

describe('M45 / L26 / L66: a cancel tells who it was waiting on, and why', () => {
  beforeEach(() => {
    gap.acts = false
    gap.requester = REQ
    engine.resolveStateOwners.mockReset()
    // ER (the state it left) has two approvers; Canceled has none
    engine.resolveStateOwners.mockImplementation(async (stateId: string) =>
      stateId === 'S-ER' ? [ER1, ER2] : []
    )
  })
  it('carries the previous owners as cancel recipients with their reason', async () => {
    const p = await buildTransitionEventPayload({
      ...base,
      transitionLabel: 'Cancel Workflow',
      comment: 'Duplicate, not needed',
      newStateObj: CAN,
      prevStateObj: ER
    })
    expect(p.cancel_notify_emails).toBe('er1@x.test,er2@x.test')
    expect(p.waiting_on_emails).toBe('')
    expect(p.recipient_reasons).toEqual({
      'er1@x.test': 'you were an approver on "Engineering Review" for this record',
      'er2@x.test': 'you were an approver on "Engineering Review" for this record'
    })
    expect(p.comment_note).toBe(' Reason: Duplicate, not needed')
    expect(p.actor_display).toBe('The portal')
  })
  it('an ordinary move never mails the previous owners', async () => {
    engine.resolveStateOwners.mockImplementation(async (stateId: string) =>
      stateId === 'S-ER' ? [ER1] : [ER2]
    )
    const p = await buildTransitionEventPayload({ ...base, newStateObj: WS, prevStateObj: ER })
    expect(p.cancel_notify_emails).toBe('')
    expect(Object.keys(p.recipient_reasons as object)).toEqual(['er2@x.test'])
  })
  it('a machine comment is never quoted', async () => {
    const p = await buildTransitionEventPayload({
      ...base,
      comment: 'auto: closed by import',
      newStateObj: CAN,
      prevStateObj: ER
    })
    expect(p.comment_note).toBe('')
  })
})

describe('recipientReasons', () => {
  it('a new-owner reason is never overridden by a previous-owner one', () => {
    expect(
      recipientReasons({
        owners: [{ email: 'A@x' }],
        stateLabel: 'L2',
        requesterEmail: null,
        previousOwners: [{ email: 'a@x' }, { email: 'b@x' }],
        previousLabel: 'L1'
      })
    ).toEqual({
      'a@x': 'you own "L2" for this record',
      'b@x': 'you were an approver on "L1" for this record'
    })
  })
})
