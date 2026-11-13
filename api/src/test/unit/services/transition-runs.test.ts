import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The run a background move holds on its record: one nivaro_job_runs row.
// These tests run the real service against an in-memory copy of that table,
// so the state machine (running → moved / refused / interrupted), the second
// run's refusal and the lease are judged on the rows themselves.

type Row = Record<string, unknown>

const store = vi.hoisted(() => ({
  runs: [] as Array<Record<string, unknown>>,
  nextId: 1,
  users: new Map<string, Record<string, unknown>>(),
  /** nivaro_workflow_history rows: {instance, transition, timestamp}. */
  history: [] as Array<Record<string, unknown>>,
  notify: [] as Array<{ userId: string; opts: Record<string, unknown> }>,
  announced: [] as string[],
  failInsert: false,
  /** What erp-unanswered says about the record's newest send without an answer. */
  unanswered: null as null | Record<string, unknown>,
  unansweredAsked: [] as string[]
}))

function query(rows: Row[]) {
  const filters: Array<(r: Row) => boolean> = []
  let order: { col: string; dir: string } | null = null
  let cap = Number.POSITIVE_INFINITY
  const time = (v: unknown) => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime())
  const matched = () => {
    let out = rows.filter((r) => filters.every((f) => f(r)))
    if (order) {
      const { col, dir } = order
      out = [...out].sort((a, b) => (Number(a[col]) - Number(b[col])) * (dir === 'desc' ? -1 : 1))
    }
    return out.slice(0, cap)
  }
  const q = {
    where(a: unknown, op?: unknown, val?: unknown) {
      if (a && typeof a === 'object') {
        for (const [k, v] of Object.entries(a as Row)) filters.push((r) => r[k] === v)
      } else if (op === '<') filters.push((r) => time(r[String(a)]) < time(val))
      else if (op === '>=') filters.push((r) => time(r[String(a)]) >= time(val))
      else filters.push((r) => r[String(a)] === op)
      return q
    },
    whereIn(col: string, vals: unknown[]) {
      filters.push((r) => vals.includes(r[col]))
      return q
    },
    whereNull(col: string) {
      filters.push((r) => r[col] == null)
      return q
    },
    orderBy(col: string, dir = 'asc') {
      order = { col, dir }
      return q
    },
    limit(n: number) {
      cap = n
      return q
    },
    select: async (..._cols: string[]) => matched().map((r) => ({ ...r })),
    first: async (..._cols: string[]) => {
      const r = matched()[0]
      return r ? { ...r } : undefined
    },
    update: async (patch: Row) => {
      const hit = matched()
      for (const r of hit) Object.assign(r, patch)
      return hit.length
    }
  }
  return q
}

vi.mock('../../../db/index.js', () => ({
  db: (table: string) =>
    table === 'nivaro_users'
      ? query([...store.users.values()])
      : table === 'nivaro_workflow_history'
        ? query(store.history)
        : query(store.runs)
}))
vi.mock('../../../services/tenant-rooms.js', () => ({ currentTenantKey: () => '' }))
vi.mock('../../../services/job-runs.js', () => ({
  startJobRun: async (
    kind: string,
    jobId: string,
    opts: { label?: string; triggeredBy?: string | null }
  ) => {
    if (store.failInsert) return { id: null, complete: async () => {}, fail: async () => {} }
    const row: Row = {
      id: store.nextId++,
      kind,
      job_id: jobId,
      label: opts.label ?? null,
      status: 'running',
      started_at: new Date(),
      finished_at: null,
      outcome: null,
      error: null,
      progress: null,
      triggered_by: opts.triggeredBy ?? null
    }
    store.runs.push(row)
    return {
      id: row.id as number,
      progress: () => {},
      log: () => {},
      complete: async (outcome?: string) => {
        Object.assign(row, {
          status: 'completed',
          outcome: outcome ?? null,
          finished_at: new Date()
        })
      },
      fail: async (err: unknown) => {
        Object.assign(row, { status: 'error', error: String(err), finished_at: new Date() })
      }
    }
  }
}))
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => ({}), getIo: () => null }))
vi.mock('../../../services/notification-channels.js', () => ({
  notifyUser: async (_app: unknown, userId: string, opts: Record<string, unknown>) => {
    store.notify.push({ userId, opts })
    return { id: 1 }
  }
}))
vi.mock('../../../services/record-events.js', () => ({
  announceRecordAspect: (collection: string, item: string, aspect: string) => {
    store.announced.push(`${collection}:${item}:${aspect}`)
  }
}))
vi.mock('../../../services/erp-unanswered.js', () => ({
  newestUnansweredSendFor: async (collection: string, item: string) => {
    store.unansweredAsked.push(`${collection}:${item}`)
    return store.unanswered
  }
}))
vi.mock('../../../services/workflow-actions.js', () => ({
  TransitionBlockedError: class TransitionBlockedError extends Error {
    statusCode = 422
    errorClass: string | null = null
  }
}))

