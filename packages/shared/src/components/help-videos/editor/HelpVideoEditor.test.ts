// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as editsModule from '../edits'
import type { HelpVideoDto, VersionDto, VideoEdits } from '../types'
import { HelpVideoEditor } from './HelpVideoEditor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Lanes asks isHiddenByCuts once per timed bar on every render it does; the
// chapter list and the poster picker ask sourceToEdited. Counting the calls
// counts those components' renders without instrumenting them.
vi.mock('../edits', async (importOriginal) => {
  const real = await importOriginal<typeof import('../edits')>()
  return {
    ...real,
    isHiddenByCuts: vi.fn(real.isHiddenByCuts),
    sourceToEdited: vi.fn(real.sourceToEdited)
  }
})
const laneWork = () => vi.mocked(editsModule.isHiddenByCuts).mock.calls.length
const panelWork = () => vi.mocked(editsModule.sourceToEdited).mock.calls.length

// The real player needs a <video>; this one hands its props to the test and
// renders the editor's preview tools in a 640x360 frame.
const fake = vi.hoisted(() => ({
  props: null as null | {
    onTime?: (src: number, edited: number) => void
    edits?: VideoEdits
    children?: (f: { width: number; height: number }) => ReactNode
  },
  now: 0,
  seekEdited: [] as number[],
  plays: 0
}))
vi.mock('../HelpVideoPlayer', async () => {
  const { createElement: h } = await import('react')
  return {
    HelpVideoPlayer: (p: NonNullable<typeof fake.props> & { handleRef?: { current: unknown } }) => {
      fake.props = p
      if (p.handleRef)
        p.handleRef.current = {
          seekSource: (ms: number) => {
            fake.now = ms
          },
          sourceMs: () => fake.now,
          seekEdited: (ms: number) => {
            fake.seekEdited.push(ms)
          },
          play: () => {
            fake.plays++
          }
        }
      return h(
        'div',
        { 'data-fake-player': '', style: { position: 'relative' } },
        p.children?.({ width: 640, height: 360 })
      )
    }
  }
})

const request = vi.fn()
// One client for every render, as a real NivaroProvider gives (the editor
// lock's effect keys on it).
const client = { request }
vi.mock('../../../context', () => ({
  useItemEditAuth: () => ({ isAdmin: false, userId: 'U1' }),
  useNivaroClient: () => client,
  useNavigation: () => ({ navigate: () => {} }),
  useApiFetchConfig: () => ({ apiBase: '/api', authHeaders: {}, credentials: 'include' })
}))

// The side panels are memoised components. Each is wrapped in a memo with
// the same props that counts its renders, so the playback test can show
// they skip frames.
const { renders, counted } = vi.hoisted(() => {
  const renders = { inspector: 0, captions: 0, clicks: 0 }
  const counted = async <T>(real: T, name: keyof typeof renders) => {
    const { createElement: h, memo } = await import('react')
    const inner = (real as unknown as { type: (p: object) => ReactNode }).type
    return memo((p: object) => {
      renders[name]++
      return h(inner, p)
    }) as unknown as T
  }
  return { renders, counted }
})
vi.mock('./Inspector', async (importOriginal) => {
  const real = await importOriginal<typeof import('./Inspector')>()
  return { ...real, Inspector: await counted(real.Inspector, 'inspector') }
})
vi.mock('./CaptionsPanel', async (importOriginal) => {
  const real = await importOriginal<typeof import('./CaptionsPanel')>()
  return { ...real, CaptionsPanel: await counted(real.CaptionsPanel, 'captions') }
})
vi.mock('./PosterAndClicks', async (importOriginal) => {
  const real = await importOriginal<typeof import('./PosterAndClicks')>()
  return { ...real, ClickRipples: await counted(real.ClickRipples, 'clicks') }
})

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.scrollIntoView ??= () => {}

