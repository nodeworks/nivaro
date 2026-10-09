// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createActivityTracker, isTypingTarget } from './activity'

describe('createActivityTracker', () => {
  it('logs an idle stretch when nothing happened for 3 s', () => {
    const t = createActivityTracker()
    t.input(500)
    t.input(1000)
    t.input(5000)
    t.input(5100)
    expect(t.spans(6000)).toEqual([{ kind: 'idle', start_ms: 1000, end_ms: 5000 }])
  })
  it('counts the start and the end of the recording', () => {
    const t = createActivityTracker()
    t.input(4000)
    expect(t.spans(9000)).toEqual([
      { kind: 'idle', start_ms: 0, end_ms: 4000 },
      { kind: 'idle', start_ms: 4000, end_ms: 9000 }
    ])
  })
  it('joins keystrokes into typing stretches and splits on a long gap', () => {
    const t = createActivityTracker()
    for (let ms = 1000; ms <= 3000; ms += 250) t.key(ms, true)
    t.input(3500)
    // Next word after a pause longer than the gap.
    for (let ms = 5500; ms <= 7000; ms += 300) t.key(ms, true)
    t.input(7200)
    expect(t.spans(7300)).toEqual([
      { kind: 'typing', start_ms: 1000, end_ms: 3400 },
      { kind: 'typing', start_ms: 5500, end_ms: 7300 }
    ])
  })
  it('a key or two is not typing; keys elsewhere only keep it from being idle', () => {
    const t = createActivityTracker()
    t.key(1000, true)
    t.input(1500)
    t.key(2500, false)
    t.key(4000, false)
    expect(t.spans(4500)).toEqual([])
  })
  it('spans() can be read twice and leaves the tracker as it was', () => {
    const t = createActivityTracker()
    t.key(1000, true)
    t.key(2000, true)
    const a = t.spans(2500)
    expect(t.spans(2500)).toEqual(a)
    expect(a).toEqual([{ kind: 'typing', start_ms: 1000, end_ms: 2400 }])
  })
})

describe('isTypingTarget', () => {
  it('knows text fields and skips masked areas and other controls', () => {
    document.body.innerHTML = `
      <input id="a" type="text"><input id="b" type="checkbox"><textarea id="c"></textarea>
      <div class="nvr-no-record"><input id="d"></div>
      <div data-hv-recorder-bar><input id="e"></div>
      <button id="f">x</button>`
    const el = (id: string) => document.getElementById(id)
    expect(isTypingTarget(el('a'))).toBe(true)
    expect(isTypingTarget(el('b'))).toBe(false)
    expect(isTypingTarget(el('c'))).toBe(true)
    expect(isTypingTarget(el('d'))).toBe(false)
    expect(isTypingTarget(el('e'))).toBe(false)
    expect(isTypingTarget(el('f'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget(window)).toBe(false)
  })
})
