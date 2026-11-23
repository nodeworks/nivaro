// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import { AnnouncementBanner } from './AnnouncementBanner'

// Hub phase 6 parked A M2 (final review M-9): the strict maintenance page is a modal alert dialog,
// so keyboard users land on it and stay on it: its heading takes focus when it appears, and Tab
// never walks out into the frozen app behind it.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 80 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

const row = (maintenance: Record<string, unknown>) => ({
  id: -1,
  message: 'This app is moving to a new home. You can keep reading and browsing.',
  severity: 'critical',
  dismissable: false,
  require_ack: false,
  maintenance: {
    display: 'page',
    until: null,
    headline: 'This app is moving to a new home.',
    explainer: 'The portal is unavailable until maintenance ends.',
    ...maintenance
  }
})

async function mount(data: unknown[]) {
  const client = {
    request: vi.fn(async (cmd: { _method: string; _path: string }) =>
      cmd._method === 'GET' && cmd._path === '/announcements/active' ? { data } : { data: null }
    )
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <AnnouncementBanner />
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  await settle(() => (host.textContent ?? '').includes('moving'))
}

describe('strict maintenance page and the keyboard', () => {
  it('focuses its heading when it appears', async () => {
    const behind = document.createElement('button')
    behind.textContent = 'Save'
    document.body.appendChild(behind)
    behind.focus()
    await mount([row({ strict: true })])
    const heading = host.querySelector('#nvr-strict-maintenance-title') as HTMLElement
    expect(heading).not.toBeNull()
    expect(heading.getAttribute('tabindex')).toBe('-1')
    // Re-review FW3-M2: the focused heading keeps a visible focus ring.
    expect(heading.className.split(/\s+/)).not.toContain('outline-none')
    expect(heading.className).toMatch(/focus-visible:ring/)
    expect(document.activeElement).toBe(heading)
    behind.remove()
  })

  it('Tab keeps focus on the page', async () => {
    await mount([row({ strict: true })])
    const page = host.querySelector('[data-strict-maintenance]') as HTMLElement
    const heading = host.querySelector('#nvr-strict-maintenance-title') as HTMLElement
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    act(() => {
      heading.dispatchEvent(tab)
    })
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(heading)
    expect(page.contains(document.activeElement)).toBe(true)
  })
})
