// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import { NotificationBell } from './NotificationBell'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// R8 (realtime gaps 2026-11-17): the bell said "Nothing needs you right now" before its list
// had arrived, on first open and on each lane switch.
describe('NotificationBell while its list loads', () => {
  it('shows a skeleton, never the empty message, until the list answers', async () => {
    let answer: (v: unknown) => void = () => {}
    const client = {
      request: vi.fn(async (cmd: { _path?: string }) => {
        const path = String(cmd?._path ?? '')
        if (path === '/notifications')
          return new Promise((r) => {
            answer = r
          })
        return { unread: 0, attention: 0, lanes: { critical: 0, needs_you: 0, fyi: 0 } }
      })
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <NotificationBell routes={{}} onNavigate={vi.fn()} tabBadge={false} />
          </NivaroProvider>
        </QueryClientProvider>
      )
    })
    await act(async () => {
      ;(host.querySelector('button[aria-label^="Notifications"]') as HTMLButtonElement).click()
    })
    const text = () => document.body.textContent ?? ''
    expect(document.querySelector('[data-notification-loading]')).not.toBeNull()
    expect(text()).not.toContain('Nothing needs you right now.')
    await act(async () => {
      answer({ data: [], bundles: [], pinned: [] })
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(document.querySelector('[data-notification-loading]')).toBeNull()
    expect(text()).toContain('Nothing needs you right now.')
    act(() => root.unmount())
    host.remove()
  })
})