const baseEdits: VideoEdits = {
  v: 1,
  segments: [
    { start_ms: 0, end_ms: 10_000, speed: 1 },
    { start_ms: 12_000, end_ms: 20_000, speed: 1 }
  ],
  poster_ms: 0,
  chapters: [{ id: 'c1', at_ms: 0, title: 'Start' }],
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
  zooms: [],
  blurs: [],
  captions: [{ id: 'k1', start_ms: 500, end_ms: 3000, text: 'Hello' }]
}
type Clicks = VersionDto['clicks']
const draftFor = (clicks: Clicks): VersionDto => ({
  id: 'd1',
  version: 2,
  edits: baseEdits,
  edits_hash: 'h0',
  source_duration_ms: 20_000,
  width: 1280,
  height: 720,
  render_status: 'none',
  render_progress: null,
  render_error: null,
  rendered_current: false,
  note: null,
  created_at: '2026-10-08T00:00:00Z',
  clicks,
  levels: null
})
const video = {
  id: 'v1',
  title: 'Probe',
  status: 'draft',
  draft_stream_url: '/help-videos/v1/stream?source=1&st=x',
  contexts: [],
  published: null
} as unknown as HelpVideoDto

let root: Root
let host: HTMLDivElement
/** Someone else holds the editor lock (#1523) when set. */
let lockedBy: { locked_by: string; locked_by_name: string } | null = null
async function mount(clicks: Clicks = null, extra: Partial<VersionDto> = {}) {
  const draft = { ...draftFor(clicks), ...extra }
  request.mockImplementation(async (c: { _method: string; _path: string; _body?: unknown }) => {
    if (c._path.startsWith('/item-locks/') && lockedBy) {
      if (c._method === 'POST' && c._path.endsWith('/lock'))
        throw Object.assign(new Error('locked'), { status: 409, response: lockedBy })
      if (c._method === 'GET') return { data: { ...lockedBy, queue: [], my_position: null } }
    }
    if (c._method === 'GET' && c._path.endsWith('/draft/edits')) return { data: draft }
    if (c._method === 'GET') return { data: { ...video, draft } }
    if (c._method === 'PUT') {
      const b = c._body as { edits: VideoEdits }
      return { data: { ...draft, edits: b.edits, edits_hash: 'h1' } }
    }
    return { data: null }
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(HelpVideoEditor, { videoId: 'v1' })
      )
    )
  )
  // The video and the draft load.
  for (let i = 0; i < 5 && !host.querySelector('[data-hv-editor]'); i++)
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))))
  expect(host.querySelector('[data-hv-editor]')).not.toBeNull()
}

beforeEach(() => {
  fake.now = 0
  fake.seekEdited = []
  fake.plays = 0
  Object.assign(renders, { inspector: 0, captions: 0, clicks: 0 })
  vi.mocked(editsModule.isHiddenByCuts).mockClear()
  vi.mocked(editsModule.sourceToEdited).mockClear()
  request.mockReset()
  lockedBy = null
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector(sel) as T
const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
  })
const pointer = (el: Element, type: string, x: number, y: number) =>
  act(async () => {
    el.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })
    )
  })
const frames = async (n: number) => {
  for (let f = 1; f <= n; f++)
    await act(async () => {
      fake.now = f * 16
      fake.props?.onTime?.(f * 16, f * 16)
    })
}
const edits = () => fake.props?.edits as VideoEdits
const note = () => q('[data-hv-timeline-note]').textContent

