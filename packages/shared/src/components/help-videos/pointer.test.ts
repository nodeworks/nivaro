import { describe, expect, it } from 'vitest'
import {
  POINTER_LIMITS,
  pointerAt,
  pointerMoved,
  pointerSample,
  SHORTCUT_BADGE_MS,
  shortcutAt,
  shortcutFromKey,
  shortcutLabel,
  smoothPointerPath,
  thinPointerPath
} from './pointer'

// The pointer path and shortcuts (#1517): the recorder's rules and the
// player's reading of them. Twin of api help-video-cursor.ts — same answers.

const s = (t_ms: number, x: number, y: number) => ({ t_ms, x, y })
const key = (
  k: string,
  mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}
) =>
  shortcutFromKey({
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods
  })

describe('sampling', () => {
  it('pointerSample rounds and keeps the frame', () =>
    expect(pointerSample(12.6, 1.2, 0.123456)).toEqual(s(13, 1, 0.1235)))
  it('pointerMoved: anything but a still pointer', () => {
    expect(pointerMoved(null, { x: 0, y: 0 })).toBe(true)
    expect(pointerMoved({ x: 0.5, y: 0.5 }, { x: 0.5004, y: 0.5 })).toBe(false)
    expect(pointerMoved({ x: 0.5, y: 0.5 }, { x: 0.502, y: 0.5 })).toBe(true)
  })
  it('thinPointerPath keeps at most the cap, evenly, both ends included', () => {
    const many = Array.from({ length: POINTER_LIMITS.samples * 2 + 1 }, (_, i) => s(i, 0, 0))
    const out = thinPointerPath(many)
    expect(out).toHaveLength(POINTER_LIMITS.samples)
    expect(out[0]).toBe(many[0])
    expect(out[out.length - 1]).toBe(many[many.length - 1])
    expect(thinPointerPath(many.slice(0, 5), 3)).toEqual([many[0], many[2], many[4]])
    expect(thinPointerPath(many.slice(0, 3))).toHaveLength(3)
  })
})

describe('pointerAt', () => {
  const path = [s(1000, 0.1, 0.1), s(1050, 0.2, 0.2), s(3000, 0.6, 0.2)]
  it('unseen before the first sample, held after the last', () => {
    expect(pointerAt([], 0)).toBeNull()
    expect(pointerAt(path, 999)).toBeNull()
    expect(pointerAt(path, 1000)).toEqual({ x: 0.1, y: 0.1 })
    expect(pointerAt(path, 60_000)).toEqual({ x: 0.6, y: 0.2 })
  })
  it('a straight line between close samples; a hold then a move across a gap', () => {
    expect(pointerAt(path, 1025)!.x).toBeCloseTo(0.15)
    expect(pointerAt(path, 2000)).toEqual({ x: 0.2, y: 0.2 })
    expect(pointerAt(path, 2900)).toEqual({ x: 0.2, y: 0.2 })
    expect(pointerAt(path, 2950)!.x).toBeCloseTo(0.4)
  })
  it('smoothPointerPath averages close neighbours and keeps times', () => {
    const sm = smoothPointerPath([s(0, 0, 0), s(50, 0.3, 0), s(100, 0.3, 0), s(5000, 0.9, 0)])
    expect(sm.map((p) => p.t_ms)).toEqual([0, 50, 100, 5000])
    expect(sm[1]).toEqual(s(50, 0.2, 0))
    expect(sm[3]).toEqual(s(5000, 0.9, 0))
  })
})

describe('shortcutFromKey', () => {
  it('keeps modifier combos, modifiers first, letters upper-case', () => {
    expect(key('s', { metaKey: true })).toBe('Meta+S')
    expect(key('k', { ctrlKey: true })).toBe('Ctrl+K')
    expect(key('ArrowDown', { ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+ArrowDown')
    expect(key(' ', { altKey: true })).toBe('Alt+Space')
  })
  it('keeps Enter, Escape, Tab, arrows, Home/End, paging and F-keys on their own', () => {
    for (const k of ['Enter', 'Escape', 'Tab', 'ArrowLeft', 'Home', 'PageDown', 'F5'])
      expect(key(k)).toBe(k)
    expect(key('Tab', { shiftKey: true })).toBe('Shift+Tab')
  })
  it('never keeps typing: plain characters, shifted letters, space, modifiers alone', () => {
    expect(key('a')).toBeNull()
    expect(key('A', { shiftKey: true })).toBeNull()
    expect(key(' ')).toBeNull()
    expect(key('Backspace')).toBeNull()
    expect(key('Shift', { shiftKey: true })).toBeNull()
    expect(key('Meta', { metaKey: true })).toBeNull()
    expect(key('Dead', { altKey: true })).toBeNull()
    expect(key('ü', { altKey: true })).toBeNull()
  })
})

describe('badges', () => {
  it('shortcutLabel', () => {
    expect(shortcutLabel('Meta+S')).toBe('⌘S')
    expect(shortcutLabel('Ctrl+K')).toBe('Ctrl+K')
    expect(shortcutLabel('Shift+Tab')).toBe('⇧Tab')
    expect(shortcutLabel('Alt+ArrowUp')).toBe('Alt+↑')
    expect(shortcutLabel('Escape')).toBe('Esc')
  })
  it('shortcutAt: the latest press within the badge time, until the next', () => {
    const list = [
      { t_ms: 1000, keys: 'Meta+S' },
      { t_ms: 1500, keys: 'Enter' }
    ]
    expect(shortcutAt(list, 999)).toBeNull()
    expect(shortcutAt(list, 1000)?.keys).toBe('Meta+S')
    expect(shortcutAt(list, 1499)?.keys).toBe('Meta+S')
    expect(shortcutAt(list, 1500)?.keys).toBe('Enter')
    expect(shortcutAt(list, 1500 + SHORTCUT_BADGE_MS - 1)?.keys).toBe('Enter')
    expect(shortcutAt(list, 1500 + SHORTCUT_BADGE_MS)).toBeNull()
  })
})
