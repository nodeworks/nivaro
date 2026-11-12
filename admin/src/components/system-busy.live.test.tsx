import { RealtimeContext } from '@nivaro/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// First week live: three administrators' tabs made 76,000 GET /job-runs/busy calls in four
// days, round the clock. The pill re-read on EVERY job:update, and production starts and
// finishes about 1,100 job runs an hour (one cron ticks every 10 s) — hidden tabs included,
// because a socket event refetches whether or not anyone is looking.

const apiGet = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ api: { get: apiGet } }))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { id: 'admin-1', is_admin: true } }) }))
vi.mock('react-router', () => ({ useNavigate: () => () => {} }))

import { SystemBusy } from './system-busy'

type Listener = (payload: unknown) => void
function fakeRealtime() {
  const listeners = new Map<string, Set<Listener>>()
  return {
    adapter: {
      subscribeCollections: () => () => {},
      joinWatch: () => () => {},
      on: (event: string, cb: Listener) => {
        const set = listeners.get(event) ?? new Set<Listener>()
        set.add(cb)
        listeners.set(event, set)
        return () => set.delete(cb)
      },
      emit: () => {}
    },
    fire: (event: string, payload: unknown) => {
      for (const cb of listeners.get(event) ?? []) cb(payload)
    }
  }
}

let visibility: 'visible' | 'hidden' = 'visible'
function setVisibility(next: 'visible' | 'hidden') {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
}

const idle = { data: { data: { busy: false, items: [] } } }
const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rt = fakeRealtime()
  render(
    <QueryClientProvider client={qc}>
      <RealtimeContext.Provider value={rt.adapter as never}>
        <SystemBusy />
      </RealtimeContext.Provider>
    </QueryClientProvider>
  )
  return rt
}

beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility
  })
  apiGet.mockReset()
  apiGet.mockResolvedValue(idle)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the System busy pill and the job feed', () => {
  it('does not re-read for light cron ticks, however many arrive', async () => {
    const rt = mount()
    await pass(50)
    expect(apiGet).toHaveBeenCalledTimes(1)
    // Six ticks a minute for five minutes, a start and a finish each, as production sends them.
    for (let i = 0; i < 30; i++) {
      act(() => {
        rt.fire('job:update', {
          id: 100 + i,
          kind: 'cron',
          job_id: 'staged-imports',
          status: 'running'
        })
        rt.fire('job:update', {
          id: 100 + i,
          kind: 'cron',
          job_id: 'staged-imports',
          status: 'completed'
        })
      })
      await pass(10_000)
    }
    // Five minutes: only the slow backstop read (every two minutes while idle).
    expect(apiGet.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('re-reads once when heavy work starts', async () => {
    const rt = mount()
    await pass(50)
    act(() => {
      rt.fire('job:update', {
        id: 9,
        kind: 'backfill',
        job_id: 'geocode',
        status: 'running',
        busy: true
      })
    })
    await pass(1000)
    expect(apiGet).toHaveBeenCalledTimes(2)
  })

  it('asks nothing while the tab is hidden, and once when it shows again', async () => {
    const rt = mount()
    await pass(50)
    expect(apiGet).toHaveBeenCalledTimes(1)
    act(() => setVisibility('hidden'))
    act(() => {
      rt.fire('job:update', {
        id: 9,
        kind: 'backfill',
        job_id: 'geocode',
        status: 'running',
        busy: true
      })
    })
    await pass(30 * 60_000)
    expect(apiGet).toHaveBeenCalledTimes(1)
    act(() => setVisibility('visible'))
    await pass(50)
    expect(apiGet).toHaveBeenCalledTimes(2)
  })
})
