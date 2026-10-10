// @vitest-environment jsdom
import { act, createElement, useCallback, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as editsModule from '../edits'
import type { VideoEdits } from '../types'
import { type Selection, Timeline } from './Timeline'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Lanes asks isHiddenByCuts once per timed bar on every render it does, so
// counting its calls counts the lanes' renders without instrumenting them.
vi.mock('../edits', async (importOriginal) => {
  const real = await importOriginal<typeof import('../edits')>()
  return { ...real, isHiddenByCuts: vi.fn(real.isHiddenByCuts) }
})
const laneWork = () => vi.mocked(editsModule.isHiddenByCuts).mock.calls.length

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

const base: VideoEdits = {
  v: 1,
  segments: [
    { start_ms: 0, end_ms: 10_000, speed: 1 },
    { start_ms: 12_000, end_ms: 40_000, speed: 1 }
  ],
  poster_ms: 0,
  chapters: [{ id: 'c1', at_ms: 0, title: 'Start' }],
  // Out of start order on purpose: the keyboard follows time, not the array.
  annotations: [
    {
      id: 'a2',
      type: 'callout',
      start_ms: 20_000,
      end_ms: 23_000,
      rect: { x: 0, y: 0, w: 0.2, h: 0.1 },
      to: null,
      text: 'Second',
      tone: 'accent'
    },
    {
      id: 'a1',
      type: 'callout',
      start_ms: 2000,
      end_ms: 5000,
      rect: { x: 0, y: 0, w: 0.2, h: 0.1 },
      to: null,
      text: 'First',
      tone: 'accent'
    }
  ],
  zooms: [
    {
      id: 'z1',
      start_ms: 30_000,
      end_ms: 33_000,
      rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
      ease_ms: 300
    }
  ],
  blurs: [
    {
      id: 'b1',
      start_ms: 10_200,
      end_ms: 11_500,
      rect: { x: 0, y: 0, w: 0.2, h: 0.1 },
      strength: 10
    }
  ],
  captions: [{ id: 'k1', start_ms: 500, end_ms: 3000, text: 'Hello' }]
}
const TIMED = 5 // annotations + zooms + blurs + captions

type Api = {
  setPlayhead: (ms: number) => void
  setSelection: (s: Selection) => void
  setEdits: (e: VideoEdits) => void
  edits: VideoEdits
  selection: Selection
}
let api: Api
let root: Root
let host: HTMLDivElement

function Harness() {
  const [edits, setEdits] = useState(base)
  const [playhead, setPlayhead] = useState(0)
  const [selection, setSelection] = useState<Selection>(null)
  const onChange = useCallback((e: VideoEdits) => setEdits(e), [])
  const onSeek = useCallback(() => {}, [])
  api = { setPlayhead, setSelection, setEdits, edits, selection }
  return createElement(Timeline, {
    edits,
    sourceMs: 40_000,
    playheadSrcMs: playhead,
    levels: null,
    selection,
    onSelect: setSelection,
    onSeek,
    onChange
  })
}

beforeEach(async () => {
  vi.mocked(editsModule.isHiddenByCuts).mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(createElement(Harness)))
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector(sel) as T
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))
  })

describe('Timeline lanes during playback', () => {
  it('moves the playhead without re-rendering the lanes', async () => {
    const first = laneWork()
    expect(first).toBe(TIMED)
    const playhead = q('[data-hv-playhead]')
    const left0 = playhead.style.left
    for (let f = 1; f <= 60; f++) await act(async () => api.setPlayhead(f * 16))
    expect(playhead.style.left).not.toBe(left0)
    expect(laneWork()).toBe(first)
  })

  it('still re-renders the lanes when the selection or the edits change', async () => {
    const first = laneWork()
    await act(async () => api.setSelection({ lane: 'zooms', id: 'z1' }))
    expect(laneWork()).toBe(first + TIMED)
    await act(async () => api.setEdits({ ...api.edits, poster_ms: 1 }))
    expect(laneWork()).toBe(first + 2 * TIMED)
  })
})

