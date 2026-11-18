import { beforeEach, describe, expect, it, vi } from 'vitest'

// Naming a record's TARGET step on an update (services/update-state.ts, 2026-11-18):
// which transition it means, who may run it (the manual-move gate, never a copy of
// it), and what the answer says when it cannot.

const m = vi.hoisted(() => ({
  binding: { template: 'T-WF' } as Record<string, unknown> | undefined,
  states: [] as Array<Record<string, unknown>>,
  transitions: [] as Array<Record<string, unknown>>,
  reads: [] as string[],
  instance: undefined as Record<string, unknown> | undefined,
  access: vi.fn(async () => {}),
  gate: vi.fn(),
  run: vi.fn(),
  lock: vi.fn(async () => null as unknown),
  subject: vi.fn(async (c: string, i: string) => ({ collection: c, itemId: i }))
}))

vi.mock('../../../db/index.js', () => {
  const q = (table: string) => {
    m.reads.push(table)
    const self: Record<string, unknown> = {
      where: () => self,
      select: async () =>
        table === 'nivaro_workflow_states'
          ? m.states
          : table === 'nivaro_workflow_transitions'
            ? m.transitions
            : [],
      first: async () => (table === 'nivaro_workflow_bindings' ? m.binding : undefined),
      catch: () => self
    }
    return self
  }
  return { db: q }
})
vi.mock('../../../services/branch-instances.js', () => ({
  findRecordInstance: async () => m.instance
}))
vi.mock('../../../services/instance-guard.js', () => ({ assertInstanceAccess: m.access }))
vi.mock('../../../services/manual-transition-gate.js', () => ({
  manualTransitionRefusal: m.gate
}))
vi.mock('../../../services/pipeline-subject.js', () => ({ resolvePipelineSubject: m.subject }))
vi.mock('../../../services/record-transition.js', () => ({
  runRecordTransition: m.run,
  serverMoveLog: { warn: () => {}, error: () => {} },
  lockActorFor: (o: { req?: unknown }) => o.req ?? null
}))
vi.mock('../../../services/item-lock-guard.js', () => ({ editLockRefusal: m.lock }))

import {
  alreadyThere,
  assertMayMoveByUpdate,
  graphqlStateFor,
  judgeStateMove,
  normalizeStateValue,
  notMovedError,
  orderCandidates,
  planStateMove,
  preWriteTransition,
  runStateMove,
  takeUpdateState,
  UpdateStateRefusal
} from '../../../services/update-state.js'

const user = { id: 'U-LINX', role: 'R-INT' } as never
const S = (id: string, key: string, label: string, sort: number) => ({ id, key, label, sort })
const OPEN = S('S-OPEN', 'open', 'Open', 1)
const MGR = S('S-MGR', 'manager_approval', 'Manager Approval', 2)
const CANCELED = S('S-CAN', 'canceled', 'Canceled', 9)
const T = (o: Record<string, unknown>) => ({
  template: 'T-WF',
  required_roles: null,
  auto_trigger: false,
  sort: 0,
  ...o
})

const plan = (value = 'canceled') =>
  planStateMove({ user, isAdmin: false, collection: 'workflows', item: '373049', value })

beforeEach(() => {
  m.binding = { template: 'T-WF' }
  m.states = [OPEN, MGR, CANCELED]
  m.transitions = []
  m.reads = []
  m.instance = {
    id: 'I-1',
    collection: 'workflows',
    item: '373049',
    template: 'T-WF',
    current_state: 'S-MGR',
    completed_at: null
  }
  m.access.mockReset().mockResolvedValue(undefined)
  m.gate.mockReset().mockResolvedValue(null)
  m.run.mockReset()
  m.lock.mockReset().mockResolvedValue(null)
  m.subject.mockClear()
})