import {
  BEAT_MS,
  LEASE_MS,
  leaseExpired,
  runningMessage,
  runsInBackground,
  sweepAbandonedRuns,
  TransitionRunningError,
  takeTransitionRun,
  transitionRunJobId,
  transitionRunState
} from '../../../services/transition-runs.js'
import { TransitionBlockedError } from '../../../services/workflow-actions.js'

const KIM = 'user-kim'
const instance = { id: 'inst-1', collection: 'orders', item: '42' }
const submit = { id: 'tx-submit', label: 'Submit order' }

/** Let work nobody awaits (the sweep a read sets off, its notification) finish. */
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

const take = (over: Partial<Parameters<typeof takeTransitionRun>[0]> = {}) =>
  takeTransitionRun({
    instance,
    transition: submit,
    userId: KIM,
    mode: 'background',
    recordLabel: 'ORD-42',
    ...over
  })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-12T15:00:00Z'))
  store.runs.length = 0
  store.nextId = 1
  store.users.clear()
  store.users.set(KIM, { id: KIM, first_name: 'Kim', last_name: 'Lee', email: 'kim@example.test' })
  store.history.length = 0
  store.unanswered = null
  store.unansweredAsked = []
  store.notify.length = 0
  store.announced.length = 0
  store.failInsert = false
})
afterEach(() => {
  vi.useRealTimers()
})

describe('runsInBackground — the mark on a transition', () => {
  it('is off for a transition without the flag, whatever else its actions say', () => {
    expect(runsInBackground(null)).toBe(false)
    expect(runsInBackground('')).toBe(false)
    expect(runsInBackground('not json')).toBe(false)
    expect(runsInBackground('{"background":true}')).toBe(false)
    expect(runsInBackground(JSON.stringify([{ type: 'erp_submit', blocking: true }]))).toBe(false)
    expect(
      runsInBackground(JSON.stringify([{ type: 'erp_submit', background: false, note: 'x' }]))
    ).toBe(false)
    // The word inside a payload template is not the flag.
    expect(
      runsInBackground(
        JSON.stringify([{ type: 'erp_submit', payload_template: '{"background": true}' }])
      )
    ).toBe(false)
  })

  it('is on when one action carries background: true (stored JSON or parsed)', () => {
    const actions = [
      { type: 'erp_submit', blocking: true, background: true },
      { type: 'erp_submit' }
    ]
    expect(runsInBackground(JSON.stringify(actions))).toBe(true)
    expect(runsInBackground(actions)).toBe(true)
  })
})

describe('a run: running → moved', () => {
  it('holds the record under its instance, names who started it, and shows as running', async () => {
    const run = await take()
    expect(run).not.toBeNull()
    const row = store.runs[0]
    expect(row.kind).toBe('transition')
    expect(row.job_id).toBe(transitionRunJobId('inst-1'))
    expect(row.status).toBe('running')
    // A run its starter does not wait for sits in their Jobs tray.
    expect(row.triggered_by).toBe(KIM)
    expect(row.label).toBe('Submit order · ORD-42')

    const state = await transitionRunState('inst-1')
    expect(state.problem).toBeNull()
    expect(state.running).toMatchObject({
      id: run?.id,
      transition_id: 'tx-submit',
      transition_label: 'Submit order',
      started_by: KIM,
      started_by_name: 'Kim Lee',
      mode: 'background'
    })
    // Open copies of the record hear about it at once.
    expect(store.announced).toContain('orders:42:$state')
  })

  it('moved: the row completes with where the record went, nothing is left to show', async () => {
    const run = await take()
    await run?.moved('Order sent')
    expect(store.runs[0]).toMatchObject({ status: 'completed', outcome: 'Moved to Order sent' })
    expect(await transitionRunState('inst-1')).toEqual({ running: null, problem: null })
    // Nobody is notified of a move: the record itself shows it.
    expect(store.notify).toHaveLength(0)
  })

  it('an inline run holds the same run but stays out of the Jobs tray', async () => {
    await take({ mode: 'inline' })
    expect(store.runs[0].triggered_by).toBeNull()
    expect((await transitionRunState('inst-1')).running).toMatchObject({
      mode: 'inline',
      started_by: KIM
    })
  })
})

