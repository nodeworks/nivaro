// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NavigationContext, NivaroProvider } from '../../context'
import { JourneyCard } from './PersonActivity'

// Pages visited: places in words, folded, records linked in the viewer's app — never raw ids.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const GUID = '98f98b3a-f07a-4ef4-9016-0005ad2fc8c5'
const base = new Date()
base.setHours(8, 57, 0, 0)
const at = (s: number) => new Date(base.getTime() + s * 1000).toISOString()
const rec = {
  title: 'Workflow CM26-365984 · Roof',
  section: 'Workflows',
  detail: null,
  kind: 'record',
  key: 'record:workflows:k1',
  record: { collection: 'workflows', id: '365984' }
}
const SESSIONS = [
  {
    session_id: 'S1',
    started_at: at(0),
    app: 'efp-new',
    steps: [
      {
        path: `/records/workflows/365984?addendum=${GUID}`,
        entered_at: at(0),
        duration_seconds: 59,
        app: 'efp-new',
        label: { ...rec, detail: 'Addendum open' }
      },
      {
        path: '/records/workflows/365984',
        entered_at: at(59),
        duration_seconds: 69,
        app: 'efp-new',
        label: rec
      },
      { path: `/queues/${GUID}`, entered_at: at(128), duration_seconds: 0, app: 'efp-new' },
      // An older API sent no label: the card says the route's words, never the GUID.
      { path: `/queues/${GUID}`, entered_at: at(128), duration_seconds: 12, app: 'efp-new' }
    ]
  }
]

let root: Root
let host: HTMLDivElement
const navigate = vi.fn()
const calls: Array<{ path: string; params?: Record<string, unknown> }> = []

async function mount(fail = false) {
  const client = {
    request: vi.fn(async (cmd: { _path: string; _params?: Record<string, unknown> }) => {
      calls.push({ path: cmd._path, params: cmd._params })
      if (cmd._path.startsWith('/journeys/days/')) return { data: [], apps: ['efp-new'] }
      if (fail)
        throw Object.assign(new Error('Request failed with status code 500'), { status: 500 })
      return { data: { sessions: SESSIONS } }
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <NavigationContext.Provider
            value={{ navigate, itemUrl: (t) => `/records/${t.collection}/${t.itemId}` }}
          >
            <JourneyCard userId='U-1' />
          </NavigationContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  for (
    let i = 0;
    i < 50 && !host.querySelector('[data-journey-session],[data-error-action]');
    i++
  ) {
    await act(async () => await new Promise((r) => setTimeout(r, 10)))
  }
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  calls.length = 0
  navigate.mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('JourneyCard', () => {
  it('folds the record visits into one linked row and shows no ids or queries', async () => {
    await mount()
    const rows = host.querySelectorAll('[data-journey-row]')
    expect(rows).toHaveLength(2)
    const link = rows[0].querySelector('a')
    expect(link?.textContent).toBe('Workflow CM26-365984 · Roof')
    expect(link?.getAttribute('href')).toBe('/records/workflows/365984')
    expect(rows[0].textContent).toContain('Addendum open · 2 visits')
    expect(rows[0].textContent).toContain('2m 8s')
    expect(rows[1].textContent).toContain('A queue')
    expect(host.textContent).toContain('8:57 AM')
    expect(host.textContent).not.toMatch(/08:57|98f98b3a|addendum=|365984\?/i)
    expect(host.querySelector('[data-journey-skipped]')?.textContent).toBe(
      '1 page open for less than a second isn’t shown'
    )
  })

  it('asks for the viewer day with its zone offset', async () => {
    await mount()
    const ask = calls.find((c) => c.path === '/journeys/user/U-1')
    expect(ask?.params).toMatchObject({ tz_offset: expect.any(Number) })
    expect(String(ask?.params?.date)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('says a failed read in words with a retry', async () => {
    await mount(true)
    expect(host.textContent).toContain('Couldn’t load the pages visited')
    expect(host.textContent).not.toContain('status code 500')
  })
})
