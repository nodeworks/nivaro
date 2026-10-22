import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A fake socket: records emits, lets the test deliver server events.
const sock = vi.hoisted(() => {
  const handlers = new Map<string, Set<(p: unknown) => void>>()
  return {
    emits: [] as Array<[string, unknown]>,
    handlers,
    on(ev: string, fn: (p: unknown) => void) {
      if (!handlers.has(ev)) handlers.set(ev, new Set())
      handlers.get(ev)?.add(fn)
    },
    off(ev: string, fn: (p: unknown) => void) {
      handlers.get(ev)?.delete(fn)
    },
    emit(ev: string, p: unknown) {
      sock.emits.push([ev, p])
    },
    deliver(ev: string, p: unknown) {
      for (const fn of handlers.get(ev) ?? []) fn(p)
    }
  }
})
vi.mock('@/lib/socket', () => ({ getSocket: () => sock }))
vi.mock('@nivaro/shared', () => ({
  canOpenChatRoom: () => false,
  openChatRoom: vi.fn(),
  // #2840 — browser chaos hooks the socket + axios client this file imports.
  bindClientChaosSocket: () => {},
  clientChaosAxiosInterceptor: () => (config: unknown) => config
}))

import type { ReplayControls } from './controls'
import { WatchTogetherBar } from './WatchTogether'
import { getWatchSession, setWatchSession } from './watch-together'

function controls(over: Partial<ReplayControls> = {}): { current: ReplayControls } {
  return {
    current: {
      getTime: () => 10_000,
      isPlaying: () => true,
      getSpeed: () => 1,
      seek: vi.fn(),
      playAt: vi.fn(),
      setSpeed: vi.fn(),
      ...over
    }
  }
}

const emitted = (ev: string) => sock.emits.filter((e) => e[0] === ev).map((e) => e[1])

beforeEach(() => {
  sock.emits = []
  sock.handlers.clear()
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } })
})
afterEach(() => {
  setWatchSession(null)
})

describe('WatchTogetherBar', () => {
  it('Watch together starts a session the sharer leads, and copies the link', async () => {
    render(<WatchTogetherBar recordingId='R1' controlsRef={controls()} ready />)
    await act(async () => {
      fireEvent.click(screen.getByText('Watch together'))
    })
    const s = getWatchSession()
    expect(s).toMatchObject({ recordingId: 'R1', role: 'leader' })
    expect(emitted('replay:join')).toEqual([{ key: s?.key, recording: 'R1', lead: true }])
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining(`/session-replays?recording=R1&t=10000&watch=${s?.key}`)
    )

    // Joined as leader: it sends its playhead at once, and on request.
    act(() => sock.deliver('replay:joined', { key: s?.key, recording: 'R1', leader: true }))
    expect(emitted('replay:state')).toEqual([
      { key: s?.key, playing: true, time: 10_000, speed: 1 }
    ])
    act(() =>
      sock.deliver('replay:roster', {
        key: s?.key,
        viewers: [
          { id: 'U1', name: 'Ann', leader: true },
          { id: 'U2', name: 'Bob', leader: false }
        ]
      })
    )
    expect(screen.getByText('You are leading')).toBeTruthy()
    expect(screen.getByText('Bob')).toBeTruthy()
    act(() => sock.deliver('replay:need-state', { key: s?.key }))
    expect(emitted('replay:state')).toHaveLength(2)

    // Stop leaves the room and ends the session.
    act(() => {
      fireEvent.click(screen.getByText('Stop'))
    })
    expect(emitted('replay:leave')).toEqual([{ key: s?.key }])
    expect(getWatchSession()).toBeNull()
  })

  it('a follower moves to the leader’s playhead', () => {
    setWatchSession({ recordingId: 'R1', key: 'k3yAbcdef12', role: 'follower' })
    const c = controls({ getTime: () => 3_000, isPlaying: () => false })
    render(<WatchTogetherBar recordingId='R1' controlsRef={c} ready />)
    expect(emitted('replay:join')).toEqual([{ key: 'k3yAbcdef12', recording: 'R1', lead: false }])
    act(() => sock.deliver('replay:joined', { key: 'k3yAbcdef12', leader: false }))
    act(() =>
      sock.deliver('replay:state', {
        key: 'k3yAbcdef12',
        playing: true,
        time: 42_000,
        speed: 2,
        by: 'Ann'
      })
    )
    expect(c.current.setSpeed).toHaveBeenCalledWith(2)
    expect(c.current.playAt).toHaveBeenCalledWith(true, 42_000)
    expect(screen.getByText('Following Ann')).toBeTruthy()
    // A follower never sends the playhead.
    expect(emitted('replay:state')).toEqual([])
  })

  it('offers to take the lead when the host has left', () => {
    setWatchSession({ recordingId: 'R1', key: 'k3yAbcdef12', role: 'follower' })
    render(<WatchTogetherBar recordingId='R1' controlsRef={controls()} ready />)
    act(() => sock.deliver('replay:joined', { key: 'k3yAbcdef12', leader: false }))
    act(() =>
      sock.deliver('replay:roster', {
        key: 'k3yAbcdef12',
        viewers: [{ id: 'U2', name: 'Bob', leader: false }]
      })
    )
    expect(screen.getByText('The host left')).toBeTruthy()
    act(() => {
      fireEvent.click(screen.getByText('Take the lead'))
    })
    expect(emitted('replay:join').at(-1)).toEqual({
      key: 'k3yAbcdef12',
      recording: 'R1',
      lead: true
    })
    expect(getWatchSession()?.role).toBe('leader')
  })

  it('says why a join was refused', () => {
    setWatchSession({ recordingId: 'R1', key: 'k3yAbcdef12', role: 'follower' })
    render(<WatchTogetherBar recordingId='R1' controlsRef={controls()} ready />)
    act(() => sock.deliver('replay:denied', { key: 'k3yAbcdef12', reason: 'admins-only' }))
    expect(screen.getByText(/Only admins/)).toBeTruthy()
  })

  it('closing the player ends the session; nothing renders before the replay is ready', () => {
    setWatchSession({ recordingId: 'R1', key: 'k3yAbcdef12', role: 'leader' })
    const { unmount } = render(<WatchTogetherBar recordingId='R1' controlsRef={controls()} ready />)
    unmount()
    expect(emitted('replay:leave')).toEqual([{ key: 'k3yAbcdef12' }])
    expect(getWatchSession()).toBeNull()
    const r = render(<WatchTogetherBar recordingId='R1' controlsRef={controls()} ready={false} />)
    expect(r.container.innerHTML).toBe('')
  })
})
