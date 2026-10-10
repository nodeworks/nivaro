// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NavigationContext, NivaroProvider } from '../../context'
import { DayTimelineCard } from './DayTimeline'

// #1367 — the Day view draws one lane per source the API answered, drops a
// lane the API could not read (null), and every mark opens its own thing.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DAY = {
  date: '2026-10-10',
  tz_offset: 0,
  day_start: '2026-10-10T00:00:00.000Z',
  day_end: '2026-10-11T00:00:00.000Z',
  recordings: [
    {
      id: 'R1',
      app: 'admin',
      start: '2026-10-10T09:00:00.000Z',
      end: '2026-10-10T10:00:00.000Z',
      live: false
    }
  ],
  pages: [
    {
      path: '/collections/orders/7',
      session_id: 'S1',
      start: '2026-10-10T09:05:00.000Z',
      end: '2026-10-10T09:07:00.000Z',
      duration_seconds: 120
    },
    {
      path: 'javascript:alert(1)',
      session_id: 'S1',
      start: '2026-10-10T09:08:00.000Z',
      end: '2026-10-10T09:09:00.000Z',
      duration_seconds: 60
    }
  ],
  requests: [{ minute: '2026-10-10T09:10:00.000Z', count: 4, errors: 1 }],
  transitions: [
    {
      id: 9,
      at: '2026-10-10T09:20:00.000Z',
      collection: 'orders',
      item: '7',
      from: 'Draft',
      to: 'Submitted',
      label: 'Submit'
    }
  ],
  tasks: null,
  capped: []
}

let root: Root
let host: HTMLDivElement
const calls: Array<{ path: string; params?: Record<string, unknown> }> = []
const navigate = vi.fn()

async function mount() {
  const client = {
    request: vi.fn(async (cmd: { _path: string; _params?: Record<string, unknown> }) => {
      calls.push({ path: cmd._path, params: cmd._params })
      if (cmd._path.startsWith('/journeys/days/')) return { data: [] }
      return { data: DAY }
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <NavigationContext.Provider
            value={{
              navigate,
              itemUrl: (t) => `/collections/${t.collection}/${t.itemId}`,
              consoleUrl: (p) => `https://console.example${p}`
            }}
          >
            <DayTimelineCard userId='U-1' initialDate='2026-10-10' />
          </NavigationContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  // The day query resolves after a few ticks; a fixed count of microtask
  // flushes raced it on a loaded machine.
  for (let i = 0; i < 50 && !host.querySelector('[data-day-lane]'); i++) {
    await act(async () => await new Promise((r) => setTimeout(r, 10)))
  }
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  calls.length = 0
  navigate.mockReset()
})

describe('DayTimelineCard', () => {
  it('asks for the viewer’s day and draws a lane per answered source', async () => {
    await mount()
    const day = calls.find((c) => c.path === '/journeys/day/U-1')
    expect(day?.params).toMatchObject({ date: '2026-10-10' })
    expect(typeof day?.params?.tz_offset).toBe('number')
    const lanes = [...host.querySelectorAll('[data-day-lane]')].map((l) =>
      l.getAttribute('data-day-lane')
    )
    // tasks answered null (no table): the lane is left out.
    expect(lanes).toEqual(['recordings', 'pages', 'requests', 'transitions'])
  })

  it('links each mark to its own thing', async () => {
    await mount()
    const links = (lane: string) =>
      [...host.querySelectorAll(`[data-day-lane="${lane}"] a`)].map((a) => a.getAttribute('href'))
    expect(links('recordings')).toEqual(['https://console.example/session-replays?recording=R1'])
    // The unsafe path is drawn but not linked.
    expect(links('pages')).toEqual(['https://console.example/collections/orders/7'])
    expect(host.querySelectorAll('[data-day-lane="pages"] li')).toHaveLength(2)
    // A request bar plays the recording covering it, at that moment (10 min in).
    expect(links('requests')).toEqual([
      'https://console.example/session-replays?recording=R1&t=600000'
    ])
    expect(links('transitions')).toEqual(['/collections/orders/7'])

    const tick = host.querySelector<HTMLAnchorElement>('[data-day-lane="transitions"] a')
    expect(tick?.getAttribute('aria-label')).toMatch(/Submit \(Draft → Submitted\)/)
    act(() => tick?.click())
    expect(navigate).toHaveBeenCalledWith('/collections/orders/7')
  })
})
