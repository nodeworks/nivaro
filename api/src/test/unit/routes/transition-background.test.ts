import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A transition marked "runs in the background" (`"background": true` on one of
// its actions). The routes run for real here, with the real mutation chain
// (applyTransition); only the partner call (runTransitionActions) and the
// record's run (takeTransitionRun) are stood in for, so each test can say when
// the partner answers and what it says.
//
// What must hold:
//  - without the mark, nothing about a transition changes (same answer, same
//    writes, no run), even when the caller says it can take "it is running";
//  - with the mark, a caller that waits gets the same answer as before;
//  - with the mark and `accept_pending`, the request answers 202 at once and
//    the record moves only if the partner accepted, attributed to the caller.

const APPROVER_ROLE = 'role-approver'
const CALLER = 'user-approver'

vi.mock('../../../services/bulk-actions.js', () => ({ builtinAllowed: vi.fn(async () => true) }))
const auth = vi.hoisted(() => ({
  asCaller: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = {
      id: 'user-approver',
      role: 'role-approver',
      first_name: 'Ada',
      last_name: 'Park'
    }
    req.isAdmin = false
  }
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(auth.asCaller),
  requireAuth: vi.fn(auth.asCaller),
  requireAdmin: vi.fn(auth.asCaller)
}))
vi.mock('../../../middleware/workspace.js', () => ({
  resolveWorkspace: vi.fn(async (req: { workspaceId?: string }) => {
    req.workspaceId = 'ws-1'
  })
}))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
const activity = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }))
vi.mock('../../../services/activity.js', () => ({
  logActivity: vi.fn(async (row: Record<string, unknown>) => {
    activity.rows.push(row)
  })
}))
vi.mock('../../../services/queue-materialization.js', () => ({
  syncMaterializedQueueItem: vi.fn(async () => {})
}))
vi.mock('../../../services/collections.js', () => ({ getCollection: vi.fn(async () => undefined) }))
const dbMock = vi.hoisted(() => ({ db: vi.fn(), tables: [] as string[] }))
vi.mock('../../../db/index.js', () => ({ db: dbMock.db }))
vi.mock('../../../services/branch-instances.js', () => ({
  findRecordInstance: async (collection: string, item: string) =>
    (dbMock.db as unknown as (t: string) => { where: (w: unknown) => { first: () => unknown } })(
      'nivaro_workflow_instances'
    )
      .where({ collection, item })
      .first()
}))
vi.mock('../../../services/instance-guard.js', () => {
  class InstanceAccessError extends Error {
    statusCode = 404
  }
  return {
    InstanceAccessError,
    assertInstanceAccess: vi.fn(async () => {}),
    instanceAccessAllowed: vi.fn(async () => true)
  }
})
vi.mock('../../../services/edit-lock.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/edit-lock.js')>()),
  adminOnlyTransitionsFor: vi.fn(async () => new Set<string>()),
  adminOnlyStatesFor: vi.fn(async () => new Set<string>())
}))

// The double-fire guard: lets every press through unless a test says a twin holds it.
const claim = vi.hoisted(() => ({ taken: 0, released: 0, duplicate: false }))
vi.mock('../../../services/transition-guard.js', async (orig) => {
  const real = await orig<typeof import('../../../services/transition-guard.js')>()
  return {
    ...real,
    claimTransition: vi.fn(async () => {
      if (claim.duplicate)
        throw new real.TransitionDuplicateError(
          { history_id: null, at: null, user: null, user_name: null, seconds_ago: null },
          'Approve'
        )
      claim.taken++
      return {
        release: async () => {
          claim.released++
        }
      }
    })
  }
})

// The automatic-move memory, so a test can see whether a refusal was remembered.
const autoMemory = vi.hoisted(() => ({ failures: 0 }))
vi.mock('../../../services/auto-transition-memory.js', () => ({
  clearAutoFailures: vi.fn(async () => 0),
  autoTransitionHeld: vi.fn(async () => false),
  blockingPayloadHash: vi.fn(async () => 'hash'),
  recordAutoFailure: vi.fn(async () => {
    autoMemory.failures++
  }),
  heldForInstance: vi.fn(async () => [])
}))

