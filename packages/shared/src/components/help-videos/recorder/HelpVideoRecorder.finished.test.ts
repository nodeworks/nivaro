// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// I1: a recording that finished uploading but was never saved as a video (a
// closed tab, a failed save) is offered as "Save it": the video is created
// (or re-recorded) straight from it, with no parts and no second finalize.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const request = vi.fn()
vi.mock('../../../context', () => ({
  useNivaroClient: () => ({ request }),
  useApiFetchConfig: () => ({ baseUrl: '', headers: {} })
}))
vi.mock('../../../lib/commands', () => ({
  get: (path: string) => ({ method: 'GET', path }),
  post: (path: string, body?: unknown) => ({ method: 'POST', path, body }),
  patch: (path: string, body?: unknown) => ({ method: 'PATCH', path, body }),
  put: (path: string, body?: unknown) => ({ method: 'PUT', path, body }),
  del: (path: string) => ({ method: 'DELETE', path })
}))

const { HelpVideoRecorder } = await import('./HelpVideoRecorder')

const LONG_AGO = '2026-10-01T09:30:00.000Z'
const finishedUpload = {
  id: 'u1',
  mime: 'video/webm',
  bytes_received: 4_000_000,
  next_part: 3,
  status: 'finalized',
  duration_ms: 65_000,
  created_at: LONG_AGO,
  updated_at: LONG_AGO
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  request.mockReset()
  request.mockImplementation(async (cmd: { method: string; path: string }) => {
    if (cmd.path === '/help-videos/uploads/mine') return { data: [finishedUpload] }
    if (cmd.method === 'POST' && cmd.path === '/help-videos') return { data: { id: 'v9' } }
    if (cmd.path === '/help-videos/vid1/rerecord') return { data: { id: 'ver2' } }
    if (cmd.path === '/help-videos/vid1') return { data: { id: 'vid1' } }
    throw new Error(`unexpected ${cmd.method} ${cmd.path}`)
  })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia: vi.fn(), enumerateDevices: async () => [] }
  })
  ;(globalThis as { MediaRecorder?: unknown }).MediaRecorder = class {}
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.replaceChildren()
})

async function open(props: { videoId?: string } = {}) {
  const onDone = vi.fn()
  await act(async () => {
    root.render(
      createElement(HelpVideoRecorder, {
        open: true,
        onClose: () => {},
        onDone,
        contexts: [{ kind: 'page', key: 'home', state_key: null }],
        ...props
      })
    )
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  return onDone
}

const paths = () => request.mock.calls.map(([c]) => `${c.method} ${c.path}`)

describe('a finished recording never saved', () => {
  it('is offered as ready to save, with when and how long', async () => {
    await open()
    const section = document.querySelector('[data-hv-finished]')
    expect(section?.textContent).toContain('A recording is ready to save')
    expect(section?.textContent).toContain('1:05 long')
    expect(section?.querySelector('[data-hv-save-finished]')?.textContent).toBe('Save it')
    // not shown as interrupted or as unsaveable
    expect(document.querySelector('[data-hv-leftovers]')).toBeNull()
    expect(document.querySelector('[data-hv-unsaveable]')).toBeNull()
  })

  it('Save it creates the video from it without finalizing again', async () => {
    const onDone = await open()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-hv-save-finished]')?.click()
    })
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/help-videos',
        body: expect.objectContaining({
          upload_id: 'u1',
          contexts: [{ kind: 'page', key: 'home', state_key: null }]
        })
      })
    )
    expect(paths().some((p) => p.includes('/finalize') || p.includes('/parts/'))).toBe(false)
    expect(onDone).toHaveBeenCalledWith({ id: 'v9' })
  })

  it('when re-recording, it becomes the new recording of that video', async () => {
    const onDone = await open({ videoId: 'vid1' })
    const btn = document.querySelector<HTMLButtonElement>('[data-hv-save-finished]')
    expect(btn?.textContent).toBe('Use it')
    await act(async () => {
      btn?.click()
    })
    expect(paths()).toContain('POST /help-videos/vid1/rerecord')
    expect(paths()).not.toContain('POST /help-videos')
    expect(onDone).toHaveBeenCalledWith({ id: 'vid1' })
  })

  it('Discard asks first, then discards it on the server', async () => {
    request.mockImplementation(async (cmd: { method: string; path: string }) =>
      cmd.path === '/help-videos/uploads/mine' ? { data: [finishedUpload] } : {}
    )
    await open()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-hv-finished] [data-hv-discard]')?.click()
    })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-hv-discard-confirm]')?.click()
    })
    expect(paths()).toContain('DELETE /help-videos/uploads/u1')
    expect(document.querySelector('[data-hv-finished]')).toBeNull()
  })
})
