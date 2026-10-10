// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OUTSIDE_CAPTURE_ATTR,
  outsideCaptureHost,
  releaseOutsideHost,
  restrictCaptureToPage
} from './captureRestriction'

type Win = Window & { RestrictionTarget?: unknown }

function track(surface: string, restrictTo?: (t: unknown) => Promise<void>) {
  return {
    getSettings: () => ({ displaySurface: surface }),
    ...(restrictTo ? { restrictTo } : {})
  } as unknown as MediaStreamTrack
}

function bodyBox(w: number, h: number) {
  vi.spyOn(document.body, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: w,
    height: h
  } as DOMRect)
}

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as Win).RestrictionTarget
  document.body.style.isolation = ''
  document.body.style.backgroundColor = ''
  releaseOutsideHost()
})

describe('restrictCaptureToPage', () => {
  it('restricts a capture of this tab to <body> and undoes the page change on release', async () => {
    const target = { el: 'body' }
    ;(window as Win).RestrictionTarget = { fromElement: vi.fn(async () => target) }
    bodyBox(window.innerWidth, window.innerHeight)
    document.body.style.backgroundColor = 'rgb(10, 20, 30)'
    const restrictTo = vi.fn(async () => undefined)
    const undo = await restrictCaptureToPage(track('browser', restrictTo))
    expect(restrictTo).toHaveBeenCalledWith(target)
    expect(document.body.style.isolation).toBe('isolate')
    // <html> carries <body>'s background so <body> paints its own (captured).
    expect(document.documentElement.style.backgroundColor).toBe('rgb(10, 20, 30)')
    undo?.()
    expect(document.body.style.isolation).toBe('')
    expect(document.documentElement.style.backgroundColor).toBe('')
  })

  it('leaves the capture whole without browser support', async () => {
    bodyBox(window.innerWidth, window.innerHeight)
    expect(
      await restrictCaptureToPage(
        track(
          'browser',
          vi.fn(async () => undefined)
        )
      )
    ).toBeNull()
  })

  it('leaves a window or screen capture whole', async () => {
    ;(window as Win).RestrictionTarget = { fromElement: vi.fn(async () => ({})) }
    bodyBox(window.innerWidth, window.innerHeight)
    const restrictTo = vi.fn(async () => undefined)
    expect(await restrictCaptureToPage(track('monitor', restrictTo))).toBeNull()
    expect(restrictTo).not.toHaveBeenCalled()
  })

  it('leaves the capture whole when <body> does not fill the viewport', async () => {
    ;(window as Win).RestrictionTarget = { fromElement: vi.fn(async () => ({})) }
    bodyBox(window.innerWidth, window.innerHeight + 400)
    const restrictTo = vi.fn(async () => undefined)
    expect(await restrictCaptureToPage(track('browser', restrictTo))).toBeNull()
    expect(restrictTo).not.toHaveBeenCalled()
  })

  it('puts the page back when the browser refuses (another tab was picked)', async () => {
    ;(window as Win).RestrictionTarget = { fromElement: vi.fn(async () => ({})) }
    bodyBox(window.innerWidth, window.innerHeight)
    const refused = vi.fn(async () => {
      throw new DOMException('not self-capture', 'NotSupportedError')
    })
    expect(await restrictCaptureToPage(track('browser', refused))).toBeNull()
    expect(document.body.style.isolation).toBe('')
  })
})

describe('outsideCaptureHost', () => {
  it('is one element beside <body>, removed on release', () => {
    const a = outsideCaptureHost()
    const b = outsideCaptureHost()
    expect(a).toBe(b)
    expect(a.parentElement).toBe(document.documentElement)
    expect(document.body.contains(a)).toBe(false)
    releaseOutsideHost()
    expect(document.querySelector(`[${OUTSIDE_CAPTURE_ATTR}]`)).toBeNull()
  })
})
