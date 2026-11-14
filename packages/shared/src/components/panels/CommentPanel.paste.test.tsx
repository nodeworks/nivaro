// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { CommentPanel } from './CommentPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ID = '0a1b2c3d-1111-4222-8333-444455556666'

class FakeXhr {
  static last: FakeXhr | null = null
  upload: { onprogress: ((e: unknown) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  status = 200
  responseText = JSON.stringify({ data: { id: ID } })
  open() {}
  setRequestHeader() {}
  abort() {}
  send() {
    FakeXhr.last = this
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a screenshot pasted into the comment box', () => {
  it('shows a thumbnail, uploads it, and posts it as part of the comment', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    ;(URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:x'
    ;(URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {}
    const posted: unknown[] = []
    const client = {
      url: '',
      fileUrl: (id: string) => `/api/files/${id}`,
      getToken: () => null,
      request: vi.fn(async (cmd: { _method?: string; _path?: string; _body?: unknown }) => {
        if (cmd?._method === 'POST' && String(cmd._path) === '/comments') posted.push(cmd._body)
        return { data: [] }
      })
    } as unknown as NivaroClient
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <NivaroProvider client={client}>
            <CommentPanel collection='workflows' item='7' defaultExpanded />
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    const box = host.querySelector('textarea') as HTMLTextAreaElement
    const png = new File(['x'], 'image.png', { type: 'image/png' })
    const ev = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
      clipboardData: unknown
    }
    ev.clipboardData = { files: [png], getData: () => '' }
    await act(async () => {
      box.dispatchEvent(ev)
    })
    expect(ev.defaultPrevented).toBe(true)
    expect(host.querySelector('[data-comment-image="uploading"]')).toBeTruthy()

    await act(async () => {
      FakeXhr.last?.onload?.()
    })
    expect(host.querySelector('[data-comment-image="done"]')).toBeTruthy()

    const form = host.querySelector('form') as HTMLFormElement
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    const body = posted[0] as { text: string } | undefined
    expect(body?.text).toMatch(new RegExp(`^!\\[screenshot-.*\\.png\\]\\(/api/files/${ID}\\)$`))
    act(() => root.unmount())
    host.remove()
  })

  it('leaves a plain text paste alone', async () => {
    const client = {
      url: '',
      getToken: () => null,
      request: vi.fn(async () => ({ data: [] }))
    } as unknown as NivaroClient
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <NivaroProvider client={client}>
            <CommentPanel collection='workflows' item='7' defaultExpanded />
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    const box = host.querySelector('textarea') as HTMLTextAreaElement
    const ev = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
      clipboardData: unknown
    }
    ev.clipboardData = { files: [], getData: () => 'hello' }
    await act(async () => {
      box.dispatchEvent(ev)
    })
    expect(ev.defaultPrevented).toBe(false)
    expect(host.querySelector('[data-comment-image]')).toBeNull()
    act(() => root.unmount())
    host.remove()
  })
})