describe('Timeline keyboard', () => {
  it('gives each lane one tab stop, the earliest bar until one is selected', async () => {
    const stops = host.querySelectorAll('[data-hv-item^="annotations:"][tabindex="0"]')
    expect([...stops].map((b) => b.getAttribute('data-hv-item'))).toEqual(['annotations:a1'])
    await act(async () => api.setSelection({ lane: 'annotations', id: 'a2' }))
    const after = host.querySelectorAll('[data-hv-item^="annotations:"][tabindex="0"]')
    expect([...after].map((b) => b.getAttribute('data-hv-item'))).toEqual(['annotations:a2'])
    expect(host.querySelectorAll('[data-hv-segment][tabindex="0"]')).toHaveLength(1)
  })

  it('moves along a lane in time order with the arrows, Home and End', async () => {
    const a1 = q<HTMLButtonElement>('[data-hv-item="annotations:a1"]')
    await act(async () => a1.focus())
    expect(api.selection).toEqual({ lane: 'annotations', id: 'a1' })
    await key(a1, 'ArrowRight')
    expect(document.activeElement?.getAttribute('data-hv-item')).toBe('annotations:a2')
    expect(api.selection).toEqual({ lane: 'annotations', id: 'a2' })
    await key(document.activeElement as Element, 'Home')
    expect(document.activeElement?.getAttribute('data-hv-item')).toBe('annotations:a1')
    await key(document.activeElement as Element, 'End')
    expect(document.activeElement?.getAttribute('data-hv-item')).toBe('annotations:a2')
  })

  it('nudges with Alt+arrows and removes with Delete', async () => {
    const a1 = q<HTMLButtonElement>('[data-hv-item="annotations:a1"]')
    await act(async () => a1.focus())
    await key(a1, 'ArrowRight', { altKey: true })
    expect(api.edits.annotations.find((a) => a.id === 'a1')?.start_ms).toBe(2100)
    await key(q('[data-hv-item="annotations:a1"]'), 'ArrowRight', { altKey: true, shiftKey: true })
    expect(api.edits.annotations.find((a) => a.id === 'a1')?.start_ms).toBe(3100)
    await key(q('[data-hv-item="annotations:a1"]'), 'Delete')
    expect(api.edits.annotations.map((a) => a.id)).toEqual(['a2'])
    // Focus (and the selection) moves on to the next bar in time.
    expect(document.activeElement?.getAttribute('data-hv-item')).toBe('annotations:a2')
    expect(api.selection).toEqual({ lane: 'annotations', id: 'a2' })
  })

  it('after Delete, focuses the previous bar when there is no next, then the empty lane', async () => {
    const a2 = q<HTMLButtonElement>('[data-hv-item="annotations:a2"]')
    await act(async () => a2.focus())
    await key(a2, 'Delete')
    expect(document.activeElement?.getAttribute('data-hv-item')).toBe('annotations:a1')
    await key(document.activeElement as Element, 'Delete')
    expect(api.edits.annotations).toEqual([])
    const lane = document.activeElement as HTMLElement
    expect(lane.getAttribute('data-hv-lane')).toBe('annotations')
    expect(lane.tabIndex).toBe(0)
    expect(api.selection).toBeNull()
  })

  it('keeps one tab stop in every lane: empty lanes and a stale piece index too', async () => {
    await act(async () => api.setEdits({ ...api.edits, captions: [] }))
    expect(q('[data-hv-lane="captions"]').tabIndex).toBe(0)
    expect(q('[data-hv-lane="annotations"]').tabIndex).toBe(-1)
    // A selection left over from a longer list of pieces.
    await act(async () => api.setSelection({ lane: 'cuts', index: 7 }))
    const stops = host.querySelectorAll('[data-hv-segment][tabindex="0"]')
    expect([...stops].map((b) => b.getAttribute('data-hv-segment'))).toEqual(['1'])
  })

  it('names callouts and captions by their lane, and keeps hidden bars readable', () => {
    expect(q('[data-hv-item="annotations:a1"]').getAttribute('aria-label')).toBe(
      'Callouts: First, 0:02 to 0:05'
    )
    expect(q('[data-hv-item="captions:k1"]').getAttribute('aria-label')).toBe(
      'Captions: Hello, 0:01 to 0:03'
    )
    // The blur sits in the 10–12 s gap between the kept pieces.
    const blur = q('[data-hv-item="blurs:b1"]')
    expect(blur.getAttribute('aria-label')).toMatch(/hidden by a cut$/)
    expect(blur.className).not.toMatch(/opacity-/)
    expect(blur.className).toMatch(/border-dashed/)
  })

  it('stacks bars at the same moment on sub-rows, and the labels follow', async () => {
    const same = (id: string) => ({
      ...base.annotations[1],
      id,
      start_ms: 6000,
      end_ms: 9000,
      text: id
    })
    await act(async () =>
      api.setEdits({ ...api.edits, annotations: [same('s1'), same('s2'), same('s3')] })
    )
    const tops = ['s1', 's2', 's3'].map((id) => q(`[data-hv-item="annotations:${id}"]`).style.top)
    expect(new Set(tops).size).toBe(3)
    const lane = q('[data-hv-lane="annotations"]')
    expect(lane.style.height).toBe('66px')
    expect(q('[data-hv-lane-label="annotations"]').style.height).toBe(lane.style.height)
    // Keyboard order still follows time (then id), not the rows.
    expect(
      ['s1', 's2', 's3'].map((id) => q(`[data-hv-item="annotations:${id}"]`).dataset.hvOrder)
    ).toEqual(['0', '1', '2'])
    // A lane with one row keeps the usual height.
    expect(q('[data-hv-lane="zooms"]').style.height).toBe('28px')
  })

  it('shows a refused change as a note and leaves the edits alone', async () => {
    // Two zooms; moving the second onto the first is refused.
    await act(async () =>
      api.setEdits({
        ...api.edits,
        zooms: [
          ...api.edits.zooms,
          {
            id: 'z0',
            start_ms: 33_200,
            end_ms: 36_000,
            rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
            ease_ms: 300
          }
        ]
      })
    )
    const before = api.edits
    const z0 = q<HTMLButtonElement>('[data-hv-item="zooms:z0"]')
    await act(async () => z0.focus())
    await key(z0, 'ArrowLeft', { altKey: true, shiftKey: true })
    expect(api.edits).toBe(before)
    expect(q('[data-hv-timeline-note]').textContent).toMatch(/Zooms can.t overlap\..*\.$/)
  })
})

