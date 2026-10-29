import { describe, expect, it } from 'vitest'
import {
  onSectionUse,
  RefusalTally,
  reportSectionUse,
  SectionTally,
  StepClock,
  sessionEvent
} from './form-usage-beacon'

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

describe('section use and time to save (#2730 #2614)', () => {
  it('peeks at the running time without starting afresh', () => {
    const c = new StepClock('a', 0)
    c.step('b', 1000)
    expect(c.peek(1500)).toBe(1500)
    expect(c.take(2000).total).toBe(2000)
  })

  it('sends each section once per session, shown before opened', () => {
    const t = new SectionTally()
    t.note('shown', 'a')
    t.note('opened', 'b')
    const p1 = t.pending()
    expect(p1).toEqual({ shown: ['a', 'b'], opened: ['b'] })
    t.markSent(p1)
    t.note('shown', 'a')
    t.note('opened', 'a')
    expect(t.pending()).toEqual({ shown: [], opened: ['a'] })
  })

  it('carries sections and the save time on the event', () => {
    const ev = sessionEvent({
      ...base,
      saved: true,
      elapsed: 5000,
      total: 5000,
      sections: { shown: ['a'], opened: [] },
      saveMs: 4200.4
    })
    expect(ev?.sections).toEqual({ shown: ['a'], opened: [] })
    expect(ev?.save_ms).toBe(4200)
    const quiet = sessionEvent({
      ...base,
      elapsed: 5000,
      total: 5000,
      sections: { shown: [], opened: [] }
    })
    expect(quiet && 'sections' in quiet).toBe(false)
    expect(quiet?.save_ms).toBeUndefined()
  })

  it('replays recent shown sections to a form that subscribes after they mounted', () => {
    reportSectionUse({ layoutId: 99, collection: 'c', kind: 'shown', key: 'early' })
    reportSectionUse({ layoutId: 99, collection: 'c', kind: 'opened', key: 'early' })
    const seen: string[] = []
    const off = onSectionUse((u) => {
      if (u.layoutId === 99) seen.push(`${u.kind}:${u.key}`)
    })
    reportSectionUse({ layoutId: 99, collection: 'c', kind: 'opened', key: 'late' })
    off()
    reportSectionUse({ layoutId: 99, collection: 'c', kind: 'opened', key: 'gone' })
    expect(seen).toEqual(['shown:early', 'opened:late'])
  })
})

describe('refused saves (#3185)', () => {
  it('counts each refusal once and each field once per refusal, by kind', () => {
    const t = new RefusalTally()
    expect(t.take()).toBeNull()
    t.note({ title: 'This field is required', amount: 'Must be at least 1' })
    t.note({ title: 'This field is required', lines: 'At least one Line item is required' })
    t.note({ 'not a field': 'x' })
    t.note({ amount: 'Too big' }, 'invalid')
    expect(t.take()).toEqual({
      tries: 3,
      fields: {
        title: { required: 2, invalid: 0 },
        amount: { required: 0, invalid: 2 },
        lines: { required: 1, invalid: 0 }
      }
    })
    expect(t.take()).toBeNull()
  })

  it('a refusal alone is worth an event; an unsent chunk goes back', () => {
    const refused = { tries: 1, fields: { title: { required: 1, invalid: 0 } } }
    const ev = sessionEvent({ ...base, openSent: true, total: 0, elapsed: 9000, refused })
    expect(ev?.refused).toEqual(refused)
    expect(sessionEvent({ ...base, openSent: true, total: 0, elapsed: 9000 })).toBeNull()
    const t = new RefusalTally()
    t.restore(refused)
    t.note({ title: 'This field is required' })
    expect(t.take()?.fields.title).toEqual({ required: 2, invalid: 0 })
  })
})