describe('HelpVideoEditor during playback', () => {
  it('moves the playhead without re-rendering the lanes or the side panels', async () => {
    await mount([{ t_ms: 1000, x: 0.5, y: 0.5 }])
    const lanes = laneWork()
    const panels = panelWork()
    const side = { ...renders }
    expect(lanes).toBeGreaterThan(0)
    expect(panels).toBeGreaterThan(0)
    expect(side.inspector).toBeGreaterThan(0)
    expect(side.captions).toBeGreaterThan(0)
    expect(side.clicks).toBeGreaterThan(0)
    const playhead = q('[data-hv-playhead]')
    const left0 = playhead.style.left
    await frames(60)
    expect(playhead.style.left).not.toBe(left0)
    expect(laneWork()).toBe(lanes)
    expect(panelWork()).toBe(panels)
    expect({ ...renders }).toEqual(side)
    // The drawing layer does follow the playhead: it lives in the player.
    expect(q('[data-hv-preview-tools]')).not.toBeNull()
  })
})

describe('HelpVideoEditor tools', () => {
  it('adds a chapter at the playhead with M, and refuses a second one there', async () => {
    await mount()
    fake.now = 7000
    await press('m')
    expect(edits().chapters.map((c) => [c.at_ms, c.title])).toEqual([
      [0, 'Start'],
      [7000, 'Chapter 2']
    ])
    expect(q('[data-hv-inspector="chapters"]')).not.toBeNull()
    await press('m')
    expect(edits().chapters).toHaveLength(2)
    expect(note()).toBe('A chapter already starts here.')
  })

  it('draws a shape where the picture is clicked, then puts the tool down', async () => {
    await mount()
    await click(q('[data-hv-tool="callout"]'))
    expect(q('[data-hv-tool="callout"]').getAttribute('aria-pressed')).toBe('true')
    const layer = q('[data-hv-preview-tools]')
    layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 360 }) as DOMRect
    fake.now = 1000
    await act(async () => fake.props?.onTime?.(1000, 1000))
    expect(q('[data-hv-tool-hint]')).not.toBeNull()
    await pointer(layer, 'pointerdown', 320, 180)
    // The hint gets out of the way while drawing.
    expect(q('[data-hv-tool-hint]')).toBeNull()
    await pointer(layer, 'pointerup', 320, 180)
    const added = edits().annotations.find((a) => a.id !== 'a1')
    expect(added).toMatchObject({
      type: 'callout',
      start_ms: 1000,
      end_ms: 3000,
      text: 'Click here',
      rect: { x: 0.39, y: 0.46, w: 0.22, h: 0.08 }
    })
    expect(q('[data-hv-tool="callout"]').getAttribute('aria-pressed')).toBe('false')
    expect(q('[data-hv-inspector="annotations"] h3').textContent).toBe('Callout')
    // The new shape is selected on the picture and takes the keyboard.
    expect(document.activeElement?.getAttribute('data-hv-selected')).toBe(added?.id)
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
      )
    })
    expect(edits().annotations.find((a) => a.id === added?.id)?.rect.x).toBe(0.4)
  })

  it('refuses an overlapping zoom with a note, and keeps the tool up', async () => {
    await mount()
    const layer = () => {
      const l = q('[data-hv-preview-tools]')
      l.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 360 }) as DOMRect
      return l
    }
    await click(q('[data-hv-tool="zoom"]'))
    await pointer(layer(), 'pointerdown', 100, 100)
    await pointer(layer(), 'pointermove', 300, 200)
    await pointer(layer(), 'pointerup', 300, 200)
    expect(edits().zooms).toHaveLength(0) // a selected zoom is left out of the preview
    // …but it was stored: the timeline and the Inspector have it.
    expect(host.querySelectorAll('[data-hv-item^="zooms:"]')).toHaveLength(1)
    expect(q('[data-hv-inspector="zooms"]')).not.toBeNull()
    await click(q('[data-hv-tool="zoom"]'))
    await pointer(layer(), 'pointerdown', 400, 100)
    await pointer(layer(), 'pointerup', 400, 100)
    expect(note()).toMatch(/Zooms can.t overlap\./)
    expect(q('[data-hv-tool="zoom"]').getAttribute('aria-pressed')).toBe('true')
    await press('Escape')
    expect(q('[data-hv-tool="zoom"]').getAttribute('aria-pressed')).toBe('false')
  })

  it('types along a caption at the playhead', async () => {
    await mount()
    fake.now = 1500
    const input = q<HTMLInputElement>('[data-hv-caption-input]')
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      set?.call(input, 'Next line')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(edits().captions.map((c) => [c.start_ms, c.end_ms, c.text])).toEqual([
      [500, 1500, 'Hello'],
      [1500, 3500, 'Next line']
    ])
    expect(input.value).toBe('')
  })

  it('sets the poster from the playhead, but not from a frame that is cut out', async () => {
    await mount()
    fake.now = 11_000 // in the cut between the two pieces
    await click(q('[data-hv-poster]'))
    expect(edits().poster_ms).toBe(0)
    expect(note()).toMatch(/That frame is cut out of the video\./)
    fake.now = 13_000
    await click(q('[data-hv-poster]'))
    expect(edits().poster_ms).toBe(13_000)
    expect(q('[data-hv-poster-picker]').textContent).toMatch(/Poster set to this frame\./)
  })
})