// The partner. `answer` is what the blocking push comes back with; a test that
// wants the call still in flight hands in a promise it resolves later.
const partner = vi.hoisted(() => ({
  calls: [] as Array<{ phase: unknown; userId: unknown; background: boolean }>,
  answer: (() => ({ blockedError: null })) as () =>
    | { blockedError: string | null }
    | Promise<{ blockedError: string | null }>
}))
vi.mock('../../../services/workflow-actions.js', async (orig) => {
  const real = await orig<typeof import('../../../services/workflow-actions.js')>()
  const { inBackgroundPool } = await import('../../../db/pool-context.js')
  return {
    ...real,
    runTransitionActions: vi.fn(async (o: { phase?: string; userId: string | null }) => {
      partner.calls.push({ phase: o.phase, userId: o.userId, background: inBackgroundPool() })
      if (o.phase !== 'blocking') return { blockedError: null }
      return { blockedClass: 'validation', ...(await partner.answer()) }
    })
  }
})

// The record's run. The real mark reader and error class; the row itself is a stand-in.
const runs = vi.hoisted(() => ({
  takes: [] as Array<Record<string, unknown>>,
  moved: [] as Array<string | null>,
  refused: [] as unknown[],
  cancelled: 0,
  /** Set to make the take refuse (someone holds the record) or fail to record. */
  held: null as null | Record<string, unknown>,
  unrecordable: false
}))
vi.mock('../../../services/transition-runs.js', async (orig) => {
  const real = await orig<typeof import('../../../services/transition-runs.js')>()
  return {
    ...real,
    takeTransitionRun: vi.fn(async (o: Record<string, unknown>) => {
      runs.takes.push(o)
      if (runs.held) throw new real.TransitionRunningError(runs.held as never)
      if (runs.unrecordable) return null
      const view = {
        id: 71,
        transition_id: 'tx-approve',
        transition_label: 'Approve',
        started_at: '2026-11-12T15:00:00.000Z',
        started_by: 'user-approver',
        started_by_name: 'Ada Park',
        mode: o.mode
      }
      return {
        id: 71,
        view,
        moved: async (label: string | null) => {
          runs.moved.push(label)
        },
        refused: async (err: unknown) => {
          runs.refused.push(err)
        },
        cancel: async () => {
          runs.cancelled++
        }
      }
    })
  }
})

import { itemsRoutes } from '../../../routes/items.js'
import { pipelinesRoutes, stripTransitionActions } from '../../../routes/pipelines.js'
import { BACKGROUND_MOVES_MAX } from '../../../services/record-transition.js'
import { TransitionBlockedError } from '../../../services/workflow-actions.js'
import { runAutoTransitions } from '../../../services/workflow-transitions.js'

const baseInstance = {
  id: 'inst-1',
  template: 'tpl-1',
  collection: 'orders',
  item: '42',
  current_state: 'st-review',
  completed_at: null
}
const targetState = {
  id: 'st-approved',
  template: 'tpl-1',
  key: 'approved',
  label: 'Approved',
  is_initial: false,
  is_terminal: false
}
const PUSH = {
  type: 'erp_submit',
  external_api: 'Partner',
  endpoint_path: '/orders',
  blocking: true
}
const UNMARKED = JSON.stringify([PUSH])
const MARKED = JSON.stringify([{ ...PUSH, background: true }])

function transition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-approve',
    template: 'tpl-1',
    from_state: 'st-review',
    to_state: 'st-approved',
    label: 'Approve',
    auto_trigger: false,
    required_roles: JSON.stringify([APPROVER_ROLE]),
    condition_rules: null,
    requirements: null,
    actions: UNMARKED,
    ...overrides
  }
}

interface Fixture {
  transition?: Record<string, unknown>
  /** What the automatic-move engine finds leaving the record's state. */
  autoCandidates?: Array<Record<string, unknown>>
}
const writes = {
  instanceUpdate: vi.fn(() => Promise.resolve(1)),
  history: [] as Array<Record<string, unknown>>
}

