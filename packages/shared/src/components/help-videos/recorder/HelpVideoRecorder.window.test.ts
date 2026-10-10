// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Recording window at a fixed size (#1516): the opener hands its setup to a
// popup and shows its status; the popup records itself and hands the video
// back; a blocked popup falls back to recording in this tab.
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
  mark: () => true,
  meta: () => ({ duration_ms: 1000, clicks: null, levels: null, marks: [] }),
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

// jsdom has no BroadcastChannel: one in-process bus stands in.
type Listener = (e: { data: unknown }) => void
const bus = new Set<FakeChannel>()
class FakeChannel {
  onmessage: Listener | null = null
  constructor(public name: string) {
    bus.add(this)
  }
  postMessage(data: unknown) {
    for (const c of bus) if (c !== this && c.name === this.name) c.onmessage?.({ data })
  }
  close() {
    bus.delete(this)
  }
}
;(globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeChannel
/** Posts as the other side would. */
const postAs = (data: unknown) => new FakeChannel('nvr-help-video-recording').postMessage(data)

const { HelpVideoRecorder } = await import('./HelpVideoRecorder')
const { takeRecordingHandoff } = await import('./HelpVideoRecordingProvider')
const { resetCleanRecordingForTests } = await import('./cleanRecording')
const { handoffKey, resultKey, writeHandoff } = await import('./recordingWindow')

const q = <T extends Element>(s: string) => document.querySelector<T>(s)
const text = (s: string) => q(s)?.textContent ?? null
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
const handoffKeys = () =>
  Object.keys(window.localStorage).filter((k) => k.startsWith('nvr_hv_handoff_'))

let host: HTMLDivElement
let root: Root
let opened: Array<{ url: string; name: string; features: string }>
let fakeWin: { closed: boolean; focus: ReturnType<typeof vi.fn> } | null
const onDone = vi.fn()
const onClose = vi.fn()

beforeEach(() => {
  live = false
  releaseCountdown = null
  opened = []
  fakeWin = { closed: false, focus: vi.fn() }
  onDone.mockReset()
  onClose.mockReset()
  request.mockReset()
  request.mockImplementation(async (cmd: { method: string; path: string }) => {
    if (cmd.path === '/help-videos/uploads/mine') return { data: [] }
    if (cmd.method === 'POST' && cmd.path === '/help-videos/uploads')
      return { data: { id: 'up1', next_part: 0 } }
    if (cmd.method === 'POST' && cmd.path === '/help-videos') return { data: { id: 'v1' } }
    if (cmd.method === 'GET' && cmd.path === '/help-videos/v1')
      return { data: { id: 'v1', title: 'Made in the window' } }
    return { data: {} }
  })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia: vi.fn(), enumerateDevices: async () => [] }
  })
  ;(globalThis as { MediaRecorder?: unknown }).MediaRecorder = class {}
  window.open = vi.fn((url: string | URL = '', name = '', features = '') => {
    opened.push({ url: String(url), name, features })
    return fakeWin as unknown as Window
  }) as never
  window.resizeTo = vi.fn()
  window.close = vi.fn()
  window.name = ''
  window.localStorage.clear()
  bus.clear()
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

async function render(props: Record<string, unknown> = {}) {
  await act(async () => {
    root.render(createElement(HelpVideoRecorder, { open: true, onClose, onDone, ...props }))
  })
  await flush()
}

