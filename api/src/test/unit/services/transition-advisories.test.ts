import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => {
    const c: Record<string, unknown> = {}
    c.where = vi.fn((w: { id: string }) => {
      c.id = w.id
      return c
    })
    c.first = vi.fn(async () => ({ key: `key-of-${c.id}` }))
    return c
  })
}))

import { db } from '../../../db/index.js'
import {
  ADVISORY_FLIGHT_MAX_MS,
  ADVISORY_WAIT_MS,
  clearTransitionChecks,
  registeredTransitionRefusal,
  registerTransitionCheck,
  transitionAdvisories
} from '../../../services/transition-checks.js'

const who = { id: 'u1', role: 'r1' }
const MOVES = [
  { id: 't-approve', to_state: 's-next' },
  { id: 't-back', to_state: 's-prev' }
]
const advise = () =>
  transitionAdvisories({
    collection: 'orders',
    item: '1',
    currentState: 's-now',
    transitions: MOVES,
    user: who,
    isAdmin: false
  })
const press = (id: string, to: string) =>
  registeredTransitionRefusal({
    collection: 'orders',
    item: '1',
    transitionId: id,
    fromState: 's-now',
    toState: to,
    user: who,
    isAdmin: false
  })

describe('transition advisories — the gate, asked before the click', () => {
  beforeEach(() => {
    clearTransitionChecks()
    vi.mocked(db).mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('no checks -> nothing, and no database read', async () => {
    expect((await advise()).size).toBe(0)
    expect(db).not.toHaveBeenCalled()
  })

  it('says for each move on offer exactly what the gate would answer', async () => {
    registerTransitionCheck('ext', async (a) =>
      a.toState === 'key-of-s-next'
        ? {
            status: 422,
            code: 'BUDGET_SPENT',
            error: 'Only flagged records can move on.',
            fix: { action: 'flag', label: 'Flag it' }
          }
        : null
    )
    const advisories = await advise()
    expect([...advisories.keys()]).toEqual(['t-approve'])
    const advisory = advisories.get('t-approve')
    const refusal = await press('t-approve', 's-next')
    // One evaluator: the notice and the refusal carry the same code, words and fix.
    expect(advisory).toEqual({
      code: 'BUDGET_SPENT',
      message: 'Only flagged records can move on.',
      fix: { action: 'flag', label: 'Flag it' }
    })
    expect(refusal).toEqual({
      status: 422,
      body: {
        error: advisory?.message,
        code: advisory?.code,
        fix: { action: 'flag', label: 'Flag it' }
      }
    })
    // The move the gate lets through carries no advisory.
    expect(await press('t-back', 's-prev')).toBeNull()
  })

  it('hands the checks the same arguments the gate does', async () => {
    const fn = vi.fn(async () => null)
    registerTransitionCheck('ext', fn)
    await advise()
    const asked = fn.mock.calls.map((c) => (c as unknown[])[0])
    fn.mockClear()
    await press('t-approve', 's-next')
    await press('t-back', 's-prev')
    expect(asked).toEqual(fn.mock.calls.map((c) => (c as unknown[])[0]))
  })

  it('a refusal without a fix carries none', async () => {
    registerTransitionCheck('ext', async () => ({ status: 422, code: 'HELD', error: 'On hold.' }))
    expect((await advise()).get('t-approve')).toEqual({ code: 'HELD', message: 'On hold.' })
    expect((await press('t-approve', 's-next'))?.body).toEqual({ error: 'On hold.', code: 'HELD' })
  })

  it('a check that throws gives no advisory (the gate still refuses the move itself)', async () => {
    registerTransitionCheck('boom', async () => {
      throw new Error('x')
    })
    expect((await advise()).size).toBe(0)
    expect((await press('t-approve', 's-next'))?.body.code).toBe('TRANSITION_CHECK_FAILED')
  })

  it('a state lookup failure gives no advisory for that move', async () => {
    registerTransitionCheck('ext', async () => ({ status: 422, code: 'X', error: 'x' }))
    vi.mocked(db).mockImplementationOnce((() => {
      throw new Error('db down')
    }) as never)
    // The first move's lookup failed; the next one is judged as usual.
    expect([...(await advise()).keys()]).toEqual(['t-back'])
  })
})

// The advisories ride the record's pipeline read, which every record page makes and makes
// again on each live update. A check is an extension's code: one that hangs must not hold
// that read, and asks that arrive together must not each run every check again.
describe('transition advisories — a slow or repeated ask', () => {
  const HELD = { status: 422, code: 'HELD', error: 'On hold.' }
  const adviseAs = (user: { id: string; role: string }, item = '1') =>
    transitionAdvisories({
      collection: 'orders',
      item,
      currentState: 's-now',
      transitions: MOVES,
      user,
      isAdmin: false
    })

  beforeEach(() => {
    clearTransitionChecks()
    vi.mocked(db).mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a check that does not answer in time leaves the page quiet instead of holding the read', async () => {
    vi.useFakeTimers()
    registerTransitionCheck('hangs', () => new Promise(() => {}))
    let answer: Map<string, unknown> | null = null
    void advise().then((a) => {
      answer = a
    })
    await vi.advanceTimersByTimeAsync(ADVISORY_WAIT_MS - 1)
    expect(answer).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(answer).not.toBeNull()
    expect((answer as unknown as Map<string, unknown>).size).toBe(0)
  })

  it('a check that answers inside the wait is not cut short', async () => {
    vi.useFakeTimers()
    registerTransitionCheck('slowish', async (a) => {
      await new Promise((r) => setTimeout(r, ADVISORY_WAIT_MS - 100))
      return a.transitionId === 't-approve' ? HELD : null
    })
    const asked = advise()
    await vi.advanceTimersByTimeAsync(ADVISORY_WAIT_MS - 100)
    expect((await asked).get('t-approve')).toEqual({ code: 'HELD', message: 'On hold.' })
  })

  it('asks that arrive while one is running for the same record and person share it', async () => {
    let open!: () => void
    const gate = new Promise<void>((r) => {
      open = r
    })
    const fn = vi.fn(async (a: { transitionId: string }) => {
      await gate
      return a.transitionId === 't-approve' ? HELD : null
    })
    registerTransitionCheck('ext', fn)
    const asks = [advise(), advise(), advise()]
    open()
    const answers = await Promise.all(asks)
    for (const a of answers) expect([...a.keys()]).toEqual(['t-approve'])
    // One run per move on offer, not one per ask.
    expect(fn).toHaveBeenCalledTimes(MOVES.length)
    // Each ask gets a map of its own: one caller changing its answer cannot change another's.
    expect(answers[0]).not.toBe(answers[1])
  })

  it('an ask made after the answer came runs the checks again: nothing is kept', async () => {
    let held = true
    const fn = vi.fn(async (a: { transitionId: string }) =>
      held && a.transitionId === 't-approve' ? HELD : null
    )
    registerTransitionCheck('ext', fn)
    expect((await advise()).size).toBe(1)
    // The person clears the hold (the fix action) and the panel asks again at once.
    held = false
    expect((await advise()).size).toBe(0)
    expect(fn).toHaveBeenCalledTimes(MOVES.length * 2)
  })

  it('another person, or another record, is never answered from someone else’s ask', async () => {
    let open!: () => void
    const gate = new Promise<void>((r) => {
      open = r
    })
    const fn = vi.fn(async (a: { user?: { id?: string }; item: string; transitionId: string }) => {
      await gate
      return a.user?.id === 'u1' && a.item === '1' && a.transitionId === 't-approve' ? HELD : null
    })
    registerTransitionCheck('ext', fn)
    const mine = adviseAs({ id: 'u1', role: 'r1' })
    const theirs = adviseAs({ id: 'u2', role: 'r1' })
    const otherRecord = adviseAs({ id: 'u1', role: 'r1' }, '2')
    open()
    expect((await mine).size).toBe(1)
    expect((await theirs).size).toBe(0)
    expect((await otherRecord).size).toBe(0)
    expect(fn).toHaveBeenCalledTimes(MOVES.length * 3)
  })

  it('asks that follow a hung one join it instead of starting the checks again, until it is given up on', async () => {
    vi.useFakeTimers()
    const fn = vi.fn(() => new Promise<null>(() => {}))
    registerTransitionCheck('hangs', fn)
    const first = advise()
    await vi.advanceTimersByTimeAsync(ADVISORY_WAIT_MS)
    expect((await first).size).toBe(0)
    // The page asks again (a live update): the hung run is still out, so no new one starts.
    const second = advise()
    await vi.advanceTimersByTimeAsync(ADVISORY_WAIT_MS)
    expect((await second).size).toBe(0)
    expect(fn).toHaveBeenCalledTimes(MOVES.length)
    // A run that never ends is forgotten after a while, so the record is not left without
    // advisories for good.
    await vi.advanceTimersByTimeAsync(ADVISORY_FLIGHT_MAX_MS)
    const third = advise()
    await vi.advanceTimersByTimeAsync(ADVISORY_WAIT_MS)
    expect((await third).size).toBe(0)
    expect(fn).toHaveBeenCalledTimes(MOVES.length * 2)
  })
})