describe('HelpVideoEditor click ripples', () => {
  it("says plainly when clicks weren't captured", async () => {
    await mount(null)
    expect(q('[data-hv-clicks-state]').textContent).toBe(
      "Clicks weren't captured for this recording."
    )
    expect(q('[data-hv-add-ripples]')).toBeNull()
  })

  it('an uploaded file says why there are no clicks, sound levels or pause suggestions', async () => {
    await mount(null, { source_kind: 'upload' })
    expect(q('[data-hv-clicks-state]').textContent).toBe(
      'This video was uploaded as a file, so no clicks were captured. Add ripples by hand with the Ripple tool.'
    )
    expect(q('[data-hv-add-ripples]')).toBeNull()
    expect(q('[data-hv-sound-empty]').getAttribute('data-hv-sound-empty')).toBe('upload')
    expect(q('[data-hv-suggestions]')).toBeNull()
  })

  it('says plainly when none were made', async () => {
    await mount([])
    expect(q('[data-hv-clicks-state]').textContent).toBe('No clicks were recorded.')
    expect(q('[data-hv-add-ripples]')).toBeNull()
  })

  it('adds a ripple per click, once', async () => {
    await mount([
      { t_ms: 1000, x: 0.5, y: 0.5 },
      { t_ms: 6000, x: 0.2, y: 0.3 }
    ])
    const add = q('[data-hv-add-ripples]')
    expect(add.textContent?.trim()).toBe('Add click ripples (2)')
    await click(add)
    expect(edits().annotations.filter((a) => a.type === 'ripple')).toHaveLength(2)
    expect(q('[data-hv-add-ripples]')).toBeNull()
    expect(q('[data-hv-clicks-state]').textContent).toMatch(/Every one of the 2 recorded clicks/)
  })
})