function type(el: HTMLTextAreaElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function openWindow() {
  await act(async () => {
    q<HTMLButtonElement>('[data-hv-open-window]')?.click()
  })
  await flush()
}

describe('the opener', () => {
  it('opens the page again as a popup of the chosen size and hands its setup over', async () => {
    window.localStorage.setItem('nvr_hv_record_window', '1440x900')
    await render({
      defaultTitle: 'Approve a request',
      contexts: [{ kind: 'page', key: 'my-work' }]
    })
    expect(q('[data-hv-window-section]')).not.toBeNull()
    await act(async () => {
      type(q<HTMLTextAreaElement>('[data-hv-script]') as HTMLTextAreaElement, 'One\nTwo')
    })
    await openWindow()
    expect(opened).toHaveLength(1)
    const { url, name, features } = opened[0]
    expect(name).toBe('nvr-recording')
    expect(features).toBe('popup,width=1440,height=900')
    const token = new URL(url).searchParams.get('nvr-record') as string
    expect(token).toBeTruthy()
    expect(new URL(url).origin).toBe(window.location.origin)
    const h = JSON.parse(window.localStorage.getItem(handoffKey(token)) as string)
    expect(h).toMatchObject({
      v: 1,
      token,
      size: { w: 1440, h: 900 },
      defaultTitle: 'Approve a request',
      contexts: [{ kind: 'page', key: 'my-work' }],
      options: { useMic: true, cleanScreen: true, script: 'One\nTwo' }
    })
    // The main tab shows status only.
    expect(q('[data-hv-recorder]')?.getAttribute('data-hv-stage')).toBe('remote')
    expect(text('[data-hv-remote-sentence]')).toBe('Waiting for the recording window to open.')
    expect(q('[data-hv-start]')).toBeNull()
    await act(async () => {
      q<HTMLButtonElement>('[data-hv-remote-focus]')?.click()
    })
    expect(fakeWin?.focus).toHaveBeenCalled()
  })

  it('shows what the window reports, then opens the editor on the video it made', async () => {
    await render()
    await openWindow()
    const token = new URL(opened[0].url).searchParams.get('nvr-record') as string
    await act(async () => {
      postAs({
        token,
        type: 'status',
        stage: 'recording',
        elapsed: 65_000,
        paused: false,
        pending: 0,
        size: { w: 1264, h: 780 }
      })
    })
    expect(text('[data-hv-remote-sentence]')).toBe('Recording, 1:05 so far.')
    expect(text('[data-hv-remote-mismatch]')).toContain('1264 × 780, not 1280 × 800')
    // Another window's messages are not ours.
    await act(async () => {
      postAs({ token: 'someone-else', type: 'done', videoId: 'v2' })
    })
    expect(onDone).not.toHaveBeenCalled()
    await act(async () => {
      postAs({ token, type: 'done', videoId: 'v1' })
    })
    await flush()
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ id: 'v1' }))
    expect(handoffKeys()).toEqual([])
  })

  it('comes back to the setup when the window closes without a recording', async () => {
    await render()
    await openWindow()
    const token = new URL(opened[0].url).searchParams.get('nvr-record') as string
    await act(async () => {
      postAs({ token, type: 'closed' })
    })
    expect(q('[data-hv-start]')).not.toBeNull()
    expect(text('[data-hv-setup-error]')).toContain('recording window was closed')
  })

  it('notices a window that just disappears, and takes the result it left', async () => {
    await render()
    await openWindow()
    const token = new URL(opened[0].url).searchParams.get('nvr-record') as string
    window.localStorage.setItem(resultKey(token), JSON.stringify({ videoId: 'v1' }))
    ;(fakeWin as { closed: boolean }).closed = true
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1100))
    })
    await flush()
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ id: 'v1' }))
  })

  it('falls back to this tab when the popup is blocked', async () => {
    fakeWin = null
    await render()
    await openWindow()
    expect(q('[data-hv-start]')).not.toBeNull()
    expect(text('[data-hv-setup-error]')).toContain('blocked the recording window')
    expect(handoffKeys()).toEqual([])
  })
})

const handoff = () => ({
  v: 1 as const,
  token: 'tok-popup-1234',
  at: Date.now(),
  size: { w: 1280, h: 800 },
  defaultTitle: 'From the opener',
  options: {
    useMic: false,
    micId: 'default',
    captureClicks: true,
    cleanScreen: false,
    script: 'Open the record\nPress Approve'
  }
})

