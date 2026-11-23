// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import { AnnouncementBanner } from './AnnouncementBanner'

// Hub phase 6 parked wave (T9): under the Hub's STRICT maintenance (a move) nobody is exempt from
// the write freeze, administrators included. The banner then replaces the app with the full page
// for everyone, instead of the strip an exempt admin gets (which left them in an app whose every
// save answered 503).
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

describe('strict maintenance', () => {
  it('shows the full page (headline + explainer), not the strip, and offers no dismiss', async () => {
    await mount([row({ strict: true })])
    const page = host.querySelector('[data-strict-maintenance]')
    expect(page).not.toBeNull()
    expect(page?.getAttribute('role')).toBe('alertdialog')
    expect(page?.textContent).toContain('This app is moving to a new home.')
    expect(page?.textContent).toContain('The portal is unavailable until maintenance ends.')
    // The strip line (with its "keep browsing" text) is not rendered beside the page.
    expect(host.textContent).not.toContain('You can keep reading and browsing')
    expect(host.querySelectorAll('button').length).toBe(0)
  })

  it('names when it is expected back, when the Hub said', async () => {
    await mount([row({ strict: true, until: '2026-11-22T20:40:00.000Z' })])
    expect(host.querySelector('[data-strict-maintenance]')?.textContent).toContain(
      'Expected back around'
    )
  })

  it('an ordinary freeze (no strict) keeps the strip — admins stay exempt there', async () => {
    await mount([row({})])
    expect(host.querySelector('[data-strict-maintenance]')).toBeNull()
    expect(host.textContent).toContain('You can keep reading and browsing')
  })

  it('other banners still show as strips under the page', async () => {
    await mount([
      row({ strict: true }),
      { id: 7, message: 'Planned upgrade Friday', severity: 'info' }
    ])
    expect(host.querySelector('[data-strict-maintenance]')).not.toBeNull()
    expect(host.textContent).toContain('Planned upgrade Friday')
  })
})
