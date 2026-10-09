// @vitest-environment jsdom
import { act, type ReactElement, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HEADER_TILE } from '../../lib/header-strip'
import { HeaderTiles, useHeaderBand } from './HeaderBand'

// The record sub-header as ItemEditForm renders it — the real measurer
// (useHeaderBand) and the real fold rendering (HeaderTiles) — around a fake
// five-figure widget that counts its mounts and, like WidgetSlot, shows a
// skeleton on mount and its figures once "fetched".
//
// jsdom has no layout, so widths come from the fixture: an element's width
// is its `data-test-w`, else the sum of its children's; a label's / value's
// text width is its `data-test-sw`; the tile group's width is its
// `data-test-client-w`. rAF and ResizeObserver are driven by hand.

function widthOf(el: Element): number {
  if (el.hasAttribute('data-header-more')) return 90
  const own = el.getAttribute('data-test-w')
  if (own != null) return Number(own)
  let w = 0
  for (const c of el.children) w += widthOf(c)
  return w
}

let frames: Map<number, FrameRequestCallback>
let nextFrame = 0
let resizeCallbacks: Array<() => void> = []
const restore: Array<() => void> = []

function stub<T extends object>(target: T, prop: string, desc: PropertyDescriptor) {
  const prev = Object.getOwnPropertyDescriptor(target, prop)
  Object.defineProperty(target, prop, { configurable: true, ...desc })
  restore.push(() => {
    if (prev) Object.defineProperty(target, prop, prev)
    else delete (target as Record<string, unknown>)[prop]
  })
}

beforeEach(() => {
  // React's act() environment flag.
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  frames = new Map()
  resizeCallbacks = []
  stub(HTMLElement.prototype, 'getBoundingClientRect', {
    value(this: HTMLElement) {
      const width = widthOf(this)
      return { width, height: 34, top: 0, left: 0, right: width, bottom: 34, x: 0, y: 0 }
    }
  })
  stub(HTMLElement.prototype, 'scrollWidth', {
    get(this: HTMLElement) {
      return Number(this.getAttribute('data-test-sw') ?? 0)
    }
  })
  stub(HTMLElement.prototype, 'clientWidth', {
    get(this: HTMLElement) {
      return Number(this.getAttribute('data-test-client-w') ?? 0)
    }
  })
  stub(window, 'requestAnimationFrame', {
    value: (cb: FrameRequestCallback) => {
      frames.set(++nextFrame, cb)
      return nextFrame
    }
  })
  stub(window, 'cancelAnimationFrame', { value: (id: number) => frames.delete(id) })
  stub(globalThis, 'ResizeObserver', {
    value: class {
      constructor(cb: () => void) {
        resizeCallbacks.push(cb)
      }
      observe() {}
      disconnect() {}
    }
  })
})

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  while (restore.length) restore.pop()?.()
})

/** Run queued animation frames (each one a measure pass) until none is
 *  queued or `max` ran; returns how many ran. */
async function runFrames(max: number): Promise<number> {
  let n = 0
  while (frames.size > 0 && n < max) {
    const due = [...frames.values()]
    frames.clear()
    await act(async () => {
      for (const cb of due) cb(0)
    })
    n += due.length
  }
  return n
}

let widgetMounts = 0

// The "Project Budget" widget: five money figures, label + value + 36 each
// (StripCell's dense padding), 952px in all.
const FIGURES: Array<[string, string, number, number]> = [
  ["PUB'd", 'needs PUB', 34, 120],
  ['Fusion Remaining', 'needs Fusion', 98, 56],
  ['EFP Committed', '$0.00', 84, 70],
  ['Total Remaining', '—', 92, 62],
  ['Total Remaining %', '—', 104, 52]
]

function FakeWidget() {
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    widgetMounts++
    let live = true
    // WidgetSlot: fetch the definition, then POST the render.
    void Promise.resolve().then(() => live && setLoaded(true))
    return () => {
      live = false
    }
  }, [])
  if (!loaded) return <span data-test-w={144} />
  return (
    <>
      {FIGURES.map(([label, value, lw, vw]) => (
        <div key={label} data-test-w={lw + vw + 36}>
          <span data-header-label data-test-sw={lw}>
            {label}
          </span>
          <span data-header-value data-test-sw={vw}>
            {value}
          </span>
        </div>
      ))}
    </>
  )
}

// Layout 2's header tiles (dense widths from the investigation, 1400px
// viewport); index 2 is the widget.
const DENSE = [172, 190, 952, 125, 110, 196, 173, 105, 161, 309, 90, 150]
const EMPTY = new Set([0, 4, 5, 8, 10])
const MONEY = new Set([0, 1])

function tiles(): ReactElement[] {
  return DENSE.map((w, i) =>
    i === 2 ? (
      <div key='project_budget' className={HEADER_TILE} data-header-money=''>
        <FakeWidget />
      </div>
    ) : (
      <div
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed fixture, never reordered
        key={`field_${i}`}
        className={HEADER_TILE}
        data-test-w={w}
        data-empty={EMPTY.has(i) ? 'true' : undefined}
        data-header-money={MONEY.has(i) ? '' : undefined}
      >
        <span data-header-label data-test-sw={w - 76}>
          Field {i}
        </span>
        <span data-header-value data-test-sw={40}>
          {EMPTY.has(i) ? '—' : 'value'}
        </span>
      </div>
    )
  )
}

function Band({ width }: { width: number }) {
  const { headerDense, headerFolded, headerTilesRef } = useHeaderBand()
  return (
    <div data-header-dense={headerDense ? '' : undefined}>
      <div ref={headerTilesRef} data-test-client-w={width}>
        <HeaderTiles tiles={tiles()} folded={headerDense ? headerFolded : []} />
      </div>
    </div>
  )
}

async function mount(width: number) {
  widgetMounts = 0
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root?.render(<Band width={width} />))
  return host
}

const widgetFolded = (host: HTMLElement) =>
  Array.from(host.querySelectorAll('[data-header-label]'))
    .find((l) => l.textContent === "PUB'd")
    ?.closest('[data-header-folded]') != null

describe('HeaderTiles + useHeaderBand — folding a tile never remounts it', () => {
  it('folds and unfolds the five-figure widget with one mount', async () => {
    const host = await mount(1006)
    await runFrames(40)
    expect(widgetMounts).toBe(1)
    expect(widgetFolded(host)).toBe(true)

    // The window widens: everything fits again.
    await act(async () => root?.render(<Band width={4000} />))
    await act(async () => {
      for (const cb of resizeCallbacks) cb()
    })
    await runFrames(40)
    expect(host.querySelector('[data-header-folded]')).toBeNull()
    expect(widgetMounts).toBe(1)
  })

  it('settles at a fold-triggering width in a bounded number of measure passes', async () => {
    const host = await mount(1006)
    const passes = await runFrames(40)
    expect(frames.size).toBe(0) // nothing left to re-measure
    expect(passes).toBeLessThanOrEqual(4)
    expect(widgetFolded(host)).toBe(true)
  })
})