function installDb(fx: Fixture = {}) {
  const tx = fx.transition ?? transition()
  dbMock.db.mockImplementation(((table: string) => {
    dbMock.tables.push(table)
    switch (table) {
      case 'nivaro_workflow_instances':
        return {
          where: vi.fn(() => ({
            first: vi.fn(() => Promise.resolve(baseInstance)),
            update: writes.instanceUpdate
          }))
        }
      case 'nivaro_workflow_transitions':
        return {
          whereIn: vi.fn(() => Promise.resolve([tx])),
          where: vi.fn(() => ({
            first: vi.fn(() => Promise.resolve(tx)),
            where: vi.fn(() => ({
              whereNot: vi.fn(() => ({
                orderBy: vi.fn(() => Promise.resolve(fx.autoCandidates ?? []))
              }))
            }))
          }))
        }
      case 'nivaro_workflow_states':
        return { where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(targetState)) })) }
      case 'nivaro_workflow_history':
        return {
          insert: vi.fn((row: Record<string, unknown>) => {
            writes.history.push(row)
            return Object.assign(Promise.resolve([1]), {
              returning: vi.fn().mockResolvedValue([{ id: 1 }])
            })
          })
        }
      case 'nivaro_workflow_bindings':
        return { where: vi.fn(() => ({ first: vi.fn(() => Promise.resolve(undefined)) })) }
      case 'nivaro_fields':
        return { where: vi.fn(() => ({ select: vi.fn(() => Promise.resolve([])) })) }
      case 'nivaro_notification_subscriptions as ns':
        return {
          join: vi.fn(() => ({
            where: vi.fn(() => ({ select: vi.fn(() => Promise.resolve([])) }))
          }))
        }
      default:
        return {
          where: vi.fn(() => ({
            first: vi.fn(() => Promise.resolve(undefined)),
            limit: vi.fn(() => ({ select: vi.fn(() => Promise.resolve([])) }))
          }))
        }
    }
  }) as never)
}

const pipelinesApp = () => {
  const app = Fastify({ logger: false })
  app.register(pipelinesRoutes, { prefix: '/pipelines' })
  return app
}
const itemsApp = () => {
  const app = Fastify({ logger: false })
  app.register(itemsRoutes, { prefix: '/items' })
  return app
}
const post = (app: ReturnType<typeof pipelinesApp>, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/pipelines/instance/orders/42/transition',
    headers: { 'user-agent': 'record-page/1' },
    payload: { transition_id: 'tx-approve', ...payload }
  })

/** Wait for work the request no longer waits for. */
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`never happened: ${what}`)
}

const moveActivity = () => activity.rows.filter((r) => r.action === 'pipeline-transition')
/** Every background move has written its activity row (the last thing it does). */
const slotsFree = () => moveActivity().length >= BACKGROUND_MOVES_MAX + 1

beforeEach(() => {
  activity.rows.length = 0
  dbMock.tables.length = 0
  claim.taken = 0
  claim.released = 0
  claim.duplicate = false
  autoMemory.failures = 0
  partner.calls.length = 0
  partner.answer = () => ({ blockedError: null })
  runs.takes.length = 0
  runs.moved.length = 0
  runs.refused.length = 0
  runs.cancelled = 0
  runs.held = null
  runs.unrecordable = false
  writes.instanceUpdate.mockClear()
  writes.history.length = 0
})
afterEach(() => {
  vi.clearAllMocks()
})

const REFUSAL = 'HTTP 400: "The project is not valid for this customer"'
const INLINE_REFUSAL = `Approve: submission failed — ${REFUSAL}`
const refuse = () => ({ blockedError: INLINE_REFUSAL })