describe('a run: running → refused', () => {
  it('keeps the reason an inline run shows and tells the person who did not wait', async () => {
    const run = await take()
    const refusal = new TransitionBlockedError(
      'Submit order: submission failed — HTTP 400: "The project is not valid"'
    )
    await run?.refused(refusal)

    expect(store.runs[0].status).toBe('error')
    const state = await transitionRunState('inst-1')
    expect(state.running).toBeNull()
    expect(state.problem).toMatchObject({
      result: 'refused',
      transition_id: 'tx-submit',
      reason: 'Submit order: submission failed — HTTP 400: "The project is not valid"',
      started_by_name: 'Kim Lee'
    })
    expect(store.notify).toHaveLength(1)
    expect(store.notify[0].userId).toBe(KIM)
    expect(store.notify[0].opts).toMatchObject({
      subject: 'Submit order did not go through: ORD-42',
      message: 'Submit order: submission failed — HTTP 400: "The project is not valid"',
      collection: 'orders',
      item: '42',
      category: 'system',
      always_inbox: true
    })
  })

  it('does not notify someone who waited for the answer (inline)', async () => {
    const run = await take({ mode: 'inline' })
    await run?.refused(new TransitionBlockedError('Submit order: submission failed — no'))
    expect((await transitionRunState('inst-1')).problem?.result).toBe('refused')
    expect(store.notify).toHaveLength(0)
  })

  it('never stores driver text: an unexpected failure gets a plain sentence and claims nothing', async () => {
    const run = await take()
    await run?.refused(new Error("Invalid column name 'x'. SELECT * FROM secrets"))
    const problem = (await transitionRunState('inst-1')).problem
    // Not "refused": nothing is said about whether the record moved.
    expect(problem?.result).toBe('failed')
    expect(problem?.reason).not.toMatch(/SELECT|column/)
    expect(problem?.reason).toMatch(/went wrong/)
    expect(store.notify[0].opts.subject).toBe('Submit order ran into a problem: ORD-42')
  })

  it('a move with nowhere to go (a 4xx written for people) keeps its own sentence', async () => {
    const run = await take()
    await run?.refused(
      Object.assign(new Error('Review has no reviewers for this request.'), { statusCode: 409 })
    )
    expect((await transitionRunState('inst-1')).problem).toMatchObject({
      result: 'refused',
      reason: 'Review has no reviewers for this request.'
    })
  })

  it('hides a refusal from before the record came to the step it is at now', async () => {
    const run = await take()
    await run?.refused(new TransitionBlockedError('no'))
    const later = new Date(Date.now() + 60_000)
    expect((await transitionRunState('inst-1', { since: later })).problem).toBeNull()
    expect(
      (await transitionRunState('inst-1', { since: new Date(Date.now() - 60_000) })).problem
    ).not.toBeNull()
  })

  it('a later run that moved the record leaves no old refusal behind', async () => {
    const first = await take()
    await first?.refused(new TransitionBlockedError('no'))
    const second = await take()
    await second?.moved('Order sent')
    expect(await transitionRunState('inst-1')).toEqual({ running: null, problem: null })
  })
})

