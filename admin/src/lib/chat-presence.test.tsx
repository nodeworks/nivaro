import { RealtimeContext } from '@nivaro/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The admin chat's online list reads GET /presence/online (the shared ['presence-online']
// entry) and refreshes through the shared presence:changed rule — never the raw
// user_presence table, and never on a user_presence row update (staging load test
// 2026-10-24: those table reads deadlocked with the heartbeat writes).

const sdk = vi.hoisted(() => ({
  request: vi.fn(),
  paths: [] as string[]
}))

vi.mock('@nivaro/sdk', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  createNivaro: () => ({
    request: (cmd: { _path?: string }) => {
      sdk.paths.push(String(cmd?._path ?? ''))
      return sdk.request(cmd)
    }
  })
}))
const apiGet = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ api: { get: apiGet, patch: vi.fn(), post: vi.fn() } }))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { id: 'me-1' } }) }))
vi.mock('@/lib/socket', () => ({ getSocket: () => null }))

import { useOnlineUsers } from './chat-presence'

type Listener = (payload: unknown) => void
function fakeRealtime() {
  const listeners = new Map<string, Set<Listener>>()
  return {
    adapter: {
      subscribeCollections: () => () => {},
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

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rt = fakeRealtime()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <RealtimeContext.Provider value={rt.adapter as never}>{children}</RealtimeContext.Provider>
    </QueryClientProvider>
  )
  return { ...renderHook(() => useOnlineUsers(), { wrapper }), rt }
}

beforeEach(() => {
  sdk.paths.length = 0
  sdk.request.mockReset()
  sdk.request.mockResolvedValue({
    data: [
      { user_id: 'ME-1', display_name: 'Me' },
      { user_id: 'u-2', display_name: 'Ann', is_idle: false }
    ],
    config: {}
  })
  apiGet.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('admin useOnlineUsers', () => {
  it('reads /presence/online, never the raw user_presence table, and leaves out me', async () => {
    const { result } = setup()
    await waitFor(() => expect(result.current.users).toHaveLength(1))
    expect(result.current.users[0]).toMatchObject({ user_id: 'u-2', display_name: 'Ann' })
    expect(sdk.paths).toEqual(['/presence/online'])
    expect(apiGet).not.toHaveBeenCalled()
  })

  it("refreshes for someone else's change once, after the shared rule's window", async () => {
    const { result, rt } = setup()
    await waitFor(() => expect(result.current.users).toHaveLength(1))
    vi.useFakeTimers()
    act(() => {
      rt.fire('presence:changed', { user_id: 'u-2' })
      rt.fire('presence:changed', { user_id: 'u-3' })
      rt.fire('presence:changed', { user_id: 'u-4' })
    })
    expect(sdk.paths).toHaveLength(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100)
    })
    vi.useRealTimers()
    await waitFor(() => expect(sdk.paths).toHaveLength(2))
    expect(sdk.paths.every((p) => p === '/presence/online')).toBe(true)
  })
})