describe('HelpVideoEditor shapes on the picture', () => {
  const frameRect = () => {
    const l = q('[data-hv-preview-tools]')
    l.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 360 }) as DOMRect
  }
  const at = (ms: number) =>
    act(async () => {
      fake.now = ms
      fake.props?.onTime?.(ms, ms)
    })
  const native = (el: Element, type: string, x: number, y: number) =>
    act(async () => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }))
    })

  it('selects a shape with a click that jitters, without moving it or adding an undo step', async () => {
    await mount()
    await at(3000)
    frameRect()
    const pick = q('[data-hv-pick="a1"]')
    await pointer(pick, 'pointerdown', 128, 54)
    await native(pick, 'pointermove', 129, 55)
    await native(pick, 'pointerup', 129, 55)
    const a1 = () => edits().annotations.find((a) => a.id === 'a1')
    expect(a1()?.rect).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.1 })
    expect(q('[data-hv-inspector="annotations"]')).not.toBeNull()
    expect(q<HTMLButtonElement>('[data-hv-undo]').disabled).toBe(true)
    // A real drag does move it.
    await pointer(pick, 'pointerdown', 128, 54)
    await native(pick, 'pointermove', 192, 54)
    await native(pick, 'pointerup', 192, 54)
    expect(a1()?.rect.x).toBeCloseTo(0.2)
    expect(q<HTMLButtonElement>('[data-hv-undo]').disabled).toBe(false)
  })

  it('keeps focus in the preview when the focused shape leaves the picture', async () => {
    await mount()
    await click(q('[data-hv-tool="callout"]'))
    frameRect()
    await at(1000)
    const layer = q('[data-hv-preview-tools]')
    await pointer(layer, 'pointerdown', 320, 180)
    await pointer(layer, 'pointerup', 320, 180)
    expect(document.activeElement?.hasAttribute('data-hv-selected')).toBe(true)
    await at(6000) // the 1–4 s callout is gone from the picture
    expect(q('[data-hv-selected]')).toBeNull()
    expect(document.activeElement?.hasAttribute('data-hv-preview-tools')).toBe(true)
  })
})

describe('HelpVideoEditor card previews', () => {
  const withCards: VideoEdits = {
    ...baseEdits,
    intro: {
      enabled: true,
      duration_ms: 3000,
      show_chapters: false,
      title: '',
      subtitle: '',
      animation: 'subtle',
      transition: 'fade'
    },
    outro: { enabled: true, duration_ms: 3000, text: '', animation: 'subtle', transition: 'fade' },
    poster_card: 'intro'
  }
  it('plays a card from its start with Play it', async () => {
    await mount(null, { edits: withCards })
    await click(q('[data-hv-side-toggle="cards"]'))
    await click(q('[data-hv-card-show="outro"]'))
    // Intro 3 s + kept recording 18 s.
    expect(fake.seekEdited).toEqual([21_000])
    expect(fake.plays).toBe(1)
  })
  it('shows a card poster once the card has arrived, without playing', async () => {
    await mount(null, { edits: withCards })
    await click(q('[data-hv-poster-show]'))
    // Subtle entrance: 900 ms, the server poster's moment.
    expect(fake.seekEdited).toEqual([900])
    expect(fake.plays).toBe(0)
  })
})

describe('HelpVideoEditor typing and idle suggestions (#1518)', () => {
  it('lists typing and idle stretches beside the pauses', async () => {
    await mount(null, {
      activity: [
        { kind: 'idle', start_ms: 1000, end_ms: 5000 },
        { kind: 'typing', start_ms: 6000, end_ms: 9000 }
      ]
    })
    expect(q('[data-hv-suggestions]').textContent).toContain('2 suggestions')
    await click(q('[data-hv-suggestions]'))
    const rows = [...document.querySelectorAll('[data-hv-suggestion-kind]')]
    expect(rows.map((r) => r.getAttribute('data-hv-suggestion-kind'))).toEqual(['idle', 'typing'])
    // Dismissing a suggestion takes it off the list.
    await click(rows[1].querySelector('[data-hv-suggestion-dismiss]') as Element)
    expect(document.querySelectorAll('[data-hv-suggestion-kind]')).toHaveLength(1)
    // Speeding up the idle stretch handles it (4× piece).
    await click(document.querySelector('[data-hv-suggestion-speed]') as Element)
    expect(edits().segments.some((s) => s.speed === 4)).toBe(true)
  })
})