describe('a second run is refused while one holds the record', () => {
  it('refuses with who started it and when, and writes no second running row', async () => {
    await take()
    vi.advanceTimersByTime(20_000)
    const err = await take({ userId: 'user-bob', mode: 'inline' }).catch((e) => e)
    expect(err).toBeInstanceOf(TransitionRunningError)
    // Every path that handles a blocked move handles this one.
    expect(err).toBeInstanceOf(TransitionBlockedError)
    expect((err as TransitionRunningError).code).toBe('TRANSITION_RUNNING')
    expect((err as Error).message).toBe(
      'Submit order is already running on this record (started by Kim Lee 20 seconds ago). Wait for it to finish, then check the result.'
    )
    expect(store.runs.filter((r) => r.status === 'running')).toHaveLength(1)
  })

  it('another transition on the same record is refused too: the run is the record’s', async () => {
    await take()
    await expect(
      take({ transition: { id: 'tx-other', label: 'Send to partner' } })
    ).rejects.toBeInstanceOf(TransitionRunningError)
  })

  it('a run on another record is not in the way', async () => {
    await take()
    const other = await take({ instance: { id: 'inst-2', collection: 'orders', item: '43' } })
    expect(other).not.toBeNull()
  })

  it('two takes at the same moment: the older row keeps the record', async () => {
    // A row that landed between this take's look and its own insert: it is
    // the older of the two (id 1; this take's row is id 2).
    store.nextId = 2
    const real = store.runs.push
    let injected = false
    store.runs.push = ((...rows: Row[]) => {
      if (!injected) {
        injected = true
        real.call(store.runs, {
          id: 1,
          kind: 'transition',
          job_id: transitionRunJobId('inst-1'),
          label: 'Submit order · ORD-42',
          status: 'running',
          started_at: new Date(),
          finished_at: null,
          outcome: null,
          error: null,
          progress: JSON.stringify({
            transition_id: 'tx-submit',
            transition_label: 'Submit order',
            by: 'user-bob',
            by_name: 'Bob Ray',
            mode: 'background',
            beat: new Date().toISOString()
          })
        })
      }
      return real.apply(store.runs, rows)
    }) as typeof store.runs.push
    try {
      const err = await take().catch((e) => e)
      expect(err).toBeInstanceOf(TransitionRunningError)
      expect((err as TransitionRunningError).run.started_by_name).toBe('Bob Ray')
    } finally {
      store.runs.push = real
    }
    // The loser's row is closed and never shown as an outcome.
    const mine = store.runs.find((r) => r.id === 2)
    expect(mine).toMatchObject({ status: 'completed', outcome: 'Not started' })
    expect(store.runs.filter((r) => r.status === 'running')).toHaveLength(1)
    expect((await transitionRunState('inst-1')).problem).toBeNull()
  })

  it('after it finished, the record is free again', async () => {
    const run = await take()
    await run?.refused(new TransitionBlockedError('no'))
    expect(await take()).not.toBeNull()
  })

  it('the wording follows who started it', () => {
    const base = {
      id: 1,
      transition_id: 't',
      transition_label: 'Submit order',
      started_at: '2026-11-12T15:00:00.000Z',
      started_by: null,
      started_by_name: null
    }
    const now = new Date('2026-11-12T15:03:00Z').getTime()
    expect(runningMessage({ ...base, mode: 'auto' }, now)).toBe(
      'Submit order is already running on this record (started automatically 3 minutes ago). Wait for it to finish, then check the result.'
    )
    expect(runningMessage({ ...base, mode: 'inline' }, now)).toContain('(started 3 minutes ago)')
  })
})