describe('planStateMove', () => {
  it('checks record access first (as a manual move does)', async () => {
    const err = Object.assign(new Error('Record not found'), { statusCode: 404 })
    m.access.mockRejectedValueOnce(err)
    await expect(plan()).rejects.toBe(err)
    expect(m.reads).toEqual([])
  })

  it('an unknown key is a 400 that names it and lists the valid keys', async () => {
    const err = (await plan('cancelled').catch((e) => e)) as UpdateStateRefusal
    expect(err).toBeInstanceOf(UpdateStateRefusal)
    expect(err.statusCode).toBe(400)
    expect(err.code).toBe('STATE_UNKNOWN')
    expect(err.message).toContain('"cancelled"')
    expect(err.message).toContain('open, manager_approval, canceled')
    expect(err.meta).toEqual({ valid_states: ['open', 'manager_approval', 'canceled'] })
  })

  it('a key matches exactly (not case-blind like the column)', async () => {
    const err = (await plan('Canceled').catch((e) => e)) as UpdateStateRefusal
    expect(err.code).toBe('STATE_UNKNOWN')
  })

  it('a step id is accepted', async () => {
    m.states = [OPEN, MGR, { ...CANCELED, id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }]
    m.transitions = [T({ id: 'T-X', from_state: null, to_state: 'x', label: 'Cancel' })]
    const p = await plan('AAAAAAAA-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(p.target.key).toBe('canceled')
  })

  it('the step the record is already in is a no-op: no transition is even looked up', async () => {
    const p = await plan('manager_approval')
    expect(alreadyThere(p)).toMatchObject({ result: 'unchanged', moved: false, already: true })
    expect(p.noop).toBe(true)
    expect(p.candidates).toEqual([])
    expect(m.reads).not.toContain('nivaro_workflow_transitions')
  })

  it('no move from here to there is a 409 NO_TRANSITION naming both steps', async () => {
    m.transitions = [T({ id: 'T-1', from_state: 'S-OPEN', to_state: 'S-CAN', label: 'Cancel' })]
    const err = (await plan().catch((e) => e)) as UpdateStateRefusal
    expect(err.statusCode).toBe(409)
    expect(err.code).toBe('NO_TRANSITION')
    expect(err.message).toBe('No move takes this record from "Manager Approval" to "Canceled".')
    expect(err.current).toBe('manager_approval')
    expect(err.target).toBe('canceled')
  })

  it('a collection without a pipeline is a 400', async () => {
    m.binding = undefined
    const err = (await plan().catch((e) => e)) as UpdateStateRefusal
    expect(err.statusCode).toBe(400)
    expect(err.code).toBe('STATE_NOT_BOUND')
  })

  it('a record whose pipeline has not started is refused, never started here', async () => {
    m.instance = undefined
    const err = (await plan().catch((e) => e)) as UpdateStateRefusal
    expect(err.statusCode).toBe(409)
    expect(err.code).toBe('STATE_NOT_STARTED')
  })
})

describe('which transition the step means', () => {
  it('specific first, and only: a move from the current step shuts out the from-any ones', () => {
    const rows = [
      T({ id: 'any', from_state: null, label: 'Cancel (any)' }),
      T({ id: 'auto', from_state: 'S-MGR', auto_trigger: true, label: 'Auto' }),
      T({ id: 'other', from_state: 'S-OPEN', label: 'From open' }),
      T({ id: 'spec2', from_state: 'S-MGR', sort: 2, label: 'B' }),
      T({ id: 'spec1', from_state: 'S-MGR', sort: 1, label: 'A' }),
      T({ id: 'prev', from_state: 'S-MGR', to_previous: true, label: 'Back' })
    ] as never[]
    // Automatic moves are never candidates (review round 3).
    expect(orderCandidates(rows, 'S-MGR').map((t: { id: string }) => t.id)).toEqual([
      'spec1',
      'spec2'
    ])
  })

  it('from-any moves are used only when no move from the current step exists', () => {
    const rows = [
      T({ id: 'any2', from_state: null, sort: 2, label: 'B' }),
      T({ id: 'any1', from_state: null, sort: 1, label: 'A' }),
      T({ id: 'other', from_state: 'S-OPEN', label: 'From open' })
    ] as never[]
    expect(orderCandidates(rows, 'S-MGR').map((t: { id: string }) => t.id)).toEqual([
      'any1',
      'any2'
    ])
  })

  it('the specific move is used; the from-any one is never even judged', async () => {
    m.transitions = [
      T({ id: 'T-ANY', from_state: null, to_state: 'S-CAN', label: 'Cancel Workflow' }),
      T({ id: 'T-SPEC', from_state: 'S-MGR', to_state: 'S-CAN', label: 'Reject' })
    ]
    const chosen = await judgeStateMove(await plan(), { user, isAdmin: false })
    expect(chosen.id).toBe('T-SPEC')
    expect(m.gate).toHaveBeenCalledTimes(1)
  })

  it('the specific move refused (owner-only): REFUSED with its reason — never routed to "any"', async () => {
    m.transitions = [
      T({ id: 'T-ANY', from_state: null, to_state: 'S-CAN', label: 'Cancel Workflow' }),
      T({ id: 'T-SPEC', from_state: 'S-MGR', to_state: 'S-CAN', label: 'Reject' })
    ]
    m.gate.mockImplementation(async ({ transition }: { transition: { id: string } }) =>
      transition.id === 'T-SPEC'
        ? {
            status: 403,
            body: {
              error: 'Only the owner of Manager Approval can make this move.',
              code: 'TRANSITION_OWNER_REQUIRED'
            }
          }
        : null
    )
    const err = (await judgeStateMove(await plan(), { user, isAdmin: false }).catch(
      (e) => e
    )) as UpdateStateRefusal
    expect(err.statusCode).toBe(403)
    expect(err.code).toBe('TRANSITION_OWNER_REQUIRED')
    expect(err.meta).toMatchObject({ transition: { id: 'T-SPEC', label: 'Reject' } })
    expect(
      m.gate.mock.calls.map((c) => (c[0] as { transition: { id: string } }).transition.id)
    ).toEqual(['T-SPEC'])
  })

  it('several specific moves: the first the caller may run (by sort) wins', async () => {
    m.transitions = [
      T({ id: 'T-B', from_state: 'S-MGR', to_state: 'S-CAN', sort: 2, label: 'B' }),
      T({ id: 'T-A', from_state: 'S-MGR', to_state: 'S-CAN', sort: 1, label: 'A' })
    ]
    m.gate.mockImplementation(async ({ transition }: { transition: { id: string } }) =>
      transition.id === 'T-A' ? { status: 403, body: { error: 'no', code: 'X' } } : null
    )
    expect((await judgeStateMove(await plan(), { user, isAdmin: false })).id).toBe('T-B')
  })

  it("none allowed: the best candidate's own refusal (status, code, words)", async () => {
    m.transitions = [
      T({ id: 'T-ANY', from_state: null, to_state: 'S-CAN', label: 'Cancel Workflow' }),
      T({ id: 'T-SPEC', from_state: 'S-MGR', to_state: 'S-CAN', label: 'Reject' })
    ]
    m.gate.mockImplementation(async ({ transition }: { transition: { id: string } }) =>
      transition.id === 'T-SPEC'
        ? {
            status: 403,
            body: {
              error: 'Only the owner of Manager Approval can make this move.',
              code: 'TRANSITION_OWNER_REQUIRED'
            }
          }
        : { status: 403, body: { error: 'You do not have permission for this transition' } }
    )
    const err = (await judgeStateMove(await plan(), { user, isAdmin: false }).catch(
      (e) => e
    )) as UpdateStateRefusal
    expect(err.statusCode).toBe(403)
    expect(err.code).toBe('TRANSITION_OWNER_REQUIRED')
    expect(err.message).toBe('Only the owner of Manager Approval can make this move.')
    expect(err.meta).toMatchObject({ transition: { id: 'T-SPEC', label: 'Reject' } })
  })

  it('a role refusal without a code gets one', async () => {
    m.transitions = [T({ id: 'T-1', from_state: null, to_state: 'S-CAN', label: 'Cancel' })]
    m.gate.mockResolvedValue({
      status: 403,
      body: { error: 'You do not have permission for this transition' }
    })
    const err = (await judgeStateMove(await plan(), { user, isAdmin: false }).catch(
      (e) => e
    )) as UpdateStateRefusal
    expect(err.code).toBe('TRANSITION_FORBIDDEN')
  })

  it('requirements: 422 TRANSITION_REQUIREMENTS with the blocks and a sentence', async () => {
    m.transitions = [T({ id: 'T-1', from_state: null, to_state: 'S-CAN', label: 'Cancel' })]
    const requirements = [{ type: 'record_fields', title: 'Cancel reason', fields: [] }]
    m.gate.mockResolvedValue({
      status: 422,
      body: { error: 'TRANSITION_REQUIREMENTS', requirements }
    })
    const err = (await judgeStateMove(await plan(), { user, isAdmin: false }).catch(
      (e) => e
    )) as UpdateStateRefusal
    expect(err.statusCode).toBe(422)
    expect(err.code).toBe('TRANSITION_REQUIREMENTS')
    expect(err.requirements).toBe(requirements)
    expect(err.message).toBe(
      'Moving to "Canceled" needs information this record does not have yet: Cancel reason.'
    )
  })

  it('the gate reads the values the update will store (requirements on the NEW values)', async () => {
    m.transitions = [T({ id: 'T-1', from_state: null, to_state: 'S-CAN', label: 'Cancel' })]
    const pending = { cancel_reason: 'Duplicate' }
    const pendingLinks = { zones: { add: [3], remove: [], set: false } }
    await judgeStateMove(await plan(), {
      user,
      isAdmin: false,
      comment: 'per LinX',
      pending,
      pendingLinks
    })
    expect(m.gate).toHaveBeenCalledWith(
      expect.objectContaining({
        user,
        isAdmin: false,
        collection: 'workflows',
        item: '373049',
        comment: 'per LinX',
        pending,
        pendingLinks
      })
    )
  })

  it("an addendum's rules read its parent: the update's own values are not laid over it", async () => {
    m.transitions = [T({ id: 'T-1', from_state: null, to_state: 'S-CAN', label: 'Cancel' })]
    m.subject.mockResolvedValueOnce({ collection: 'workflows_parent', itemId: '9' })
    await judgeStateMove(await plan(), { user, isAdmin: false, pending: { x: 1 } })
    expect(m.gate.mock.calls[0][0]).not.toHaveProperty('pending')
  })

  it("someone else's live edit lock refuses before anything is written", async () => {
    m.transitions = [T({ id: 'T-1', from_state: null, to_state: 'S-CAN', label: 'Cancel' })]
    m.lock.mockResolvedValue({
      status: 409,
      body: { error: 'Bernard is editing', code: 'RECORD_LOCKED', locked_by_name: 'Bernard' }
    })
    const err = (await judgeStateMove(await plan(), {
      user,
      isAdmin: false,
      req: { user, authMethod: 'session' } as never
    }).catch((e) => e)) as UpdateStateRefusal
    expect(err.statusCode).toBe(409)
    expect(err.code).toBe('RECORD_LOCKED')
    expect(m.gate).not.toHaveBeenCalled()
  })
})

describe('runStateMove', () => {
  const chosen = T({ id: 'T-1', from_state: null, to_state: 'S-CAN', label: 'Cancel Workflow' })

  it('runs the chosen transition through the manual-move path', async () => {
    m.transitions = [chosen]
    m.run.mockResolvedValue({
      status: 200,
      body: { data: { new_state: { key: 'canceled', label: 'Canceled' } } }
    })
    const out = await runStateMove(await plan(), chosen as never, {
      user,
      isAdmin: false,
      comment: 'per LinX'
    })
    expect(m.run).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'workflows',
        item: '373049',
        transitionId: 'T-1',
        comment: 'per LinX'
      })
    )
    expect(out).toMatchObject({
      result: 'moved',
      moved: true,
      from: { key: 'manager_approval' },
      to: { key: 'canceled', label: 'Canceled' },
      transition: { id: 'T-1', label: 'Cancel Workflow' }
    })
  })

  it('a move refused after the fields were saved says so — never throws', async () => {
    m.transitions = [chosen]
    m.run.mockResolvedValue({ status: 422, body: { error: 'Fusion refused the cancel' } })
    const out = await runStateMove(await plan(), chosen as never, { user, isAdmin: false })
    expect(out.result).toBe('refused_after_write')
    expect(out.reason).toBe('Fusion refused the cancel')
    expect(out.moved).toBe(false)
    expect(out.fields_saved).toBe(true)
    expect(out.status).toBe(422)
    expect(out.error).toBe(
      'Cancel Workflow did not go through. The record was not moved (your other changes were saved): Fusion refused the cancel'
    )
  })
})

