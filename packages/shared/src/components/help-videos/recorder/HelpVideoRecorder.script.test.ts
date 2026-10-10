// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Script mode (#1491): the steps typed in the setup panel show on the bar as
// a teleprompter while recording, Next (button or Alt+Shift+N) marks the step,
// and the marks and the script go up with finalize. A re-record offers the
// draft's script again.
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

// A stand-in capture: the countdown waits for the test, marks are counted.
let live = false
let releaseCountdown: ((go: boolean) => void) | null = null
const marks: Array<{ t_ms: number; step: number }> = []
const cap = {
  count: 3,
  elapsed: 0,
  paused: false,
  muted: false,
  hasMic: false,
  micMissing: false,
  announce: '',
  isLive: () => live,
  reset: () => {
    marks.length = 0
  },
  acquire: async () => 'video/webm',
  arm: () => {},
  countdown: () =>
    new Promise<boolean>((r) => {
      releaseCountdown = r
    }),
  begin: () => {
    live = true
  },
  mark: (step: number) => {
    if (!live) return false
    marks.push({ t_ms: 1000 * (marks.length + 1), step })
    return true
  },
  meta: () => ({ duration_ms: 9000, clicks: null, levels: null, marks: [...marks] }),
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

const q = <T extends Element>(s: string) => document.querySelector<T>(s)
const text = (s: string) => q(s)?.textContent ?? null
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
const finalizeBodies = () =>
  request.mock.calls
    .map((c) => c[0] as { method: string; path: string; body?: unknown })
    .filter((c) => c.method === 'POST' && c.path.endsWith('/finalize'))
    .map((c) => c.body as Record<string, unknown>)

function type(el: HTMLTextAreaElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  live = false
  releaseCountdown = null
  marks.length = 0
  request.mockReset()
  request.mockImplementation(async (cmd: { method: string; path: string }) => {
    if (cmd.path === '/help-videos/uploads/mine') return { data: [] }
    if (cmd.method === 'POST' && cmd.path === '/help-videos/uploads')
      return { data: { id: 'up1', next_part: 0 } }
    if (cmd.method === 'POST' && cmd.path === '/help-videos') return { data: { id: 'v1' } }
    if (cmd.method === 'GET' && cmd.path === '/help-videos/v9')
      return { data: { id: 'v9', draft: { script: ['Open the record', 'Press Approve'] } } }
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

async function render(props: Record<string, unknown> = {}) {
  await act(async () => {
    root.render(
      createElement(HelpVideoRecorder, {
        open: true,
        onClose: () => {},
        onDone: () => {},
        ...props
      })
    )
  })
  await flush()
}

async function startWith(script: string) {
  await act(async () => {
    type(q<HTMLTextAreaElement>('[data-hv-script]') as HTMLTextAreaElement, script)
  })
  await act(async () => {
    q<HTMLButtonElement>('[data-hv-start]')?.click()
  })
  await flush()
  await act(async () => {
    releaseCountdown?.(true)
  })
  await flush()
}

describe('script mode in the recorder', () => {
  it('counts the steps as they are typed and refuses too many', async () => {
    await render()
    expect(q('[data-hv-script]')).not.toBeNull()
    await act(async () => {
      type(q<HTMLTextAreaElement>('[data-hv-script]') as HTMLTextAreaElement, 'One\n\nTwo')
    })
    expect(text('[data-hv-script-count]')).toContain('2 steps')
    expect(q<HTMLButtonElement>('[data-hv-start]')?.disabled).toBe(false)
    await act(async () => {
      type(
        q<HTMLTextAreaElement>('[data-hv-script]') as HTMLTextAreaElement,
        Array.from({ length: 61 }, (_, i) => `S${i}`).join('\n')
      )
    })
    expect(text('[data-hv-script-problem]')).toContain('up to 60 steps')
    expect(q<HTMLButtonElement>('[data-hv-start]')?.disabled).toBe(true)
  })

  it('shows the teleprompter, moves on with Next and the key, and ships the marks', async () => {
    await render()
    await startWith('Open the record\nPress Approve\nCheck the result')
    expect(q('[data-hv-teleprompter]')).not.toBeNull()
    expect(text('[data-hv-step-label]')).toBe('Step 1 of 3')
    expect(text('[data-hv-step-current]')).toBe('Open the record')
    expect(text('[data-hv-step-next]')).toBe('Next: Press Approve')

    await act(async () => {
      q<HTMLButtonElement>('[data-hv-next-step]')?.click()
    })
    expect(text('[data-hv-step-label]')).toBe('Step 2 of 3')
    expect(marks).toEqual([{ t_ms: 1000, step: 1 }])

    // Alt+Shift+N from inside a text field: caught on the window, never typed.
    const field = document.createElement('input')
    document.body.appendChild(field)
    field.focus()
    const key = new KeyboardEvent('keydown', {
      key: 'N',
      code: 'KeyN',
      altKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
    await act(async () => {
      field.dispatchEvent(key)
    })
    expect(key.defaultPrevented).toBe(true)
    expect(text('[data-hv-step-label]')).toBe('Step 3 of 3')
    expect(q('[data-hv-step-next]')).toBeNull()
    expect(q<HTMLButtonElement>('[data-hv-next-step]')?.disabled).toBe(true)

    // The last step: nothing more to mark.
    await act(async () => {
      field.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'KeyN', altKey: true, shiftKey: true })
      )
    })
    expect(marks).toHaveLength(2)

    await act(async () => {
      q<HTMLButtonElement>('[data-hv-stop]')?.click()
    })
    await flush()
    expect(finalizeBodies()).toEqual([
      expect.objectContaining({
        duration_ms: 9000,
        script: ['Open the record', 'Press Approve', 'Check the result'],
        marks: [
          { t_ms: 1000, step: 1 },
          { t_ms: 2000, step: 2 }
        ]
      })
    ])
  })

  it('without a script there is no teleprompter, and finalize carries no marks', async () => {
    await render()
    await startWith('')
    expect(q('[data-hv-teleprompter]')).toBeNull()
    expect(q('[data-hv-stop]')).not.toBeNull()
    await act(async () => {
      q<HTMLButtonElement>('[data-hv-stop]')?.click()
    })
    await flush()
    const [body] = finalizeBodies()
    expect(body).toBeDefined()
    expect('script' in body).toBe(false)
    expect(body.marks).toBeUndefined()
  })

  it("a re-record offers the draft's script again", async () => {
    await render({ videoId: 'v9' })
    expect(q<HTMLTextAreaElement>('[data-hv-script]')?.value).toBe('Open the record\nPress Approve')
    expect(text('[data-hv-script-count]')).toContain('2 steps')
  })
})
