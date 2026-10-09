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

// The "Project Budget" widget on 284212: five money figures, the null ones a
// dash (no `awaiting` in the render response), EFP Committed $0.00. Text
// widths (`data-test-sw`) as the investigation's sketch had them; each
// figure RENDERS ~190px (952 in all, as measured) — more than its text-based
// estimate, so the estimate of the folded widget (658) is short of the truth
// and only a remembered measurement keeps the fold stable.
const FIGURES: Array<[string, string, number, number]> = [
  ["PUB'd", '—', 34, 8],
  ['Fusion Remaining', '—', 98, 8],
  ['EFP Committed', '$0.00', 84, 34],
  ['Total Remaining', '—', 92, 8],
  ['Total Remaining %', '—', 104, 8]
]
const FIGURE_W = [190, 190, 190, 190, 192]

function FakeWidget({ committed }: { committed: string }) {
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
      {FIGURES.map(([label, value, lw, vw], i) => (
        <div key={label} data-test-w={FIGURE_W[i]}>
          <span data-header-label data-test-sw={lw}>
            {label}
          </span>
          <span data-header-value data-test-sw={vw}>
            {label === 'EFP Committed' ? committed : value}
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

function tiles(committed: string): ReactElement[] {
  return DENSE.map((w, i) =>
    i === 2 ? (
      <div key='project_budget' className={HEADER_TILE} data-header-money=''>
        <FakeWidget committed={committed} />
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

function Band({
  width,
  committed = '$0.00',
  items
}: {
  width: number
  committed?: string
  items?: ReactElement[]
}) {
  const { headerDense, headerFolded, headerTilesRef } = useHeaderBand()
  return (
    <div data-header-dense={headerDense ? '' : undefined}>
      <div ref={headerTilesRef} data-test-client-w={width}>
        <HeaderTiles tiles={items ?? tiles(committed)} folded={headerDense ? headerFolded : []} />
      </div>
    </div>
  )
}

async function mount(band: ReactElement) {
  widgetMounts = 0
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root?.render(band))
  return host
}

const widgetFolded = (host: HTMLElement) =>
  Array.from(host.querySelectorAll('[data-header-label]'))
    .find((l) => l.textContent === "PUB'd")
    ?.closest('[data-header-folded]') != null

describe('HeaderTiles + useHeaderBand — folding a tile never remounts it', () => {
  it('folds and unfolds the five-figure widget with one mount', async () => {
    const host = await mount(<Band width={1006} />)
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
    const host = await mount(<Band width={1006} />)
    const passes = await runFrames(40)
    expect(frames.size).toBe(0) // nothing left to re-measure
    expect(passes).toBeLessThanOrEqual(4)
    expect(widgetFolded(host)).toBe(true)
  })
})

describe('useHeaderBand — a folded cell keeps the width it was folded on', () => {
  it('a figure changing inside the folded widget does not unfold it', async () => {
    const host = await mount(<Band width={1006} />)
    await runFrames(40)
    expect(widgetFolded(host)).toBe(true)

    // The folded widget's render refetches: EFP Committed changes.
    await act(async () => root?.render(<Band width={1006} committed='$1,250.00' />))
    expect(host.textContent).toContain('$1,250.00')
    const seen: boolean[] = []
    let n = 0
    while (frames.size > 0 && n++ < 40) {
      await runFrames(1)
      seen.push(widgetFolded(host))
    }
    // Clearing every remembered width here left the widget costed at its
    // text estimate (658 of 952): it unfolded, then refolded.
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(Boolean)).toBe(true)
  })
})

// A header summary chip renders nothing when it has no rows
// (hide_when_zero) — like HeaderSummaryChip, it passes the band's cell
// attributes to its tile.
function FakeSummary({ hidden, label, ...cell }: { hidden?: boolean; label: string }) {
  if (hidden) return null
  return (
    <div className={HEADER_TILE} data-test-w={150} data-header-money='' {...cell}>
      <span data-header-label data-test-sw={60}>
        {label}
      </span>
      <span data-header-value data-test-sw={40}>
        $5.00
      </span>
    </div>
  )
}

describe('HeaderTiles — folds by tile key, not position', () => {
  it('a summary that renders nothing does not shift which tile folds', async () => {
    const money = (key: string) => (
      <div key={key} className={HEADER_TILE} data-test-w={150} data-header-money=''>
        <span data-header-label data-test-sw={60}>
          {key}
        </span>
        <span data-header-value data-test-sw={40}>
          $1.00
        </span>
      </div>
    )
    const items = [
      money('A'),
      money('B'),
      <FakeSummary key='__summary__empty' hidden label='Empty' />,
      <FakeSummary key='__summary__lines' label='Lines' />
    ]
    // 250px: A | B | Lines needs three rows; folding the right-most money
    // cell (Lines) leaves A | B + chip.
    const host = await mount(<Band width={250} items={items} />)
    await runFrames(40)
    const lines = Array.from(host.querySelectorAll('[data-header-label]')).find(
      (l) => l.textContent === 'Lines'
    )
    expect(lines?.closest('[data-header-folded]')).not.toBeNull()
  })
})
