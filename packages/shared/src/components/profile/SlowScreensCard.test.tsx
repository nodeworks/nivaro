// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../../context'
import { TicketSlowScreens } from '../support/TicketSlowScreens'
import { looksLikeSlowness, SlowScreensCard, type SlowScreensData } from './SlowScreensCard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string; _params?: Record<string, unknown> }

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
  for (let i = 0; i < 60 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

const DATA: SlowScreensData = {
  user_id: 'U1',
  days: 7,
  timing_days: 7,
  samples: 42,
  journeys: true,
  no_timings: false,
  devices: {
    browsers: [{ name: 'Edge 130 · Windows', n: 42 }],
    screens: [{ name: 'laptop', n: 42 }]
  },
  pages: [
    {
      app: 'admin',
      page: '/collections/orders/:id',
      n: 12,
      loads: 2,
      moves: 10,
      median_ms: 2400,
      p95_ms: 9100,
      worst_ms: 9100,
      visits: 12,
      devices: [],
      calls: [
        {
          method: 'GET',
          path: '/api/items/orders/:id',
          n: 12,
          visits: 12,
          median_ms: 2100,
          worst_ms: 8200,
          errors: 1
        }
      ],
      calls_from_visits: 12,
      slow_visits: [
        {
          at: Date.UTC(2026, 10, 12, 15),
          ms: 9100,
          kind: 'route',
          browser: 'Edge 130',
          screen: 'laptop',
          replay: { recording_id: 'rec-1', offset_ms: 4000 }
        }
      ]
    }
  ]
}

async function mount(node: React.ReactNode, isAdmin = true) {
  const calls: Cmd[] = []
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      return { data: DATA }
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin, userId: 'ADMIN' } as never}>
            {node}
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  return calls
}

describe('SlowScreensCard', () => {
  it('lists their slowest pages, and the calls and replay behind one', async () => {
    const calls = await mount(<SlowScreensCard userId='U1' name='Sam' />)
    await settle(() => !!host.querySelector('[data-slow-screen]'))
    expect(calls[0]._path).toBe('/slow-screens/U1')
    expect(calls[0]._params).toEqual({ days: 7 })
    const text = host.textContent ?? ''
    expect(text).toContain('/collections/orders/:id')
    expect(text).toContain('9.1 s')
    expect(text).toContain('Edge 130 · Windows 100%')
    await act(async () =>
      (host.querySelector('[data-slow-screen] button') as HTMLButtonElement).click()
    )
    expect(host.textContent).toContain('/api/items/orders/:id')
    expect(host.textContent).toContain('1 failed')
    const replay = host.querySelector('[data-slow-screen-replay]') as HTMLAnchorElement
    expect(replay.getAttribute('href')).toBe('/session-replays?recording=rec-1&t=4000')
    // 30 days asks again
    await act(async () =>
      [...host.querySelectorAll('button')].find((b) => b.textContent === '30 days')?.click()
    )
    await settle(() => calls.length > 1)
    expect(calls[1]._params).toEqual({ days: 30 })
  })
})

describe('TicketSlowScreens', () => {
  it('opens by itself on a ticket about slowness, for administrators only', async () => {
    const calls = await mount(
      <TicketSlowScreens userId='U1' name='Sam Reed' text='The orders page takes forever to load' />
    )
    await settle(() => calls.length > 0)
    expect(host.querySelector('[data-ticket-slow-screens="auto"]')).not.toBeNull()
  })

  it('waits for a press on any other ticket', async () => {
    const calls = await mount(<TicketSlowScreens userId='U1' name='Sam Reed' text='Wrong vendor' />)
    expect(calls).toHaveLength(0)
    expect(host.textContent).toContain('Show Sam’s slowest screens')
  })

  it('shows nothing to someone who is not an administrator', async () => {
    const calls = await mount(<TicketSlowScreens userId='U1' name='Sam' text='so slow' />, false)
    expect(calls).toHaveLength(0)
    expect(host.textContent).toBe('')
  })

  it('reads slowness the way people write it', () => {
    for (const t of ['slow', 'page keeps spinning', 'it timed out', 'Takes ages to open', 'laggy'])
      expect(looksLikeSlowness(t)).toBe(true)
    for (const t of ['wrong amount', 'please add a vendor', 'snowflake'])
      expect(looksLikeSlowness(t)).toBe(false)
  })
})
