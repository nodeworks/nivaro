import { describe, expect, it, vi } from 'vitest'

// #818 — while a transition is being applied, a transition action's writeback
// onto the record fires the record's after-hooks; the auto-transition hook
// must not re-enter the record mid-transition.

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import {
  applyTransition,
  isTransitionInFlight,
  runAutoTransitions
} from '../../../services/workflow-transitions.js'

describe('records mid-transition', () => {
  it('is in flight while applyTransition runs and released when it settles', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    // The first db read parks until we let it go, then fails — the guard
    // must clear on a rejected transition too.
    vi.mocked(db).mockImplementation((() => {
      const b: Record<string, unknown> = {}
      for (const m of ['where', 'whereIn', 'orderBy', 'select', 'leftJoin', 'join'])
        b[m] = vi.fn(() => b)
      b.first = vi.fn(async () => {
        await gate
        throw new Error('stop here')
      })
      // biome-ignore lint/suspicious/noThenProperty: deliberately thenable
      b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        gate.then(() => Promise.reject(new Error('stop here'))).then(res, rej)
      return b
    }) as never)

    const p = applyTransition({
      instance: {
        id: 'I1',
        collection: 'orders',
        item: 'abc',
        template: 'T1',
        current_state: 'S1'
      } as never,
      transition: { id: 'X1', label: 'Approve', to_state: 'S2' } as never,
      userId: 'KIM'
    })
    expect(isTransitionInFlight('orders', 'ABC')).toBe(true)

    // A hook-driven re-evaluation while in flight touches nothing.
    const calls = vi.mocked(db).mock.calls.length
    await runAutoTransitions('orders', 'abc')
    expect(vi.mocked(db).mock.calls.length).toBe(calls)

    release()
    await p.catch(() => undefined)
    expect(isTransitionInFlight('orders', 'abc')).toBe(false)
  })
})
