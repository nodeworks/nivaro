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
    expect(api.selection).toBeNull()
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