describe('a transition without the mark is untouched', () => {
  it('answers, writes and attributes exactly as before, and takes no run', async () => {
    installDb()
    const res = await post(pipelinesApp(), {})

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      data: {
        instance: baseInstance,
        new_state: expect.objectContaining({ id: 'st-approved', label: 'Approved' })
      }
    })
    expect(runs.takes).toHaveLength(0)
    expect(dbMock.tables).not.toContain('nivaro_job_runs')
    // The partner was asked before the state moved, on the caller's own pool and in their name.
    expect(partner.calls).toEqual([
      { phase: 'blocking', userId: CALLER, background: false },
      { phase: 'post', userId: CALLER, background: false }
    ])
    expect(writes.instanceUpdate).toHaveBeenCalledTimes(1)
    expect(writes.history).toHaveLength(1)
    expect(writes.history[0]).toMatchObject({ user: CALLER, transition: 'tx-approve' })
    expect(moveActivity()).toHaveLength(1)
    expect(moveActivity()[0]).toMatchObject({ user: CALLER, collection: 'orders', item: '42' })
  })

  it('saying "I can take it is running" changes nothing without the mark', async () => {
    installDb()
    const plain = await post(pipelinesApp(), {})
    const calls = partner.calls.length
    const opted = await post(pipelinesApp(), { accept_pending: true })

    expect(opted.statusCode).toBe(200)
    expect(opted.body).toBe(plain.body)
    expect(runs.takes).toHaveLength(0)
    expect(partner.calls.length).toBe(calls * 2)
    expect(partner.calls.every((c) => c.background === false)).toBe(true)
  })

  it('a refusal by the partner still answers 422 with the same words and moves nothing', async () => {
    installDb()
    partner.answer = refuse
    const res = await post(pipelinesApp(), { accept_pending: true })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({ error: INLINE_REFUSAL })
    expect(writes.instanceUpdate).not.toHaveBeenCalled()
    expect(writes.history).toHaveLength(0)
    expect(claim.released).toBe(1)
    expect(runs.takes).toHaveLength(0)
  })

  it('the instance read marks a transition only when it carries the flag', () => {
    const unmarked = stripTransitionActions({ id: 't', actions: [PUSH] })
    expect(unmarked).toEqual({ id: 't', pushes: 1, order_partners: ['Partner'] })
    expect('background' in unmarked).toBe(false)
    expect(stripTransitionActions({ id: 't', actions: [{ ...PUSH, background: true }] })).toEqual({
      id: 't',
      pushes: 1,
      order_partners: ['Partner'],
      background: true
    })
  })
})

describe('marked, and the caller waits (no accept_pending)', () => {
  it('answers the same 200 as before, holding the record’s run for as long as it takes', async () => {
    installDb({ transition: transition({ actions: MARKED }) })
    const res = await post(pipelinesApp(), {})

    expect(res.statusCode).toBe(200)
    expect(res.json().data.new_state).toMatchObject({ id: 'st-approved' })
    expect(runs.takes).toHaveLength(1)
    expect(runs.takes[0]).toMatchObject({
      mode: 'inline',
      userId: CALLER,
      instance: expect.objectContaining({ id: 'inst-1' }),
      transition: expect.objectContaining({ id: 'tx-approve' })
    })
    expect(runs.moved).toEqual(['Approved'])
    expect(runs.refused).toHaveLength(0)
    expect(partner.calls[0]).toMatchObject({ phase: 'blocking', background: false })
  })

  it('a refusal answers 422 as before; the run keeps the same reason; nothing moves', async () => {
    installDb({ transition: transition({ actions: MARKED }) })
    partner.answer = refuse
    const res = await post(pipelinesApp(), {})

    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({ error: INLINE_REFUSAL })
    expect(writes.instanceUpdate).not.toHaveBeenCalled()
    expect(writes.history).toHaveLength(0)
    expect(runs.moved).toHaveLength(0)
    expect(runs.refused).toHaveLength(1)
    expect(runs.refused[0]).toBeInstanceOf(TransitionBlockedError)
    expect((runs.refused[0] as Error).message).toBe(INLINE_REFUSAL)
    expect(claim.released).toBe(1)
  })

  it('a second run while one holds the record is refused before anything is sent', async () => {
    installDb({ transition: transition({ actions: MARKED }) })
    runs.held = {
      id: 9,
      transition_id: 'tx-approve',
      transition_label: 'Approve',
      started_at: new Date(Date.now() - 20_000).toISOString(),
      started_by: 'user-kim',
      started_by_name: 'Kim Lee',
      mode: 'background'
    }
    const res = await post(pipelinesApp(), { accept_pending: true })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      code: 'TRANSITION_RUNNING',
      error:
        'Approve is already running on this record (started by Kim Lee 20 seconds ago). Wait for it to finish, then check the result.',
      run: { id: 9, started_by_name: 'Kim Lee' }
    })
    expect(partner.calls).toHaveLength(0)
    expect(claim.taken).toBe(0)
    expect(writes.instanceUpdate).not.toHaveBeenCalled()
  })

  it('the bulk route refuses that record with the same sentence and sends nothing', async () => {
    installDb({ transition: transition({ actions: MARKED }) })
    runs.held = {
      id: 9,
      transition_id: 'tx-approve',
      transition_label: 'Approve',
      started_at: new Date(Date.now() - 20_000).toISOString(),
      started_by: 'user-kim',
      started_by_name: 'Kim Lee',
      mode: 'inline'
    }
    const res = await itemsApp().inject({
      method: 'POST',
      url: '/items/orders/bulk-transition',
      payload: { ids: ['42'], transition_id: 'tx-approve' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ succeeded: 0, failed: 1 })
    expect(res.json().errors[0].error).toMatch(/^Approve is already running on this record/)
    expect(partner.calls).toHaveLength(0)
    expect(writes.instanceUpdate).not.toHaveBeenCalled()
    expect(claim.released).toBe(1)
  })

  it('the twin of a press already being applied gives the run back', async () => {
    installDb({ transition: transition({ actions: MARKED }) })
    claim.duplicate = true
    const res = await post(pipelinesApp(), {})
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('TRANSITION_DUPLICATE')
    expect(runs.cancelled).toBe(1)
    expect(partner.calls).toHaveLength(0)
  })
})

