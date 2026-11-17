// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetLivePreferenceForTests, setLiveMode } from './live-preference'
import { NEW_ROW_FADE_MS, NEW_ROW_HOLD_MS, slideIn } from './live-screen'

// A live arrival is marked, never faded: the row's text stays readable, an accent background
// holds ~2 s then fades, and a row nobody saw arrive gets a dot until it is in view.

type Kf = Array<Record<string, unknown>>
let animate: ReturnType<typeof vi.fn<(...args: any[]) => any>>
let io: {
  cb: (e: unknown[]) => void
  observe: ReturnType<typeof vi.fn<(...args: any[]) => any>>
  disconnect: ReturnType<typeof vi.fn<(...args: any[]) => any>>
}

function list() {
  const root = document.createElement('div')
  const row = document.createElement('div')
  row.setAttribute('data-live-key', 'r1')
  row.textContent = 'Ada changed Objective'
  root.appendChild(row)
  document.body.appendChild(root)
  return { root, row }
}

beforeEach(() => {
  __resetLivePreferenceForTests()
  document.documentElement.classList.remove('dark')
  animate = vi.fn()
  ;(HTMLElement.prototype as unknown as { animate: unknown }).animate = animate
  io = { cb: () => {}, observe: vi.fn(), disconnect: vi.fn() }
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    constructor(cb: (e: unknown[]) => void) {
      io.cb = cb
    }
    observe = io.observe
    disconnect = io.disconnect
  }
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})
afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('slideIn — arrivals are marked, not faded', () => {
  it('slides the row in without ever hiding its text, and holds an accent background ~2 s', () => {
    const { root } = list()
    slideIn(root, ['r1'])
    expect(animate).toHaveBeenCalledTimes(2)
    const slide = animate.mock.calls[0][0] as Kf
    expect(Math.min(...slide.map((k) => Number(k.opacity ?? 1)))).toBeGreaterThanOrEqual(0.6)
    const [fill, opts] = animate.mock.calls[1] as [Kf, { duration: number }]
    expect(opts.duration).toBe(NEW_ROW_HOLD_MS + NEW_ROW_FADE_MS)
    // light: the cyan accent; holds, then decays to transparent
    expect(String(fill[0].backgroundColor)).toContain('0, 206, 255')
    expect(fill[1].offset).toBeCloseTo(NEW_ROW_HOLD_MS / (NEW_ROW_HOLD_MS + NEW_ROW_FADE_MS))
    expect(String(fill[2].backgroundColor)).toContain('0, 0, 0, 0')
  })

  it('uses the amber accent on a dark page', () => {
    document.documentElement.classList.add('dark')
    const { root } = list()
    slideIn(root, ['r1'])
    expect(String((animate.mock.calls[1][0] as Kf)[0].backgroundColor)).toContain('245, 158, 11')
  })

  it('Calm updates skip the slide but still show the highlight (it carries state)', () => {
    setLiveMode('calm')
    const { root } = list()
    slideIn(root, ['r1'])
    expect(animate).toHaveBeenCalledTimes(1)
    expect(String((animate.mock.calls[0][0] as Kf)[0].backgroundColor)).toContain('0, 206, 255')
  })

  it('a row that arrived while nobody looked gets a dot, not an animation, until it is seen', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    const { root, row } = list()
    slideIn(root, ['r1'])
    expect(animate).not.toHaveBeenCalled()
    expect(row.querySelector('[data-live-new-dot]')).not.toBeNull()
    expect(io.observe).not.toHaveBeenCalled() // nobody can see it yet: waits for the tab
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(row.querySelector('[data-live-new-dot]')).not.toBeNull()
    expect(io.observe).toHaveBeenCalledWith(row)
    // half in view: seen -> the dot goes
    io.cb([{ isIntersecting: true, intersectionRatio: 0.6 }])
    expect(row.querySelector('[data-live-new-dot]')).toBeNull()
  })

  it('a window without focus counts as away too', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const { root, row } = list()
    slideIn(root, ['r1'])
    expect(row.querySelector('[data-live-new-dot]')).not.toBeNull()
    expect(animate).not.toHaveBeenCalled()
  })
})
