// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { CommentPanel } from './CommentPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// army5 b01-N13: a comment typed in the new-record box was dropped on Create
// unless "Queue" was clicked — the form now hears the unsent text.
describe('CommentPanel on a new record', () => {
  it('reports the text still in the box', async () => {
    const client = {
      url: '',
      getToken: () => null,
      request: vi.fn(async () => ({ data: [] }))
    } as unknown as NivaroClient
    const unsent = vi.fn()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <NivaroProvider client={client}>
            <CommentPanel
              collection='workflows'
              item='new'
              defaultExpanded
              queuedComments={[]}
              onQueueComment={vi.fn()}
              onUnsentDraft={unsent}
            />
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    const box = host.querySelector('textarea') as HTMLTextAreaElement
    expect(box).toBeTruthy()
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      set?.call(box, 'Please rush this')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(unsent).toHaveBeenLastCalledWith('Please rush this')
    act(() => root.unmount())
    host.remove()
  })
})
