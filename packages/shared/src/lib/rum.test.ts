// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { rumRouteChange, startRum } from './rum'

/**
 * Route timing counts from the route change to the second painted frame. A tab
 * nobody is looking at paints no frames, so the frames arrive when it is first
 * shown: production logged one "route" sample of 243,035 ms for a replay opened
 * in a background tab (its own requests had all answered in under 100 ms), and
 * that one row made the page's average read 35 s.
 */

type Sent = { kind: string; route: string; duration_ms?: number }

let frames: FrameRequestCallback[] = []
let sent: Sent[] = []
let clock = 1_000

/** Run the frames asked for so far (one generation, as a browser paint does). */
function paint(): void {
  const due = frames
  frames = []
  for (const f of due) f(clock)
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Everything queued goes out on pagehide. */
function flushed(): Sent[] {
  window.dispatchEvent(new Event('pagehide'))
  return sent.filter((e) => e.kind === 'route')
}

beforeAll(() => {
  vi.useFakeTimers()
  const perf = performance as unknown as Record<string, unknown>
  if (typeof perf.getEntriesByType !== 'function') perf.getEntriesByType = () => []
  if (typeof perf.getEntriesByName !== 'function') perf.getEntriesByName = () => []
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      sent.push(...(JSON.parse(init.body).events as Sent[]))
      return new Response('{}', { status: 200 })
    })
  )
  setVisibility('visible')
  startRum({ app: 'test' })
})

beforeEach(() => {
  frames = []
  sent = []
  setVisibility('visible')
  window.dispatchEvent(new Event('pagehide'))
  sent = []
})

afterEach(() => {
  setVisibility('visible')
})

describe('rumRouteChange', () => {
  it('times a route change from the change to the second painted frame', () => {
    rumRouteChange('/analytics/replays')
    clock += 5
    paint()
    clock += 7
    paint()
    expect(flushed()).toEqual([
      expect.objectContaining({ route: '/analytics/replays', kind: 'route', duration_ms: 12 })
    ])
  })

  it('reports nothing for a page opened in a background tab', () => {
    setVisibility('hidden')
    sent = []
    rumRouteChange('/analytics/replays')
    // Four minutes later the person switches to the tab and it paints.
    clock += 243_035
    setVisibility('visible')
    paint()
    paint()
    expect(flushed()).toEqual([])
  })

  it('reports nothing when the tab is hidden before the frames arrive', () => {
    rumRouteChange('/collections/:c')
    paint()
    setVisibility('hidden')
    sent = []
    clock += 60_000
    setVisibility('visible')
    paint()
    expect(flushed()).toEqual([])
  })

  it('keeps timing the next visible route change after a hidden one', () => {
    setVisibility('hidden')
    rumRouteChange('/a')
    setVisibility('visible')
    paint()
    paint()
    sent = []
    rumRouteChange('/b')
    clock += 9
    paint()
    paint()
    expect(flushed()).toEqual([expect.objectContaining({ route: '/b', duration_ms: 9 })])
  })
})
