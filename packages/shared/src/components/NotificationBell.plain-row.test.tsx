// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import type { NotificationRouteMap } from '../lib/notification-target'
import { type BellNotification, NotificationBell } from './NotificationBell'
import { NotificationCenterView } from './notifications/NotificationCenterView'

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
    // The Mark read slot stays in the layout once the row is read (hidden, out
    // of the tab order): taking it away widened the text and re-wrapped it.
    const controls = [...el.querySelectorAll<HTMLElement>('button, a, [role="button"]')]
    expect(controls).toHaveLength(1)
    expect(controls[0].getAttribute('aria-label')).toBe('Mark read')
    expect(controls[0].className).toContain('invisible')
    expect(controls[0].className).toContain('shrink-0')
    expect(controls[0].tabIndex).toBe(-1)
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
    expect(mark.className).not.toContain('invisible')
    expect(mark.tabIndex).toBe(0)
    // The instant tip, not the browser's slow one.
    expect(mark.dataset.tip).toBe('Mark read')
    expect(mark.hasAttribute('title')).toBe(false)
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

// Design review 2026-11-12: in the notifications centre an unread row with
// nowhere to go was still a row-sized button. Its click only marked the row
// read, so the row dimmed (or left the Unread list) and opened nothing.
describe('NotificationCenterView — a row with nowhere to go', () => {
  async function openCentre(rows: BellNotification[]) {
    const calls: Array<{ method: string; path: string }> = []
    const client = {
      request: vi.fn(async (cmd: { _method?: string; _path?: string }) => {
        const path = String(cmd?._path ?? '')
        calls.push({ method: String(cmd?._method ?? 'GET'), path })
        if (path === '/notifications')
          return { data: rows, bundles: [], pinned: [], total: rows.length }
        if (path === '/notifications/unread-count')
          return { unread: 0, attention: 0, lanes: { critical: 0, needs_you: 0, fyi: 0 } }
        if (path === '/collections') return { data: [] }
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
            <NotificationCenterView routes={routes} onNavigate={navigate} changesId={null} />
          </NivaroProvider>
        </QueryClientProvider>
      )
    })
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
  const writes = (calls: Array<{ method: string; path: string }>) =>
    calls.filter((c) => c.method !== 'GET').map((c) => c.path)

  it('an unread one is plain text with its own Mark read', async () => {
    const { host, navigate, calls, cleanup } = await openCentre([
      row({ id: 5, read: false, lane: 'fyi' })
    ])
    const el = host.querySelector('[data-notification-row="5"]') as HTMLElement
    const plain = el.querySelector('[data-notification-plain]') as HTMLElement
    expect(plain?.tagName).toBe('DIV')
    expect(plain.textContent).toContain('Monitor failing: Live updates late')
    expect(plain.closest('button')).toBeNull()
    // A click on the words does nothing: it neither opens nor marks read.
    await act(async () => {
      plain.click()
    })
    expect(writes(calls)).toEqual([])
    expect(navigate).not.toHaveBeenCalled()

    const mark = el.querySelector('button[data-notification-mark-read="5"]') as HTMLButtonElement
    expect(mark?.textContent).toBe('Mark read')
    await act(async () => {
      mark.click()
    })
    expect(writes(calls)).toEqual(['/notifications/5/read'])
    cleanup()
  })

  it('a read one has no Mark read, and neither lights up under the pointer', async () => {
    const { host, cleanup } = await openCentre([
      row({ id: 6, read: true }),
      row({ id: 7, read: false })
    ])
    for (const id of [6, 7]) {
      const el = host.querySelector(`[data-notification-row="${id}"]`) as HTMLElement
      expect(el.className).toContain('group')
      expect(el.className).not.toContain('hover:bg-slate-50')
    }
    expect(host.querySelector('[data-notification-mark-read="6"]')).toBeNull()
    expect(host.querySelector('[data-notification-mark-read="7"]')).not.toBeNull()
    cleanup()
  })

  it('a row that opens something stays a button, with the hover and no pill', async () => {
    const { host, navigate, cleanup } = await openCentre([
      row({
        id: 8,
        read: false,
        target: { kind: 'external', url: `${window.location.origin}/health/monitors` }
      })
    ])
    const el = host.querySelector('[data-notification-row="8"]') as HTMLElement
    expect(el.className).toContain('hover:bg-slate-50')
    expect(el.querySelector('[data-notification-plain]')).toBeNull()
    expect(el.querySelector('[data-notification-mark-read]')).toBeNull()
    const head = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Monitor failing')
    ) as HTMLButtonElement
    await act(async () => {
      head.click()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(navigate).toHaveBeenCalledWith('/health/monitors')
    cleanup()
  })
})

// Go-live week review (2026-11-12): the bell's sibling controls (a bundle's Open record and
// Mark read, a record group's Open record and Mark read, the "deleted" chip) still used the
// browser's slow `title` tooltip. They use the instant `data-tip`, and the icon-only buttons
// carry their name for a screen reader.
describe('NotificationBell — sibling controls use the instant tip', () => {
  async function openWithBundles() {
    const bundle = (over: Record<string, unknown>) => ({
      collection: 'workflows',
      item: '7',
      label: 'WF-7',
      count: 2,
      unread: 1,
      lane: 'needs_you',
      categories: ['comment'],
      newest: new Date().toISOString(),
      url: null,
      ids: [11, 12],
      rows: [
        row({ id: 11, read: false, collection: 'workflows', item: '7' }),
        row({ id: 12, read: true, collection: 'workflows', item: '7' })
      ],
      ...over
    })
    const rows = [
      row({ id: 21, read: false, collection: 'regions', item: '3', category: 'comment' }),
      row({ id: 22, read: false, collection: 'regions', item: '3', category: 'comment' })
    ]
    const client = {
      request: vi.fn(async (cmd: { _path?: string }) => {
        const path = String(cmd?._path ?? '')
        if (path === '/notifications')
          return {
            data: rows,
            bundles: [bundle({}), bundle({ item: '8', label: 'WF-8', deleted: true })],
            pinned: []
          }
        if (/unread|count/.test(path))
          return { unread: 0, attention: 0, lanes: { critical: 0, needs_you: 0, fyi: 0 } }
        return {}
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
            <NotificationBell routes={routes} onNavigate={vi.fn()} tabBadge={false} />
          </NivaroProvider>
        </QueryClientProvider>
      )
    })
    await act(async () => {
      ;(host.querySelector('button[aria-label^="Notifications"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    return () => {
      act(() => root.unmount())
      host.remove()
    }
  }

  it('no control in the open bell carries a native title', async () => {
    const cleanup = await openWithBundles()
    const bundleEl = document.querySelector('[data-notification-bundle]') as HTMLElement
    expect(bundleEl).not.toBeNull()
    // Nothing in the bell's popover falls back to the browser's slow tooltip.
    expect([...document.querySelectorAll('[title]')].map((e) => e.outerHTML.slice(0, 300))).toEqual(
      []
    )

    const tip = (sel: string) =>
      [...document.querySelectorAll<HTMLElement>(sel)].map((e) => [
        e.dataset.tip,
        e.getAttribute('aria-label')
      ])
    expect(tip('[data-notification-bundle-read]')).toContainEqual(['Mark read', 'Mark read'])
    expect(tip('[data-notification-open-record]')).toContainEqual(['Open record', 'Open record'])
    const deleted = document.querySelector(
      '[data-notification-bundle-deleted="true"] [data-notification-bundle-gone]'
    ) as HTMLElement
    expect(deleted?.dataset.tip).toBe('This record has since been deleted')
    cleanup()
  })
})
