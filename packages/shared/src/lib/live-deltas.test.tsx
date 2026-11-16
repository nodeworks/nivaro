// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  advanceBaseline,
  dayKey,
  deltaChip,
  parseCount,
  readBaseline,
  useChangeChip
} from './live-deltas'

const at = (y: number, m: number, d: number, h: number) => new Date(y, m - 1, d, h, 0, 0)

describe('parseCount', () => {
  it('reads whole numbers only', () => {
    expect(parseCount('14')).toBe(14)
    expect(parseCount('1,204')).toBe(1204)
    expect(parseCount('-3')).toBe(-3)
    expect(parseCount('−3')).toBe(-3)
    expect(parseCount('$1,204')).toBeNull()
    expect(parseCount('12%')).toBeNull()
    expect(parseCount('3.5')).toBeNull()
    expect(parseCount('—')).toBeNull()
    expect(parseCount('')).toBeNull()
    expect(parseCount(null)).toBeNull()
  })
})

describe('baseline + chip', () => {
  it('first sight has nothing to compare', () => {
    const b = advanceBaseline(null, 14, at(2026, 11, 14, 8))
    expect(deltaChip(b)).toBeNull()
  })
  it('says how far it moved since this morning', () => {
    let b = advanceBaseline(null, 14, at(2026, 11, 14, 8))
    b = advanceBaseline(b, 17, at(2026, 11, 14, 10))
    expect(deltaChip(b)?.text).toBe('+3 today')
    expect(deltaChip(b)?.phrase).toBe('+3 since this morning')
    b = advanceBaseline(b, 12, at(2026, 11, 14, 11))
    expect(deltaChip(b)?.text).toBe('−2 today')
    b = advanceBaseline(b, 14, at(2026, 11, 14, 11))
    expect(deltaChip(b)).toBeNull()
  })
  it('afternoon first sight reads "earlier today"', () => {
    let b = advanceBaseline(null, 5, at(2026, 11, 14, 14))
    b = advanceBaseline(b, 6, at(2026, 11, 14, 15))
    expect(deltaChip(b)?.phrase).toBe('+1 since earlier today')
  })
  it('a new day compares with where yesterday ended', () => {
    let b = advanceBaseline(null, 14, at(2026, 11, 13, 9))
    b = advanceBaseline(b, 16, at(2026, 11, 13, 17))
    b = advanceBaseline(b, 13, at(2026, 11, 14, 8))
    expect(deltaChip(b)?.text).toBe('−3 vs yesterday')
    // once something moves today, today's own baseline wins
    b = advanceBaseline(b, 15, at(2026, 11, 14, 9))
    expect(deltaChip(b)?.phrase).toBe('+2 since this morning')
  })
  it('an older visit is no yesterday', () => {
    let b = advanceBaseline(null, 14, at(2026, 11, 10, 9))
    b = advanceBaseline(b, 20, at(2026, 11, 14, 9))
    expect(b.prevLast).toBeNull()
    expect(deltaChip(b)).toBeNull()
  })
  it('groups thousands in the chip', () => {
    let b = advanceBaseline(null, 1000, at(2026, 11, 14, 8))
    b = advanceBaseline(b, 2204, at(2026, 11, 14, 9))
    expect(deltaChip(b)?.sign).toBe('+1,204')
  })
  it('dayKey is the local day', () => {
    expect(dayKey(at(2026, 1, 5, 23))).toBe('2026-01-05')
  })
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function renderHook<P, R>(hook: (p: P) => R, opts: { initialProps?: P } = {}) {
  const result: { current: R | undefined } = { current: undefined }
  const host = document.createElement('div')
  const root = createRoot(host)
  function Probe({ p }: { p: P }) {
    result.current = hook(p)
    return null
  }
  const render = (p: P) => act(() => root.render(createElement(Probe, { p })))
  render(opts.initialProps as P)
  return {
    result: result as { current: R },
    rerender: (p: P) => render(p),
    unmount: () => act(() => root.unmount())
  }
}

describe('useChangeChip', () => {
  beforeEach(() => localStorage.clear())
  it('keeps the first value of the day and reports later moves', () => {
    const { result, rerender } = renderHook(({ v }) => useChangeChip('u1:tile', v), {
      initialProps: { v: '14' as string | null }
    })
    expect(result.current).toBeNull()
    rerender({ v: '17' })
    expect(result.current?.delta).toBe(3)
    expect(readBaseline('u1:tile')?.first).toBe(14)
  })
  it('never takes a loading placeholder as the baseline', () => {
    const { result, rerender } = renderHook(({ v }) => useChangeChip('u2:tile', v), {
      initialProps: { v: null as string | null }
    })
    expect(readBaseline('u2:tile')).toBeNull()
    rerender({ v: '9' })
    expect(result.current).toBeNull()
    expect(readBaseline('u2:tile')?.first).toBe(9)
  })
  it('is off when disabled and for non-counts', () => {
    const a = renderHook(() => useChangeChip('u3:tile', '5', false), { initialProps: undefined })
    expect(a.result.current).toBeNull()
    expect(readBaseline('u3:tile')).toBeNull()
    const b = renderHook(() => useChangeChip('u4:tile', '$5'))
    expect(b.result.current).toBeNull()
  })
  it('carries over a reload', () => {
    const first = renderHook(({ v }) => useChangeChip('u5:tile', v), { initialProps: { v: '4' } })
    first.unmount()
    const second = renderHook(() => useChangeChip('u5:tile', '9'))
    expect(second.result.current?.delta).toBe(5)
  })
})