describe('the recording window', () => {
  it('opens with the setup carried over, sized, locked to this window', async () => {
    window.name = 'nvr-recording'
    await render({ handoff: handoff() })
    expect(window.resizeTo).toHaveBeenCalled()
    expect(q('[data-hv-recorder]')?.getAttribute('data-hv-popup')).toBe('1')
    expect(q('[data-hv-popup-note]')).not.toBeNull()
    expect(q('[data-hv-source]')).toBeNull()
    expect(q('[data-hv-window-section]')).toBeNull() // never a window from a window
    expect(q<HTMLTextAreaElement>('[data-hv-script]')?.value).toBe('Open the record\nPress Approve')
    expect(q('[data-hv-use-mic]')?.getAttribute('data-state')).toBe('unchecked')
    expect(q('[data-hv-clean-screen]')?.getAttribute('data-state')).toBe('unchecked')
  })

  it('reports its status to the opener and, once saved, hands the video over and closes', async () => {
    const seen: unknown[] = []
    const opener = new FakeChannel('nvr-help-video-recording')
    opener.onmessage = (e) => seen.push(e.data)
    await render({ handoff: handoff() })
    expect(seen).toContainEqual(expect.objectContaining({ type: 'status', stage: 'setup' }))
    await act(async () => {
      q<HTMLButtonElement>('[data-hv-start]')?.click()
    })
    await flush()
    expect(seen.at(-1)).toMatchObject({ type: 'status', stage: 'countdown' })
    await act(async () => {
      releaseCountdown?.(true)
    })
    await flush()
    expect(q('[data-hv-frame-size]')?.textContent).toContain('×')
    expect(seen.at(-1)).toMatchObject({ type: 'status', stage: 'recording' })
    await act(async () => {
      q<HTMLButtonElement>('[data-hv-stop]')?.click()
    })
    await flush()
    expect(seen).toContainEqual({ token: 'tok-popup-1234', type: 'done', videoId: 'v1' })
    expect(window.localStorage.getItem(resultKey('tok-popup-1234'))).toBe('{"videoId":"v1"}')
    expect(window.close).toHaveBeenCalled()
    const create = request.mock.calls
      .map((c) => c[0] as { method: string; path: string; body?: Record<string, unknown> })
      .find((c) => c.method === 'POST' && c.path === '/help-videos')
    expect(create?.body).toMatchObject({ title: 'From the opener' })
  })

  it('tells the opener when it is closed without a recording', async () => {
    const seen: unknown[] = []
    const opener = new FakeChannel('nvr-help-video-recording')
    opener.onmessage = (e) => seen.push(e.data)
    await render({ handoff: handoff() })
    // The setup panel's Cancel.
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[data-hv-recorder] button')]
    await act(async () => {
      cancel.find((b) => b.textContent === 'Cancel')?.click()
    })
    expect(seen).toContainEqual({ token: 'tok-popup-1234', type: 'closed' })
    expect(window.close).toHaveBeenCalled()
  })
})

describe('takeRecordingHandoff (the provider, on load)', () => {
  it('takes the handoff named in the URL inside a recording window and drops the token', () => {
    const h = handoff()
    writeHandoff(h)
    window.name = 'nvr-recording'
    window.history.replaceState(null, '', `/records/7?tab=notes&nvr-record=${h.token}`)
    expect(takeRecordingHandoff()).toEqual(h)
    expect(window.location.search).toBe('?tab=notes')
    expect(handoffKeys()).toEqual([])
  })
  it('is null in an ordinary tab (the token still leaves the URL) and without a token', () => {
    const h = handoff()
    writeHandoff(h)
    window.name = ''
    window.history.replaceState(null, '', `/records/7?nvr-record=${h.token}`)
    expect(takeRecordingHandoff()).toBeNull()
    expect(window.location.search).toBe('')
    window.history.replaceState(null, '', '/records/7')
    expect(takeRecordingHandoff()).toBeNull()
  })
})
