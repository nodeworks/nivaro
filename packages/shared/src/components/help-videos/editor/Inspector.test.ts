// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoEdits } from '../types'
import { Inspector } from './Inspector'
import { parseTime } from './TimeField'
import type { Selection } from './Timeline'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const base: VideoEdits = {
  v: 1,
  segments: [{ start_ms: 0, end_ms: 20_000, speed: 1 }],
  poster_ms: 0,
  chapters: [],
  annotations: [
    {
      id: 'a1',
      type: 'callout',
      start_ms: 2000,
      end_ms: 5000,
      rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
      to: null,
      text: 'First',
      tone: 'accent'
    }
  ],
  zooms: [
    { id: 'z1', start_ms: 1000, end_ms: 3000, rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, ease_ms: 300 },
    { id: 'z2', start_ms: 4000, end_ms: 6000, rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, ease_ms: 300 }
  ],
  blurs: [],
  captions: []
}

let api: { edits: VideoEdits }
const onError = vi.fn()
let root: Root
let host: HTMLDivElement
function Harness({ selection }: { selection: Selection }) {
  const [edits, setEdits] = useState(base)
  const [sel, setSel] = useState<Selection>(selection)
  api = { edits }
  return createElement(Inspector, {
    edits,
    selection: sel,
    sourceMs: 20_000,
    onChange: setEdits,
    onSelect: setSel,
    onSeek: () => {},
    onError
  })
}
async function mount(selection: Selection) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(createElement(Harness, { selection })))
}
beforeEach(() => onError.mockReset())
afterEach(async () => {
  if (!host) return
  await act(async () => root.unmount())
  host.remove()
  host = undefined as unknown as HTMLDivElement
})

const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector(sel) as T
const type = (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))
  })
const click = (el: Element, init: MouseEventInit = {}) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }))
  })
const callout = () => api.edits.annotations[0]

describe('parseTime', () => {
  it('reads seconds, a comma, minutes and a trailing s', () => {
    expect(parseTime('12.5')).toBe(12_500)
    expect(parseTime('12,5')).toBe(12_500)
    expect(parseTime('1:02.5')).toBe(62_500)
    expect(parseTime('3 s')).toBe(3000)
    expect(parseTime('soon')).toBeNull()
    expect(parseTime('')).toBeNull()
  })
})

describe('Inspector timing from the keyboard', () => {
  it('sets the start and end by typing, and steps them with the arrow keys', async () => {
    await mount({ lane: 'annotations', id: 'a1' })
    const start = q<HTMLInputElement>('[data-hv-time="start"]')
    await type(start, '3.5')
    await key(start, 'Enter')
    expect(callout()).toMatchObject({ start_ms: 3500, end_ms: 5000 })
    const end = q<HTMLInputElement>('[data-hv-time="end"]')
    await key(end, 'ArrowUp')
    expect(callout().end_ms).toBe(5100)
    await key(end, 'ArrowDown', { shiftKey: true })
    expect(callout().end_ms).toBe(4100)
    expect(end.value).toBe('4.1')
  })

  it('moves it whole and stretches it with the buttons', async () => {
    await mount({ lane: 'annotations', id: 'a1' })
    await click(q('[data-hv-move="later"]'))
    expect(callout()).toMatchObject({ start_ms: 2100, end_ms: 5100 })
    await click(q('[data-hv-move="earlier"]'), { shiftKey: true })
    expect(callout()).toMatchObject({ start_ms: 1100, end_ms: 4100 })
    await click(q('[aria-label="End 0.1 seconds later"]'))
    expect(callout()).toMatchObject({ start_ms: 1100, end_ms: 4200 })
  })

  it('refuses what would break the item, with the reason, and shows the stored time again', async () => {
    await mount({ lane: 'annotations', id: 'a1' })
    const start = q<HTMLInputElement>('[data-hv-time="start"]')
    await type(start, '4.9')
    await key(start, 'Enter')
    expect(onError).toHaveBeenLastCalledWith('It has to start at least 0.2 seconds before it ends')
    expect(callout().start_ms).toBe(2000)
    expect(start.value).toBe('2.0')
    await act(async () => start.focus())
    await type(start, 'soon')
    await act(async () => start.blur())
    expect(onError).toHaveBeenLastCalledWith('Type a time in seconds, like 12.5')
    expect(start.value).toBe('2.0')
  })

  it('sends an overlapping zoom to the note and leaves the zoom where it was', async () => {
    await mount({ lane: 'zooms', id: 'z1' })
    const end = q<HTMLInputElement>('[data-hv-time="end"]')
    await type(end, '4.5')
    await key(end, 'Enter')
    expect(onError).toHaveBeenLastCalledWith(expect.stringMatching(/Zooms can.t overlap/))
    expect(api.edits.zooms[0].end_ms).toBe(3000)
  })
})