describe('marked, and the caller can take "it is running" (accept_pending)', () => {
  it('answers 202 while the partner is still being asked; the record has not moved', async () => {
    installDb({ transition: transition({ actions: MARKED }) })
    let answer: (v: { blockedError: string | null }) => void = () => {}
    partner.answer = () => new Promise((r) => (answer = r))

    const res = await post(pipelinesApp(), { accept_pending: true, comment: 'ok to send' })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({
      data: {
        background: true,
        run: expect.objectContaining({
          id: 71,
          transition_id: 'tx-approve',
          started_by: CALLER,
          mode: 'background'
        })
      }
    })
    expect(runs.takes[0]).toMatchObject({ mode: 'background', userId: CALLER })
    await until(() => partner.calls.length === 1, 'the partner call')
    // The call runs on the background pool, in the caller's name.
    expect(partner.calls[0]).toEqual({ phase: 'blocking', userId: CALLER, background: true })
    expect(writes.instanceUpdate).not.toHaveBeenCalled()
    expect(writes.history).toHaveLength(0)
    expect(runs.moved).toHaveLength(0)

    // The partner accepts: only now does the record move, as the caller's move.
    answer({ blockedError: null })
    await until(() => moveActivity().length === 1, 'the activity row')
    expect(writes.instanceUpdate).toHaveBeenCalledTimes(1)
    expect(writes.history).toHaveLength(1)
    expect(writes.history[0]).toMatchObject({
      user: CALLER,
      transition: 'tx-approve',
      comment: 'ok to send'
    })
    expect(runs.moved).toEqual(['Approved'])
    expect(runs.refused).toHaveLength(0)
    const row = moveActivity()[0]
    expect(row).toMatchObject({ user: CALLER, collection: 'orders', item: '42' })
    expect(String(row.comment)).toContain('via Approve — "ok to send"')
    // The activity row carries the caller's own request (ip, user agent, sign-in).
    expect((row.req as { headers: Record<string, string> }).headers['user-agent']).toBe(
      'record-page/1'
    )
    expect(claim.released).toBe(0)
  })

  it('the partner refuses: the record stays where it was and the run carries the inline message', async () => {
    installDb({ transition: transition({ actions: MARKED }) })
    partner.answer = refuse
    const res = await post(pipelinesApp(), { accept_pending: true })
    expect(res.statusCode).toBe(202)

    await until(() => runs.refused.length === 1, 'the refusal')
    await until(() => claim.released === 1, 'the claim release')
    expect((runs.refused[0] as Error).message).toBe(INLINE_REFUSAL)
    expect(writes.instanceUpdate).not.toHaveBeenCalled()
    expect(writes.history).toHaveLength(0)
    expect(runs.moved).toHaveLength(0)
    expect(moveActivity()).toHaveLength(0)
    // Only the blocking push ran: nothing after a refusal.
    expect(partner.calls.map((c) => c.phase)).toEqual(['blocking'])
  })

  it('every check still answers in the request (a role the caller lacks)', async () => {
    installDb({
      transition: transition({ actions: MARKED, required_roles: JSON.stringify(['role-other']) })
    })
    const res = await post(pipelinesApp(), { accept_pending: true })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'You do not have permission for this transition' })
    expect(runs.takes).toHaveLength(0)
    expect(partner.calls).toHaveLength(0)
  })

  it('a required note still answers 422 in the request', async () => {
    installDb({ transition: transition({ actions: MARKED, comment_mode: 'required' }) })
    const res = await post(pipelinesApp(), { accept_pending: true })
    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('TRANSITION_COMMENT_REQUIRED')
    expect(runs.takes).toHaveLength(0)
  })

  it('past the cap of moves finishing at once, the next caller waits for its own', async () => {
    installDb({ transition: transition({ actions: MARKED }) })
    const waiting: Array<(v: { blockedError: string | null }) => void> = []
    // The first eight partner calls hang; any after them answer at once.
    partner.answer = () =>
      waiting.length < BACKGROUND_MOVES_MAX
        ? new Promise((r) => waiting.push(r))
        : { blockedError: null }
    const app = pipelinesApp()
    for (let i = 0; i < BACKGROUND_MOVES_MAX; i++) {
      expect((await post(app, { accept_pending: true })).statusCode).toBe(202)
    }
    await until(() => waiting.length === BACKGROUND_MOVES_MAX, 'eight calls in flight')

    const ninth = await post(app, { accept_pending: true })
    expect(ninth.statusCode).toBe(200)
    expect(runs.takes[BACKGROUND_MOVES_MAX]).toMatchObject({ mode: 'inline' })
    expect(partner.calls.filter((c) => c.phase === 'blocking' && !c.background)).toHaveLength(1)

    // The eight finish; the slots are given back.
    for (const answer of waiting) answer({ blockedError: null })
    await until(() => runs.moved.length === BACKGROUND_MOVES_MAX + 1, 'every move landed')
    partner.answer = () => ({ blockedError: null })
    await until(slotsFree, 'the slots to free')
    expect((await post(app, { accept_pending: true })).statusCode).toBe(202)
    await until(() => runs.moved.length === BACKGROUND_MOVES_MAX + 2, 'the last move')
  })

  it('when the run cannot be recorded the move is made while the caller waits', async () => {
    installDb({ transition: transition({ actions: MARKED }) })
    runs.unrecordable = true
    const res = await post(pipelinesApp(), { accept_pending: true })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.new_state).toMatchObject({ id: 'st-approved' })
    expect(partner.calls[0]).toMatchObject({ phase: 'blocking', background: false })
    expect(writes.instanceUpdate).toHaveBeenCalledTimes(1)
  })
})

describe('an automatic move that is marked', () => {
  it('waits its turn while a run holds the record: nothing sent, no failure remembered', async () => {
    installDb({
      autoCandidates: [
        transition({ id: 'tx-auto', label: 'Auto-send', auto_trigger: true, actions: MARKED })
      ]
    })
    runs.held = {
      id: 9,
      transition_id: 'tx-approve',
      transition_label: 'Approve',
      started_at: new Date().toISOString(),
      started_by: 'user-kim',
      started_by_name: 'Kim Lee',
      mode: 'background'
    }
    await runAutoTransitions('orders', '42')
    expect(runs.takes).toHaveLength(1)
    expect(runs.takes[0]).toMatchObject({ mode: 'auto', userId: null })
    expect(partner.calls).toHaveLength(0)
    expect(writes.instanceUpdate).not.toHaveBeenCalled()
    expect(autoMemory.failures).toBe(0)
  })
})
