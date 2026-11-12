import { beforeEach, describe, expect, it, vi } from 'vitest'

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
