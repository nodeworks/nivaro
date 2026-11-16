// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startFileUpload, viewAsFetchActive } from './upload-file'

const cfg = { apiBase: '/api', authHeaders: {}, credentials: 'include' as RequestCredentials }
const flag = window as unknown as { __nvrViewAsFetch?: boolean }

afterEach(() => {
  delete flag.__nvrViewAsFetch
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('startFileUpload under View-as', () => {
  it('uploads through window.fetch (which carries the viewed person) and never an XHR', async () => {
    flag.__nvrViewAsFetch = true
    const xhr = vi.fn()
    vi.stubGlobal('XMLHttpRequest', xhr)
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: { id: 'file-9' } }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const done = new Promise<string>((resolve, reject) =>
      startFileUpload(cfg, new File(['x'], 'a.png', { type: 'image/png' }), {
        onDone: resolve,
        onError: reject
      })
    )
    await expect(done).resolves.toBe('file-9')
    expect(viewAsFetchActive()).toBe(true)
    expect(xhr).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/files/upload')
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(FormData)
  })

  it('reports the server refusal and stays quiet on cancel', async () => {
    flag.__nvrViewAsFetch = true
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Too big' }), { status: 413 }))
    )
    const err = await new Promise<string>((resolve) =>
      startFileUpload(cfg, new File(['x'], 'a.png'), { onDone: () => {}, onError: resolve })
    )
    expect(err).toBe('That file is too large to upload.')

    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_u: string, init: RequestInit) =>
          new Promise((_res, rej) => {
            init.signal?.addEventListener('abort', () =>
              rej(new DOMException('aborted', 'AbortError'))
            )
          })
      )
    )
    const onError = vi.fn()
    const up = startFileUpload(cfg, new File(['x'], 'a.png'), { onDone: () => {}, onError })
    up.abort()
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(onError).not.toHaveBeenCalled()
  })

  it('keeps the progress upload (XHR) in an ordinary tab', () => {
    const open = vi.fn()
    const send = vi.fn()
    class FakeXhr {
      upload = {} as { onprogress?: unknown }
      open = open
      send = send
      setRequestHeader = vi.fn()
      abort = vi.fn()
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    startFileUpload(cfg, new File(['x'], 'a.png'), { onDone: () => {}, onError: () => {} })
    expect(open).toHaveBeenCalledWith('POST', '/api/files/upload')
    expect(send).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