describe('reading the step off a payload', () => {
  it('takes $state and $state_comment off the payload', () => {
    const p: Record<string, unknown> = { name: 'x', $state: ' canceled ', $state_comment: 'dup' }
    expect(takeUpdateState(p)).toEqual({ value: 'canceled', comment: 'dup' })
    expect(p).toEqual({ name: 'x' })
  })

  it('the READ shape of $state echoed back is never a move', () => {
    expect(normalizeStateValue({ key: 'open', label: 'Open' })).toBeNull()
  })

  it('a value that is not a key is refused', () => {
    expect(() => normalizeStateValue(true)).toThrow(UpdateStateRefusal)
    expect(() => normalizeStateValue('x'.repeat(101))).toThrow(/key of a step/)
  })
})

describe('graphqlStateFor (GraphQL `state` arg and data._state)', () => {
  it('data._state is the step on a bound collection, and is taken off the data', async () => {
    const data: Record<string, unknown> = { name: 'x', _state: 'canceled' }
    expect(
      await graphqlStateFor({ collection: 'workflows', data, arg: undefined, ownStateField: false })
    ).toBe('canceled')
    expect(data).toEqual({ name: 'x' })
  })

  it('a collection with its own _state field keeps it as a field', async () => {
    const data: Record<string, unknown> = { _state: 'x' }
    expect(
      await graphqlStateFor({ collection: 'workflows', data, arg: undefined, ownStateField: true })
    ).toBeNull()
    expect(data).toEqual({ _state: 'x' })
  })

  it('an unbound collection: _state stays what it was (ignored)', async () => {
    m.binding = undefined
    const data: Record<string, unknown> = { _state: 'x' }
    expect(
      await graphqlStateFor({ collection: 'notes', data, arg: undefined, ownStateField: false })
    ).toBeNull()
  })

  it('both given and different → 400 STATE_CONFLICT; the same → fine', async () => {
    const err = (await graphqlStateFor({
      collection: 'workflows',
      data: { _state: 'open' },
      arg: 'canceled',
      ownStateField: false
    }).catch((e) => e)) as UpdateStateRefusal
    expect(err.statusCode).toBe(400)
    expect(err.code).toBe('STATE_CONFLICT')
    expect(
      await graphqlStateFor({
        collection: 'workflows',
        data: { _state: 'canceled' },
        arg: 'canceled',
        ownStateField: false
      })
    ).toBe('canceled')
  })
})

