// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WalkStep } from '../types'
import { FIND_WAIT_MS, HelpVideoWalkHost } from './HelpVideoWalk'
import { currentWalk, endHelpVideoWalk, registerHelpVideoPage, startHelpVideoWalk } from './store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const step = (over: Partial<WalkStep>): WalkStep => ({
  label: 'Approve',
  role: 'button',
  hook: null,
  page_key: null,
  path: null,
  origin: null,
  edited_ms: 0,
  text: null,
  ...over
})

let root: Root
let host: HTMLDivElement
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'performance']
  })
  // jsdom has no layout: give every element a box on screen.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 100,
    left: 100,
    width: 80,
    height: 30,
    right: 180,
    bottom: 130,
    x: 100,
    y: 100,
    toJSON: () => ({})
  } as DOMRect)
  document.body.innerHTML = `<main><button id='approve'>Approve</button></main>`
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(createElement(HelpVideoWalkHost)))
})

afterEach(() => {
  act(() => endHelpVideoWalk())
  act(() => root.unmount())
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const start = (steps: WalkStep[]) =>
  act(() => startHelpVideoWalk({ videoId: 'v1', title: 'Approving a request', steps }))

describe('the guided walk', () => {
  it('rings the element, says what to click and moves on when it is clicked', async () => {
    start([step({ text: 'Approve sends it on.' }), step({ label: 'Close' })])
    expect(q('[data-hv-walk-step]')?.dataset.hvWalkStatus).toBe('found')
    expect(q('[data-hv-walk-ring]')).not.toBeNull()
    expect(q('[data-hv-walk-text]')?.textContent).toContain('Approve sends it on.')
    expect(q('[data-hv-walk-text]')?.textContent).toContain('Click Approve.')
    expect(q('[data-hv-walk-count]')?.textContent).toBe('Step 1 of 2')
    // The click reaches the page as usual.
    const seen = vi.fn()
    q('#approve')?.addEventListener('click', seen)
    act(() => q('#approve')?.click())
    act(() => vi.advanceTimersByTime(1))
    expect(seen).toHaveBeenCalledTimes(1)
    expect(currentWalk()?.index).toBe(1)
  })

  it("says it can't find an element after the wait, and offers to watch or skip", () => {
    start([step({ label: 'Not here' }), step({})])
    expect(q('[data-hv-walk-step]')?.dataset.hvWalkStatus).toBe('searching')
    act(() => vi.advanceTimersByTime(FIND_WAIT_MS + 600))
    expect(q('[data-hv-walk-step]')?.dataset.hvWalkStatus).toBe('missing')
    expect(q('[data-hv-walk-text]')?.textContent).toContain("Can't find Not here on this screen.")
    expect(q('[data-hv-walk-watch]')).not.toBeNull()
    expect(q('[data-hv-walk-next]')?.textContent).toContain('Skip')
    act(() => q('[data-hv-walk-next]')?.click())
    expect(currentWalk()?.index).toBe(1)
  })

  it('finds an element that renders late', () => {
    start([step({ label: 'Later' })])
    act(() => vi.advanceTimersByTime(800))
    expect(q('[data-hv-walk-step]')?.dataset.hvWalkStatus).toBe('searching')
    const b = document.createElement('button')
    b.textContent = 'Later'
    act(() => {
      document.querySelector('main')?.appendChild(b)
    })
    act(() => vi.advanceTimersByTime(600))
    expect(q('[data-hv-walk-step]')?.dataset.hvWalkStatus).toBe('found')
  })

  it('says a step on another screen is elsewhere, with a link on the same origin', () => {
    const off = registerHelpVideoPage('dashboard')
    start([
      step({ page_key: 'queues', path: '/queues', origin: window.location.origin }),
      step({ page_key: 'queues', path: '/queues', origin: 'https://other.example.com' })
    ])
    expect(q('[data-hv-walk-step]')?.dataset.hvWalkStatus).toBe('elsewhere')
    expect(q('[data-hv-walk-text]')?.textContent).toBe('This step is on another screen.')
    expect(q('[data-hv-walk-go]')).not.toBeNull()
    act(() => q('[data-hv-walk-next]')?.click())
    expect(q('[data-hv-walk-go]')).toBeNull()
    act(() => off())
  })

  it('goes back, and Escape ends the walk', () => {
    start([step({}), step({ label: 'Close' })])
    expect((q('[data-hv-walk-back]') as HTMLButtonElement).disabled).toBe(true)
    act(() => q('[data-hv-walk-next]')?.click())
    act(() => q('[data-hv-walk-back]')?.click())
    expect(currentWalk()?.index).toBe(0)
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(currentWalk()).toBeNull()
    expect(q('[data-hv-walk]')).toBeNull()
  })

  it('draws once with two hosts mounted', () => {
    const other = document.createElement('div')
    document.body.appendChild(other)
    const r2 = createRoot(other)
    act(() => r2.render(createElement(HelpVideoWalkHost)))
    start([step({})])
    expect(document.querySelectorAll('[data-hv-walk-step]').length).toBe(1)
    act(() => root.unmount())
    expect(document.querySelectorAll('[data-hv-walk-step]').length).toBe(1)
    act(() => r2.unmount())
    root = createRoot(host)
  })
})
