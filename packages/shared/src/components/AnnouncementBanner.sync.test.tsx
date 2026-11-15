// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import { type RealtimeAdapter, RealtimeContext } from '../lib/realtime'
import { AnnouncementBanner } from './AnnouncementBanner'
import { LiveFigure } from './LiveFigure'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string }

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

const banners = () => host.querySelectorAll('[data-announcements] > div').length
const text = () => host.textContent ?? ''

function fakeRealtime() {
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  const rt: RealtimeAdapter = {
    subscribeCollections: () => () => {},
    on(event, cb) {
      const set = listeners.get(event) ?? new Set()
      set.add(cb)
      listeners.set(event, set)
      return () => set.delete(cb)
    },
    emit() {}
  }
  const fire = (event: string, payload: unknown = {}) => {
    for (const cb of listeners.get(event) ?? []) cb(payload)
  }
  return { rt, fire }
}

async function mount(opts: { ackFails?: boolean } = {}) {
  let server = [{ id: 1, message: 'Planned maintenance tonight', severity: 'info' }]
  const calls: Cmd[] = []
  let releaseAck: (() => void) | null = null
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._method === 'GET' && cmd._path === '/announcements/active') return { data: server }
      if (cmd._method === 'POST' && cmd._path.endsWith('/ack')) {
        await new Promise<void>((r) => {
          releaseAck = r
        })
        if (opts.ackFails) throw new Error('offline')
        server = server.filter((a) => a.id !== 1)
        return { data: { acked: true } }
      }
      return { data: null }
    })
  }
  const { rt, fire } = fakeRealtime()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <RealtimeContext.Provider value={rt}>
            <AnnouncementBanner />
          </RealtimeContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  await settle(() => text().includes('Planned maintenance'))
  return {
    calls,
    fire,
    removeFromServer: () => {
      server = []
    },
    release: () => releaseAck?.()
  }
}

describe('dismissals (#19)', () => {
  it('the banner leaves this tab at once, before the server has answered', async () => {
    const t = await mount()
    expect(text()).toContain('Planned maintenance')
    const dismiss = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Dismiss'
    ) as HTMLButtonElement
    await act(async () => dismiss.click())
    expect(text()).not.toContain('Planned maintenance')
    expect(t.calls.some((c) => c._method === 'POST' && c._path === '/announcements/1/ack')).toBe(
      true
    )
    await act(async () => t.release())
  })

  it('a dismissal that did not reach the server brings the banner back', async () => {
    const t = await mount({ ackFails: true })
    const dismiss = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Dismiss'
    ) as HTMLButtonElement
    await act(async () => dismiss.click())
    expect(text()).not.toContain('Planned maintenance')
    await act(async () => t.release())
    await settle(() => text().includes('Planned maintenance'))
    expect(text()).toContain('Planned maintenance')
  })

  it('a dismissal made in another tab or device drops the banner here (announcements:changed)', async () => {
    const t = await mount()
    // The other tab dismissed it: the server no longer lists it for this person.
    t.removeFromServer()
    await act(async () => t.fire('announcements:changed', { dismissed: true }))
    await settle(() => !text().includes('Planned maintenance'))
    expect(text()).not.toContain('Planned maintenance')
  })
})

describe('LiveFigure', () => {
  it('shows the figure, and fades once when it changes — never on first paint', async () => {
    const animate = vi.fn()
    ;(HTMLElement.prototype as unknown as { animate: unknown }).animate = animate
    try {
      await act(async () => root.render(<LiveFigure value={3} />))
      expect(host.textContent).toBe('3')
      expect(animate).not.toHaveBeenCalled()
      await act(async () => root.render(<LiveFigure value={4} />))
      expect(host.textContent).toBe('4')
      expect(animate).toHaveBeenCalledTimes(1)
      await act(async () => root.render(<LiveFigure value={4} />))
      expect(animate).toHaveBeenCalledTimes(1)
    } finally {
      delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate
    }
  })
})
