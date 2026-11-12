// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import type { NotificationRouteMap } from '../lib/notification-target'
import { type BellNotification, NotificationBell } from './NotificationBell'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const row = (over: Partial<BellNotification>): BellNotification => ({
  id: 1,
  title: 'Monitor failing: Live updates late',
  message: 'Realtime delivery under 95% within 2000 ms on 1 node',
  read: true,
  created_at: new Date().toISOString(),
  collection: null,
  item: null,
  target: null,
  url: null,
  lane: 'critical',
  category: 'system',
  ...over
})

const routes: NotificationRouteMap = { record: (c, i) => `/records/${c}/${i}` }

async function openBell(rows: BellNotification[]) {
  const calls: Array<{ method: string; path: string }> = []
  const client = {
    request: vi.fn(async (cmd: { _method?: string; _path?: string }) => {
      const path = String(cmd?._path ?? '')
      calls.push({ method: String(cmd?._method ?? 'GET'), path })
      if (path === '/notifications') return { data: rows, bundles: [], pinned: [] }
      if (/unread|count/.test(path))
        return { unread: 0, attention: 0, lanes: { critical: 0, needs_you: 0, fyi: 0 } }
      return {}
    })
  }
  const navigate = vi.fn()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <NotificationBell routes={routes} onNavigate={navigate} tabBadge={false} />
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  await act(async () => {
    ;(host.querySelector('button[aria-label^="Notifications"]') as HTMLButtonElement).click()
  })
  // Let the list query settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  return {
    host,
    navigate,
    calls,
    cleanup: () => {
      act(() => root.unmount())
      host.remove()
    }
  }
}

describe('NotificationBell — a row with nowhere to go', () => {
  it('is plain text, not a button (a monitor notice with no target)', async () => {
    const { host, navigate, cleanup } = await openBell([row({ id: 1 })])
    const el = host.querySelector('[data-notification-row="1"]') as HTMLElement
    expect(el).not.toBeNull()
    expect(el.textContent).toContain('Monitor failing: Live updates late')
    // Not a control: nothing for a click (or the dead-click detector) to land on.
    expect(el.tagName).toBe('DIV')
    expect(el.closest('button, a, [role="button"]')).toBeNull()
    expect(el.querySelector('button, a, [role="button"]')).toBeNull()
    await act(async () => {
      el.click()
    })
    expect(navigate).not.toHaveBeenCalled()
    cleanup()
  })

  it('keeps a real Mark read button on an unread plain row', async () => {
    const { host, calls, cleanup } = await openBell([row({ id: 2, read: false })])
    const el = host.querySelector('[data-notification-row="2"]') as HTMLElement
    expect(el.tagName).toBe('DIV')
    const mark = el.querySelector('button[aria-label="Mark read"]') as HTMLButtonElement
    expect(mark).not.toBeNull()
    await act(async () => {
      mark.click()
    })
    expect(calls.some((c) => c.method !== 'GET' && /notifications/.test(c.path))).toBe(true)
    cleanup()
  })

  it('stays a button when the row opens something', async () => {
    const { host, navigate, cleanup } = await openBell([
      row({
        id: 3,
        title: 'Monitor failing: Live updates late',
        target: { kind: 'external', url: `${window.location.origin}/health/monitors` }
      })
    ])
    const el = host.querySelector('[data-notification-row="3"]') as HTMLElement
    expect(el.tagName).toBe('BUTTON')
    await act(async () => {
      el.click()
    })
    expect(navigate).toHaveBeenCalledWith('/health/monitors')
    cleanup()
  })
})
