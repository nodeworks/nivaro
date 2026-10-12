// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NavigationContext, NivaroProvider } from '../../context'
import { type RealtimeAdapter, RealtimeContext } from '../../lib/realtime'
import { IncidentBanner, incidentThreadPath } from './IncidentBanner'

// #2016 — the incident banner is for administrators only: a non-admin tab
// never joins the admin room, never asks the admin route and draws nothing.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const INCIDENT = {
  id: 4,
  title: 'Partner pushes failing',
  started_at: new Date(Date.now() - 12 * 60_000).toISOString(),
  room: 'ch:ops',
  root_message_id: 91
}

let root: Root
let host: HTMLDivElement
let current: typeof INCIDENT | null = INCIDENT
const calls: string[] = []
const joined: string[] = []
const listeners = new Map<string, Array<(p: unknown) => void>>()
const navigate = vi.fn()

const realtime: RealtimeAdapter = {
  subscribeCollections: () => () => {},
  on(event, cb) {
    listeners.set(event, [...(listeners.get(event) ?? []), cb])
    return () =>
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((f) => f !== cb)
      )
  },
  emit: () => {},
  status: () => ({ state: 'live', transport: 'websocket', refreshed: null }) as never,
  joinWatch(room) {
    joined.push(room)
    return () => {}
  }
}

async function mount(enabled: boolean) {
  const client = {
    request: vi.fn(async (cmd: { _path: string }) => {
      calls.push(cmd._path)
      return { data: { current, recent: [] } }
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <RealtimeContext.Provider value={realtime}>
            <NavigationContext.Provider value={{ navigate, itemUrl: () => '/' }}>
              <IncidentBanner enabled={enabled} />
            </NavigationContext.Provider>
          </RealtimeContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  for (let i = 0; i < 30; i++) await act(async () => await new Promise((r) => setTimeout(r, 5)))
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  current = INCIDENT
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  calls.length = 0
  joined.length = 0
  listeners.clear()
  navigate.mockReset()
})

describe('IncidentBanner', () => {
  it('a non-admin sees nothing, joins no room and never asks the admin route', async () => {
    await mount(false)
    expect(host.querySelector('[data-incident-banner]')).toBeNull()
    expect(host.textContent).toBe('')
    expect(calls).toEqual([])
    expect(joined).toEqual([])
  })

  it('an admin sees the incident, its age and a link to the thread', async () => {
    await mount(true)
    const banner = host.querySelector('[data-incident-banner]')
    expect(banner?.textContent).toContain('Incident in progress: Partner pushes failing')
    expect(banner?.textContent).toMatch(/started .*12/)
    expect(joined).toEqual(['ops'])
    expect(calls).toContain('/ops-assistant/incident')
    const link = host.querySelector('[data-incident-thread]') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/chat?room=ch%3Aops&thread=91')
    await act(async () => link.click())
    expect(navigate).toHaveBeenCalledWith('/chat?room=ch%3Aops&thread=91')
  })

  it('clears live when the incident ends (payload-free notice → re-read)', async () => {
    await mount(true)
    expect(host.querySelector('[data-incident-banner]')).not.toBeNull()
    current = null
    await act(async () => {
      for (const f of listeners.get('ops:incident') ?? []) f({ at: Date.now() })
    })
    for (let i = 0; i < 60 && host.querySelector('[data-incident-banner]'); i++)
      await act(async () => await new Promise((r) => setTimeout(r, 10)))
    expect(host.querySelector('[data-incident-banner]')).toBeNull()
  })

  it('no thread link without a room', () => {
    expect(incidentThreadPath({ room: null, root_message_id: 3 })).toBeNull()
    expect(incidentThreadPath({ room: 'ch:ops', root_message_id: null })).toBe(
      '/chat?room=ch%3Aops'
    )
  })
})
