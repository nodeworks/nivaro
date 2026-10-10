// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PointerPath, VideoEdits } from '../types'
import { Inspector } from './Inspector'
import type { Selection } from './Timeline'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The zoom inspector's Movement section (#1539 stops, #1540 Follow the pointer).

const sq = (x: number, y: number, w = 0.5) => ({ x, y, w, h: w })
const base: VideoEdits = {
  v: 1,
  segments: [{ start_ms: 0, end_ms: 20_000, speed: 1 }],
  poster_ms: 0,
  chapters: [],
  annotations: [],
  zooms: [
    {
      id: 'z1',
      start_ms: 1000,
      end_ms: 5000,
      rect: sq(0, 0),
      ease_ms: 300,
      keyframes: [
        { at_ms: 1000, rect: sq(0, 0) },
        { at_ms: 3000, rect: sq(0.3, 0.3) },
        { at_ms: 5000, rect: sq(0.5, 0.5) }
      ]
    },
    { id: 'z2', start_ms: 6000, end_ms: 8000, rect: sq(0.2, 0.2), ease_ms: 300 }
  ],
  blurs: [],
  captions: []
}
const path: PointerPath = {
  samples: Array.from({ length: 60 }, (_, i) => ({
    t_ms: 5500 + i * 50,
    x: 0.1 + i * 0.01,
    y: 0.5
  })),
  shortcuts: []
}

let api: { edits: VideoEdits }
const onError = vi.fn()
const onSeek = vi.fn()
let root: Root
let host: HTMLDivElement
function Harness({
  selection,
  pointer,
  uploaded
}: {
  selection: Selection
  pointer?: PointerPath | null
  uploaded?: boolean
}) {
  const [edits, setEdits] = useState(base)
  const [sel, setSel] = useState<Selection>(selection)
  api = { edits }
  return createElement(Inspector, {
    edits,
    selection: sel,
    sourceMs: 20_000,
    onChange: setEdits,
    onSelect: setSel,
    onSeek,
    onError,
    pointer,
    uploaded
  })
}
async function mount(selection: Selection, pointer?: PointerPath | null, uploaded?: boolean) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(createElement(Harness, { selection, pointer, uploaded })))
}
const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector(sel) as T
const all = (sel: string) => Array.from(host.querySelectorAll(sel))
const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

beforeEach(() => {
  onError.mockReset()
  onSeek.mockReset()
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('zoom stops in the Inspector', () => {
  it('lists the stops, goes to one, and removes one', async () => {
    await mount({ lane: 'zooms', id: 'z1' })
    expect(all('[data-hv-keyframe-go]').map((b) => b.textContent?.trim())).toEqual([
      'Stop at 0:01',
      'Stop at 0:03',
      'Stop at 0:05'
    ])
    await click(q('[data-hv-keyframe-go="3000"]'))
    expect(onSeek).toHaveBeenCalledWith(3000)
    await click(q('[data-hv-keyframe-remove="3000"]'))
    expect(api.edits.zooms[0].keyframes?.map((k) => k.at_ms)).toEqual([1000, 5000])
    // Down to one stop the zoom stands still, showing that stop's area.
    await click(q('[data-hv-keyframe-remove="1000"]'))
    expect(api.edits.zooms[0].keyframes).toBeUndefined()
    expect(api.edits.zooms[0].rect).toEqual(sq(0.5, 0.5))
    expect(q('[data-hv-keyframes]')).toBeNull()
    expect(onError).not.toHaveBeenCalled()
  })
  it('Follow the pointer is disabled with a reason when there is no path', async () => {
    await mount({ lane: 'zooms', id: 'z2' }, null)
    const btn = q<HTMLButtonElement>('[data-hv-follow-pointer]')
    expect(btn.disabled).toBe(true)
    expect(q('[data-hv-follow-pointer-reason]').textContent).toMatch(/no pointer path/)
    await act(async () => root.unmount())
    host.remove()
    await mount({ lane: 'zooms', id: 'z2' }, null, true)
    expect(q('[data-hv-follow-pointer-reason]').textContent).toMatch(/uploaded video/)
  })
  it('Follow the pointer makes stops from the path over the zoom', async () => {
    await mount({ lane: 'zooms', id: 'z2' }, path)
    const btn = q<HTMLButtonElement>('[data-hv-follow-pointer]')
    expect(btn.disabled).toBe(false)
    await click(btn)
    const z = api.edits.zooms.find((x) => x.id === 'z2')
    expect(z?.keyframes?.map((k) => k.at_ms)).toEqual([6000, 6500, 7000, 7500, 8000])
    expect(z?.rect).toEqual(z?.keyframes?.[0].rect)
    expect(all('[data-hv-keyframe-go]')).toHaveLength(5)
    expect(onError).not.toHaveBeenCalled()
  })
  it('says so when the pointer was not seen during the zoom', async () => {
    await mount({ lane: 'zooms', id: 'z1' }, path) // the path starts at 5.5 s, after z1
    await click(q('[data-hv-follow-pointer]'))
    expect(onError).toHaveBeenCalledWith('The pointer was not seen on this tab during this zoom')
  })
})
