import { describe, expect, it } from 'vitest'
import { StepClock, sessionEvent } from './form-usage-beacon'

const base = {
  layoutId: 3,
  collection: 'orders',
  item: null as string | null,
  openSent: false,
  saved: false,
  step: 's1',
  steps: {},
  total: 0,
  elapsed: 0,
  final: true
}

describe('StepClock', () => {
  it('splits visible time by step and stops while hidden', () => {
    const c = new StepClock('a', 0)
    c.step('b', 1000)
    c.pause(3000)
    c.resume(10_000)
    c.step('a', 10_500)
    expect(c.take(11_000)).toEqual({ steps: { a: 1500, b: 2500 }, total: 4000 })
    // take() starts afresh but keeps running on the current step.
    expect(c.take(12_000)).toEqual({ steps: { a: 1000 }, total: 1000 })
  })

  it('starts paused when the page is hidden', () => {
    const c = new StepClock('a', 0, false)
    expect(c.take(5000).total).toBe(0)
  })
})

describe('sessionEvent', () => {
  it('drops a remount blink', () => {
    expect(sessionEvent({ ...base, elapsed: 100, total: 100 })).toBeNull()
  })

  it('counts an abandoned new record on its step, only when the form closed', () => {
    const ev = sessionEvent({ ...base, steps: { s1: 5000 }, total: 5000, elapsed: 5000 })
    expect(ev).toMatchObject({ open: true, abandoned_step: 's1', item: null })
    expect(
      sessionEvent({ ...base, steps: { s1: 5000 }, total: 5000, elapsed: 5000, final: false })
        ?.abandoned_step
    ).toBeNull()
  })

  it('never abandons a saved record or an existing one', () => {
    expect(
      sessionEvent({ ...base, saved: true, total: 5000, elapsed: 5000 })?.abandoned_step
    ).toBeNull()
    expect(
      sessionEvent({ ...base, item: '9', total: 5000, elapsed: 5000 })?.abandoned_step
    ).toBeNull()
  })

  it('a later chunk does not count the open again, and an empty one is not sent', () => {
    expect(sessionEvent({ ...base, openSent: true, total: 2000, elapsed: 9000 })?.open).toBe(false)
    expect(sessionEvent({ ...base, openSent: true, total: 0, elapsed: 9000 })).toBeNull()
  })
})