Element.prototype.setPointerCapture ??= () => {}
const press = (el: Element, type: string, init: MouseEventInit = {}) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }))
  })

describe('Timeline multi-select (#1543)', () => {
  it('adds bars to the selection with Shift-click, across lanes, and takes them out again', async () => {
    await press(q('[data-hv-item="annotations:a1"]'), 'pointerdown', { shiftKey: true })
    expect(api.selection).toEqual({ lane: 'annotations', id: 'a1' })
    await press(q('[data-hv-item="captions:k1"]'), 'pointerdown', { metaKey: true })
    await press(q('[data-hv-chapter="c1"]'), 'pointerdown', { shiftKey: true })
    expect(api.selection).toEqual({
      lane: 'multi',
      items: [
        { lane: 'annotations', id: 'a1' },
        { lane: 'captions', id: 'k1' },
        { lane: 'chapters', id: 'c1' }
      ]
    })
    expect(q('[data-hv-item="captions:k1"]').getAttribute('aria-pressed')).toBe('true')
    expect(q('[data-hv-chapter="c1"]').className).toMatch(/ring-nvr-cyan/)
    // Focus following the click keeps the group (Chrome focuses a pressed button).
    await act(async () => q<HTMLButtonElement>('[data-hv-item="captions:k1"]').focus())
    expect(api.selection?.lane).toBe('multi')
    await press(q('[data-hv-item="captions:k1"]'), 'pointerdown', { shiftKey: true })
    expect(api.selection).toEqual({
      lane: 'multi',
      items: [
        { lane: 'annotations', id: 'a1' },
        { lane: 'chapters', id: 'c1' }
      ]
    })
    // A plain click selects that bar alone again.
    await press(q('[data-hv-item="annotations:a2"]'), 'pointerdown')
    expect(api.selection).toEqual({ lane: 'annotations', id: 'a2' })
  })

  it('selects what a marquee over empty lane space crosses, on every lane it crosses', async () => {
    const lanes = q('[data-hv-lanes]')
    lanes.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1600, height: 196 }) as DOMRect
    // 40 px a second (no width to fit): the callout a1 (2–5 s) sits at
    // x 80–200 on the annotations lane (y 84–112), the caption k1 (0.5–3 s)
    // at x 20–120 on the captions lane (y 168–196).
    await press(lanes, 'pointerdown', { clientX: 90, clientY: 90 })
    expect(q('[data-hv-marquee]')).toBeNull()
    await press(lanes, 'pointermove', { clientX: 150, clientY: 190 })
    expect(q('[data-hv-marquee]')).not.toBeNull()
    await press(lanes, 'pointerup', { clientX: 150, clientY: 190 })
    expect(q('[data-hv-marquee]')).toBeNull()
    expect(api.selection).toEqual({
      lane: 'multi',
      items: [
        { lane: 'annotations', id: 'a1' },
        { lane: 'captions', id: 'k1' }
      ]
    })
    // Shift adds to it; a plain click on empty space clears it.
    await press(lanes, 'pointerdown', { clientX: 1210, clientY: 120, shiftKey: true })
    await press(lanes, 'pointermove', { clientX: 1300, clientY: 130, shiftKey: true })
    await press(lanes, 'pointerup', { clientX: 1300, clientY: 130 })
    expect(api.selection?.lane === 'multi' && api.selection.items.map((i) => i.id)).toEqual([
      'a1',
      'k1',
      'z1'
    ])
    await press(lanes, 'pointerdown', { clientX: 1000, clientY: 150 })
    await press(lanes, 'pointerup', { clientX: 1001, clientY: 150 })
    expect(api.selection).toBeNull()
  })

  it('shows held frames on their own lane, hollow inside a cut, and keeps the group keys for the editor', async () => {
    await act(async () =>
      api.setEdits({
        ...api.edits,
        holds: [
          { id: 'h1', at_ms: 6000, hold_ms: 2500 },
          { id: 'h2', at_ms: 11_000, hold_ms: 1000 }
        ]
      })
    )
    const h1 = q('[data-hv-item="holds:h1"]')
    expect(h1.textContent).toBe('Hold 2.5 s')
    expect(h1.getAttribute('aria-label')).toBe('Held frame at 0:06, 2.5 seconds')
    expect(h1.style.left).toBe('240px')
    const h2 = q('[data-hv-item="holds:h2"]')
    expect(h2.getAttribute('aria-label')).toMatch(/hidden by a cut$/)
    expect(h2.className).toMatch(/border-dashed/)
    expect(q('[data-hv-lane-label="holds"]').textContent).toBe('Holds')
    // Alone, Alt+arrow nudges a hold; in a group the bar leaves the keys alone.
    await act(async () => (h1 as HTMLButtonElement).focus())
    await key(h1, 'ArrowRight', { altKey: true })
    expect(api.edits.holds?.[0].at_ms).toBe(6100)
    await act(async () =>
      api.setSelection({
        lane: 'multi',
        items: [
          { lane: 'holds', id: 'h1' },
          { lane: 'annotations', id: 'a1' }
        ]
      })
    )
    const ev = new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true })
    await act(async () => {
      q('[data-hv-item="holds:h1"]').dispatchEvent(ev)
    })
    expect(ev.defaultPrevented).toBe(false)
    expect(api.edits.holds?.[0].at_ms).toBe(6100)
  })
})
