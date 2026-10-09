// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HelpVideoDto } from '../types'
import { PublishButton } from './PublishButton'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const request = vi.fn()
vi.mock('../../../context', () => ({ useNivaroClient: () => ({ request }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// The client sees a command object; the path says which call it is.
vi.mock('../../../lib/commands', () => ({
  get: (path: string) => ({ method: 'GET', path }),
  post: (path: string, body?: unknown) => ({ method: 'POST', path, body }),
  patch: (path: string, body?: unknown) => ({ method: 'PATCH', path, body }),
  put: (path: string, body?: unknown) => ({ method: 'PUT', path, body }),
  del: (path: string) => ({ method: 'DELETE', path })
}))

const video = {
  id: 'v1',
  title: 'Approve a PO',
  status: 'draft',
  contexts: [{ kind: 'page', key: 'home', state_key: null }],
  draft: { id: 'd1' },
  published: null
} as unknown as HelpVideoDto

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  request.mockReset()
  request.mockResolvedValue({ data: {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.replaceChildren()
})

const reload = vi.fn()

async function publishWith(flush: () => Promise<boolean>, conflict = false) {
  const onPublished = vi.fn()
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(PublishButton, {
          video,
          beforePublish: flush,
          onPublished,
          conflict,
          onReload: reload
        })
      )
    )
  })
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-hv-publish]')?.click()
  })
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[data-hv-publish-confirm]')?.click()
  })
  return onPublished
}

describe('PublishButton', () => {
  it('publishes and reloads the draft once the save landed', async () => {
    const onPublished = await publishWith(async () => true)
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/help-videos/v1/publish' })
    )
    expect(onPublished).toHaveBeenCalledTimes(1)
  })

  it('does not publish when the editor could not save, and says why', async () => {
    const onPublished = await publishWith(async () => false)
    expect(request).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: '/help-videos/v1/publish' })
    )
    expect(onPublished).not.toHaveBeenCalled()
    expect(document.querySelector('[data-hv-publish-note]')?.textContent).toContain(
      "Your latest edits haven't saved yet"
    )
  })

  it('after a conflict it says the draft changed elsewhere and offers Reload', async () => {
    await publishWith(async () => false, true)
    expect(document.querySelector('[data-hv-publish-note]')?.textContent).toContain(
      'changed somewhere else'
    )
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-hv-reload]')?.click()
    })
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
