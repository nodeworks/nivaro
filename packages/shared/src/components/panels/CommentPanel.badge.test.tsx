// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { CommentPanel } from './CommentPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Army 6 L6: the Comments header said "2" over one comment (37807, 37805) — a system entry
// in the thread was counted. The badge counts what people wrote; the thread keeps the rest.
describe('CommentPanel badge', () => {
  it('counts people comments only', async () => {
    const client = {
      url: '',
      getToken: () => null,
      request: vi.fn(async (cmd: { _path?: string }) => {
        const path = String(cmd?._path ?? '')
        if (path.includes('/comments/related'))
          return {
            data: [
              {
                id: 'reason:1',
                source: 'change_reason',
                label: 'Change reason',
                text: 'Quote went up',
                user: 'U-2',
                user_name: 'Peter Moniz',
                created_at: '2026-11-06T16:00:00Z'
              }
            ]
          }
        if (path.includes('/comments'))
          return {
            data: [
              {
                id: 'c1',
                text: 'Please rush this',
                user: 'U-1',
                created_at: '2026-11-06T15:00:00Z'
              }
            ]
          }
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
            <CommentPanel collection='inventory_request' item='37807' />
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    for (let i = 0; i < 20 && !host.querySelector('[data-notes-badge]'); i++)
      await act(async () => new Promise((r) => setTimeout(r, 10)))
    expect(host.querySelector('[data-notes-badge]')?.textContent).toBe('1')
    act(() => root.unmount())
    host.remove()
  })
})