describe('a run whose process died: the lease', () => {
  it('a live run beats; one that stops beating expires after the lease', async () => {
    await take()
    const row = store.runs[0] as { status: string; started_at: Date; progress: string }
    vi.advanceTimersByTime(BEAT_MS * 3)
    // Still beating: three intervals later it is not stale, however long ago it started.
    vi.advanceTimersByTime(LEASE_MS)
    expect(leaseExpired(row)).toBe(false)
    expect((await transitionRunState('inst-1')).running).not.toBeNull()
  })

  it('a dead process leaves a run that is released: state untouched, starter told, record free', async () => {
    await take()
    // The process is gone: nothing beats any more.
    vi.clearAllTimers()
    vi.advanceTimersByTime(LEASE_MS + 1_000)

    const state = await transitionRunState('inst-1')
    await settle()
    expect(state.running).toBeNull()
    expect(state.problem).toMatchObject({ result: 'interrupted', transition_id: 'tx-submit' })
    expect(state.problem?.reason).toMatch(/stopped before it finished/)
    expect(store.runs[0].status).toBe('interrupted')
    expect(store.notify).toHaveLength(1)
    expect(store.notify[0].userId).toBe(KIM)
    expect(String(store.notify[0].opts.subject)).toBe(
      'Submit order stopped before it finished: ORD-42'
    )

    // Read again (another viewer, another replica): told once, not twice.
    await transitionRunState('inst-1')
    await sweepAbandonedRuns(true)
    expect(store.notify).toHaveLength(1)

    // And the record can be submitted again.
    expect(await take({ userId: 'user-bob' })).not.toBeNull()
  })

  it('a run that stopped while a send got no answer says the partner may already have it', async () => {
    store.unanswered = {
      id: 50,
      started_at: '2026-11-12T14:59:30.000Z',
      stale: true,
      api_id: 5,
      api_name: 'MDSi',
      endpoint_path: '/orders'
    }
    await take()
    vi.clearAllTimers()
    vi.advanceTimersByTime(LEASE_MS + 1_000)
    const state = await transitionRunState('inst-1')
    expect(store.unansweredAsked).toContain('orders:42')
    expect(state.problem).toMatchObject({
      result: 'interrupted',
      unanswered: {
        submission_id: 50,
        api_name: 'MDSi',
        started_at: '2026-11-12T14:59:30.000Z',
        stale: true
      }
    })
  })

  it('a stopped run with nothing unanswered has no such warning', async () => {
    await take()
    vi.clearAllTimers()
    vi.advanceTimersByTime(LEASE_MS + 1_000)
    const state = await transitionRunState('inst-1')
    expect(state.problem?.result).toBe('interrupted')
    expect(state.problem?.unanswered).toBeNull()
  })

  it('a stale run does not refuse the next one: the take releases it first', async () => {
    await take()
    vi.clearAllTimers()
    vi.advanceTimersByTime(LEASE_MS + 1_000)
    const next = await take({ userId: 'user-bob' })
    await settle()
    expect(next).not.toBeNull()
    expect(store.runs[0].status).toBe('interrupted')
    expect(store.runs[1].status).toBe('running')
  })

  it('the sweep closes abandoned runs on records nobody opens, and adopts shutdown-marked ones', async () => {
    await take()
    await take({
      instance: { id: 'inst-2', collection: 'orders', item: '43' },
      recordLabel: 'ORD-43'
    })
    vi.clearAllTimers()
    // The second was marked by the job-run shutdown sweep: interrupted, nobody told.
    Object.assign(store.runs[1], { status: 'interrupted', finished_at: new Date() })
    vi.advanceTimersByTime(LEASE_MS + 1_000)

    expect(await sweepAbandonedRuns(true)).toBe(2)
    expect(store.runs.map((r) => r.status)).toEqual(['interrupted', 'interrupted'])
    expect(store.notify.map((n) => n.opts.subject)).toEqual([
      'Submit order stopped before it finished: ORD-42',
      'Submit order stopped before it finished: ORD-43'
    ])
  })

  it('a run that died AFTER the record moved says so, and never claims it was not moved', async () => {
    await take()
    // The state change reached the history; the process died in what follows it.
    store.history.push({
      id: 1,
      instance: 'inst-1',
      transition: 'tx-submit',
      timestamp: new Date()
    })
    vi.clearAllTimers()
    vi.advanceTimersByTime(LEASE_MS + 1_000)
    await sweepAbandonedRuns(true)
    expect(store.runs[0].status).toBe('interrupted')
    expect(String(store.runs[0].error)).toMatch(/^The record moved, but the run stopped/)
    expect(String(store.notify[0].opts.message)).not.toMatch(/was not moved/)
  })

  it('an automatic run that died tells nobody (nobody started it)', async () => {
    await take({ mode: 'auto', userId: null })
    vi.clearAllTimers()
    vi.advanceTimersByTime(LEASE_MS + 1_000)
    await sweepAbandonedRuns(true)
    expect(store.runs[0].status).toBe('interrupted')
    expect(store.notify).toHaveLength(0)
  })

  it('a run released too early that finishes after all says so', async () => {
    const run = await take()
    // Its beats were lost (a stalled process), a reader released it…
    Object.assign(store.runs[0], {
      progress: JSON.stringify({
        ...JSON.parse(String(store.runs[0].progress)),
        beat: new Date(Date.now() - LEASE_MS - 5_000).toISOString()
      })
    })
    await transitionRunState('inst-1')
    await settle()
    expect(store.runs[0].status).toBe('interrupted')
    // …and then the move landed.
    await run?.moved('Order sent')
    expect(store.runs[0]).toMatchObject({
      status: 'completed',
      outcome: 'Moved to Order sent',
      error: null
    })
    expect(store.notify.map((n) => n.opts.subject)).toEqual([
      'Submit order stopped before it finished: ORD-42',
      'Submit order finished after all: ORD-42'
    ])
  })
})

describe('a run a shutdown marked before it finished', () => {
  it('completes quietly when the move landed after all: nobody was told it stopped', async () => {
    const run = await take()
    // The job-run shutdown sweep: interrupted, no outcome, nobody told.
    Object.assign(store.runs[0], { status: 'interrupted', finished_at: new Date() })
    await run?.moved('Order sent')
    expect(store.runs[0]).toMatchObject({ status: 'completed', outcome: 'Moved to Order sent' })
    expect(store.notify).toHaveLength(0)
  })
})

describe('when the run cannot be recorded', () => {
  it('answers null so the caller runs the move the way it always did', async () => {
    store.failInsert = true
    expect(await take()).toBeNull()
    expect(store.runs).toHaveLength(0)
  })

  it('a bookkeeping error is never the reason a move fails', async () => {
    const broken = store.runs
    // The run table cannot be read at all.
    Object.defineProperty(store, 'runs', {
      configurable: true,
      get() {
        throw new Error('Timeout acquiring a connection')
      }
    })
    try {
      expect(await take()).toBeNull()
    } finally {
      Object.defineProperty(store, 'runs', { configurable: true, writable: true, value: broken })
    }
  })
})