describe('runStateMove when the move itself breaks', () => {
  it('is reported (fields saved), never thrown as a bare 500', async () => {
    const chosen = T({ id: 'T-1', from_state: null, to_state: 'S-CAN', label: 'Cancel' })
    m.transitions = [chosen]
    m.run.mockRejectedValue(new Error('socket hang up'))
    const log = { error: vi.fn(), warn: vi.fn() } as never
    const out = await runStateMove(await plan(), chosen as never, { user, isAdmin: false, log })
    expect(out).toMatchObject({ moved: false, status: 500, code: 'TRANSITION_FAILED' })
    expect(out.error).toContain('The move ran into a problem.')
  })
})

describe('review round 3', () => {
  it('an automatic step→target move never shuts out a manual any→target move', () => {
    const rows = [
      T({ id: 'auto', from_state: 'S-MGR', auto_trigger: true, label: 'Auto cancel' }),
      T({ id: 'any', from_state: null, label: 'Cancel Workflow' })
    ] as never[]
    expect(orderCandidates(rows, 'S-MGR').map((t: { id: string }) => t.id)).toEqual(['any'])
  })

  it('before the write, child_fields requirements and dotted conditions wait', () => {
    const t = T({
      id: 'T',
      from_state: 'S-MGR',
      label: 'Submit',
      requirements: JSON.stringify([
        { type: 'record_fields', fields: ['reason'] },
        { type: 'child_fields', collection: 'lines', fk_field: 'wf', fields: ['qty'] }
      ]),
      condition_rules: JSON.stringify({ all: [{ field: 'project.status', op: 'eq', value: 'x' }] })
    })
    const pre = preWriteTransition(t as never, false) as Record<string, unknown>
    expect(JSON.parse(String(pre.requirements))).toEqual([
      { type: 'record_fields', fields: ['reason'] }
    ])
    expect(pre.condition_rules).toBeNull()
    // Plain conditions stay — unless the request writes child rows too.
    const plain = {
      ...t,
      condition_rules: JSON.stringify({ all: [{ field: 'amount', op: 'gt', value: 1 }] })
    }
    expect(
      (preWriteTransition(plain as never, false) as Record<string, unknown>).condition_rules
    ).toBe(plain.condition_rules)
    expect(
      (preWriteTransition(plain as never, true) as Record<string, unknown>).condition_rules
    ).toBeNull()
    // Only child_fields entries: no requirements left at all.
    const onlyChild = {
      ...t,
      condition_rules: null,
      requirements: JSON.stringify([
        { type: 'child_fields', collection: 'l', fk_field: 'w', fields: ['q'] }
      ])
    }
    expect(
      (preWriteTransition(onlyChild as never, false) as Record<string, unknown>).requirements
    ).toBeNull()
  })

  it('a connected app without the transition tool may not move by update (403)', () => {
    expect(() =>
      assertMayMoveByUpdate({ mcpScope: { tools: ['read_item', 'update_item'] } } as never)
    ).toThrow(/tools do not include transition/)
    try {
      assertMayMoveByUpdate({ mcpScope: { tools: ['update_item'] } } as never)
    } catch (e) {
      expect((e as UpdateStateRefusal).statusCode).toBe(403)
      expect((e as UpdateStateRefusal).code).toBe('MCP_TOOL_NOT_ALLOWED')
    }
    expect(() =>
      assertMayMoveByUpdate({ mcpScope: { tools: ['update_item', 'transition'] } } as never)
    ).not.toThrow()
    expect(() => assertMayMoveByUpdate({ mcpScope: { tools: null } } as never)).not.toThrow()
    expect(() => assertMayMoveByUpdate(undefined)).not.toThrow()
  })

  it('a move refused after the write, restored by a batch: the error does not say the fields stay', () => {
    const err = notMovedError(
      {
        result: 'refused_after_write',
        moved: false,
        target: { key: 'canceled', label: 'Canceled' },
        transition: { id: 'T', label: 'Cancel Workflow' },
        reason: 'Fusion refused',
        status: 422,
        fields_saved: true,
        error:
          'Cancel Workflow did not go through. The record was not moved (your other changes were saved): Fusion refused'
      },
      { fieldsRestored: true }
    )
    expect(err.message).toBe(
      'Cancel Workflow did not go through. The record was not moved: Fusion refused'
    )
    expect(err.meta).toMatchObject({ fields_saved: false })
  })
})