describe('HelpVideoEditor lock (#1523)', () => {
  it('goes read-only while someone else edits, and offers to ask for it', async () => {
    lockedBy = { locked_by: 'U2', locked_by_name: 'Beth Jones' }
    await mount()
    for (let i = 0; i < 5 && !q('[data-hv-editor-locked]'); i++)
      await act(async () => void (await new Promise((r) => setTimeout(r, 0))))
    expect(q('[data-lock-banner]').textContent).toContain(
      'Beth Jones is editing this video — the editor is read-only'
    )
    expect(q('[data-hvx-edit]').closest('[inert]')).not.toBeNull()
    expect(q('[data-hv-publish]')).toBeNull()
    // Shortcuts do nothing while locked out.
    fake.now = 7000
    await press('m')
    expect(edits().chapters).toHaveLength(1)
  })

  it('holds the lock while editing', async () => {
    await mount()
    for (let i = 0; i < 5 && !q('[data-lock-holder]'); i++)
      await act(async () => void (await new Promise((r) => setTimeout(r, 0))))
    expect(q('[data-lock-holder]')).not.toBeNull()
    expect(q('[data-hv-editor-locked]')).toBeNull()
    const lockCalls = request.mock.calls.filter(
      ([c]) => c._method === 'POST' && c._path === '/item-locks/nivaro_help_videos/v1/lock'
    )
    expect(lockCalls).toHaveLength(1)
  })
})

describe('HelpVideoEditor held frames (#1537)', () => {
  it('holds the frame at the playhead with H, on a kept piece, once per spot', async () => {
    await mount()
    fake.now = 7000
    await press('h')
    expect(edits().holds).toEqual([{ id: expect.any(String), at_ms: 7000, hold_ms: 3000 }])
    expect(q('[data-hv-inspector="holds"]')).not.toBeNull()
    expect(q('[data-hv-item^="holds:"]').textContent).toBe('Hold 3 s')
    await press('h')
    expect(edits().holds).toHaveLength(1)
    expect(note()).toBe('A hold already sits here.')
    fake.now = 11_000 // inside the 10–12 s cut
    await press('h')
    expect(edits().holds).toHaveLength(1)
    expect(note()).toBe('Move the playhead to a part viewers see, then try again.')
    // The toolbar button does the same, and is off inside a cut.
    await act(async () => fake.props?.onTime?.(11_000, 11_000))
    expect(q<HTMLButtonElement>('[data-hv-add-hold]').disabled).toBe(true)
    await act(async () => fake.props?.onTime?.(2000, 2000))
    fake.now = 2000
    await click(q('[data-hv-add-hold]'))
    expect(edits().holds?.map((h) => h.at_ms)).toEqual([2000, 7000])
  })
})

describe('HelpVideoEditor group actions (#1543)', () => {
  const down = (el: Element, init: MouseEventInit = {}) =>
    act(async () => {
      el.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, ...init })
      )
    })
  it('deletes a Shift-clicked group with Delete as one undo step, and nudges it with the arrows', async () => {
    await mount()
    await down(q('[data-hv-item="annotations:a1"]'), { shiftKey: true })
    await down(q('[data-hv-item="captions:k1"]'), { shiftKey: true })
    expect(q('[data-hv-inspector="multi"]')).not.toBeNull()
    await press('ArrowRight')
    expect(edits().annotations[0]).toMatchObject({ start_ms: 2033, end_ms: 5033 })
    expect(edits().captions[0]).toMatchObject({ start_ms: 533, end_ms: 3033 })
    await press('ArrowLeft', { shiftKey: true })
    // A second back stops where the caption reaches the start.
    expect(edits().captions[0].start_ms).toBe(0)
    expect(edits().annotations[0].start_ms).toBe(1500)
    await press('Delete')
    expect(edits().annotations).toEqual([])
    expect(edits().captions).toEqual([])
    expect(q('[data-hv-inspector="none"]')).not.toBeNull()
    await click(q('[data-hv-undo]'))
    expect(edits().annotations).toHaveLength(1)
    expect(edits().captions).toHaveLength(1)
    // ] aligns the end of a single selected item to the playhead too.
    await down(q('[data-hv-item="annotations:a1"]'))
    fake.now = 9000
    await press(']')
    expect(edits().annotations[0]).toMatchObject({ start_ms: 6000, end_ms: 9000 })
  })
})
