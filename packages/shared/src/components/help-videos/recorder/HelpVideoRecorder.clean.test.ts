// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #1515: the recorder holds clean mode from the countdown to the stop, and
// lets go on cancel, stop and unmount; the setup switch turns it off.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const request = vi.fn()
vi.mock('../../../context', async (orig) => ({
  ...(await orig<typeof import('../../../context')>()),
  useNivaroClient: () => ({ request }),
  useApiFetchConfig: () => ({ apiBase: '', baseUrl: '', headers: {}, authHeaders: {} })
}))
vi.mock('../../../lib/commands', () => ({
  get: (path: string) => ({ method: 'GET', path }),
  post: (path: string, body?: unknown) => ({ method: 'POST', path, body }),
  patch: (path: string, body?: unknown) => ({ method: 'PATCH', path, body }),
  put: (path: string, body?: unknown) => ({ method: 'PUT', path, body }),
  del: (path: string) => ({ method: 'DELETE', path })
}))

// A stand-in capture: the countdown waits for the test, nothing is recorded.
let live = false
let releaseCountdown: ((go: boolean) => void) | null = null
const cap = {
  count: 3,
  elapsed: 0,
  paused: false,
  muted: false,
  hasMic: false,
  micMissing: false,
  announce: '',
  isLive: () => live,
  reset: () => {},
  acquire: async () => 'video/webm',
  arm: () => {},
  countdown: () =>
    new Promise<boolean>((r) => {
      releaseCountdown = r
    }),
  begin: () => {
    live = true
  },
  meta: () => ({ duration_ms: 1000, clicks: null, levels: null }),
  halt: async () => {
    live = false
  },
  cancel: () => {
    releaseCountdown?.(false)
    return true
  },
  release: () => {},
  togglePause: () => {},
  toggleMute: () => {}
}
vi.mock('./useScreenCapture', async (orig) => ({
  ...(await orig<typeof import('./useScreenCapture')>()),
  useScreenCapture: () => cap
}))

const { HelpVideoRecorder } = await import('./HelpVideoRecorder')
const { resetCleanRecordingForTests } = await import('./cleanRecording')

const clean = () => document.documentElement.hasAttribute('data-nvr-recording-clean')
const q = <T extends Element>(s: string) => document.querySelector<T>(s)
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  live = false
  releaseCountdown = null
  request.mockReset()
  request.mockImplementation(async (cmd: { method: string; path: string }) => {
    if (cmd.path === '/help-videos/uploads/mine') return { data: [] }
    if (cmd.method === 'POST' && cmd.path === '/help-videos/uploads')
      return { data: { id: 'up1', next_part: 0 } }
    if (cmd.method === 'POST' && cmd.path === '/help-videos') return { data: { id: 'v1' } }
    return { data: {} }
  })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia: vi.fn(), enumerateDevices: async () => [] }
  })
  ;(globalThis as { MediaRecorder?: unknown }).MediaRecorder = class {}
  window.localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.replaceChildren()
  resetCleanRecordingForTests()
})

async function openAndStart() {
  await act(async () => {
    root.render(
      createElement(HelpVideoRecorder, { open: true, onClose: () => {}, onDone: () => {} })
    )
  })
  await flush()
  expect(clean()).toBe(false) // the setup panel is not recorded
  await act(async () => {
    q<HTMLButtonElement>('[data-hv-start]')?.click()
  })
  await flush()
}

describe('clean recording mode in the recorder', () => {
  it('is on by default in the setup panel', async () => {
    await act(async () => {
      root.render(
        createElement(HelpVideoRecorder, { open: true, onClose: () => {}, onDone: () => {} })
      )
    })
    expect(q('[data-hv-clean-screen]')?.getAttribute('data-state')).toBe('checked')
  })

  it('holds from the countdown through recording and lets go on stop', async () => {
    await openAndStart()
    expect(q('[data-hv-countdown]')).not.toBeNull()
    expect(clean()).toBe(true)
    await act(async () => {
      releaseCountdown?.(true)
    })
    await flush()
    expect(q('[data-hv-stop]')).not.toBeNull()
    expect(clean()).toBe(true)
    await act(async () => {
      q<HTMLButtonElement>('[data-hv-stop]')?.click()
    })
    await flush()
    expect(clean()).toBe(false)
  })

  it('lets go when the countdown is cancelled', async () => {
    await openAndStart()
    expect(clean()).toBe(true)
    await act(async () => {
      q<HTMLButtonElement>('[aria-label="Cancel recording"]')?.click()
    })
    await flush()
    expect(q('[data-hv-start]')).not.toBeNull()
    expect(clean()).toBe(false)
  })

  it('lets go when the recorder unmounts mid-recording', async () => {
    await openAndStart()
    await act(async () => {
      releaseCountdown?.(true)
    })
    await flush()
    expect(clean()).toBe(true)
    act(() => root.unmount())
    expect(clean()).toBe(false)
    root = createRoot(host) // afterEach unmounts again
  })

  it('stays off when the switch is turned off, and remembers it', async () => {
    await act(async () => {
      root.render(
        createElement(HelpVideoRecorder, { open: true, onClose: () => {}, onDone: () => {} })
      )
    })
    await act(async () => {
      q<HTMLButtonElement>('[data-hv-clean-screen]')?.click()
    })
    expect(window.localStorage.getItem('nvr_hv_clean_screen')).toBe('0')
    await act(async () => {
      q<HTMLButtonElement>('[data-hv-start]')?.click()
    })
    await flush()
    expect(q('[data-hv-countdown]')).not.toBeNull()
    expect(clean()).toBe(false)
  })
})
