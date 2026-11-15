import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachSocketLiveness, createLiveness, type LivenessPort } from './socket-liveness'

/** A connection double: answers probes when `alive`, and counts reconnects. */
function port(connected = true) {
  const p = {
    connected,
    alive: true,
    probes: 0,
    reconnects: 0,
    pending: [] as Array<() => void>
  }
  const lp: LivenessPort = {
    connected: () => p.connected,
    probe: (answered) => {
      p.probes++
      if (p.alive) setTimeout(answered, 50)
      else p.pending.push(answered)
    },
    reconnect: () => {
      p.reconnects++
    }
  }
  return { p, lp }
}

const opts = {
  silenceMs: 40_000,
  probeTimeoutMs: 5000,
  tickMs: 5000,
  sleepGapMs: 30_000,
  wakeWindowMs: 15_000,
  repairWindowMs: 12_000,
  maxRepairs: 2,
  now: () => Date.now()
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('silent self-repair (realtime 24)', () => {
  it('does nothing while the server keeps talking', () => {
    const { p, lp } = port()
    const live = createLiveness(lp, opts)
    live.up()
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(10_000)
      live.heard()
    }
    expect(p.probes).toBe(0)
    expect(p.reconnects).toBe(0)
    live.stop()
  })

  it('probes after a long silence; an answer keeps the connection', () => {
    const { p, lp } = port()
    const live = createLiveness(lp, opts)
    live.up()
    vi.advanceTimersByTime(45_000)
    expect(p.probes).toBe(1)
    vi.advanceTimersByTime(100)
    expect(p.reconnects).toBe(0)
    expect(live.repairing()).toBe(false)
    live.stop()
  })

  it('a dead "connected" socket (no answer) is reopened quietly, and the repair ends on sign-in', () => {
    const { p, lp } = port()
    const changes: Array<[boolean, string | undefined]> = []
    const live = createLiveness(lp, opts)
    live.onRepairing((on, outcome) => changes.push([on, outcome]))
    live.up()
    p.alive = false
    vi.advanceTimersByTime(45_000) // silence → probe
    expect(p.probes).toBe(1)
    vi.advanceTimersByTime(5000) // no answer
    expect(p.reconnects).toBe(1)
    expect(live.repairing()).toBe(true)
    // our own reconnect drops the socket: still the same quiet repair
    p.connected = false
    live.down('io client disconnect')
    expect(live.repairing()).toBe(true)
    p.connected = true
    p.alive = true
    live.up()
    expect(live.repairing()).toBe(false)
    expect(changes).toEqual([
      [true, undefined],
      [false, 'repaired']
    ])
    expect(live.stats()).toMatchObject({ probes: 1, failedProbes: 1, repairs: 1, repaired: 1 })
    live.stop()
  })

  it('wake from sleep (a late tick) probes at once', () => {
    const { p, lp } = port()
    let now = Date.now()
    const live = createLiveness(lp, { ...opts, now: () => now })
    live.up()
    now += 120_000 // the machine slept two minutes; the interval fires once on wake
    live.tick()
    expect(p.probes).toBe(1)
    live.stop()
  })

  it('a heartbeat timeout reconnects now instead of waiting out the backoff', () => {
    const { p, lp } = port()
    const live = createLiveness(lp, opts)
    live.up()
    p.connected = false
    live.down('ping timeout')
    expect(p.reconnects).toBe(1)
    expect(live.repairing()).toBe(true)
    live.stop()
  })

  it('a drop right after a wake signal is repaired; a plain drop (deploy) is left to socket.io', () => {
    const a = port()
    const la = createLiveness(a.lp, opts)
    la.up()
    a.p.connected = false
    la.down('transport close')
    expect(a.p.reconnects).toBe(0)
    expect(la.repairing()).toBe(false)
    la.stop()

    const b = port()
    const lb = createLiveness(b.lp, opts)
    lb.up()
    lb.wake('online') // probe sent
    b.p.connected = false
    lb.down('transport close')
    expect(b.p.reconnects).toBe(1)
    lb.stop()
  })

  it('a wake while already down reconnects now, unless the app or the server closed it', () => {
    const a = port()
    const la = createLiveness(a.lp, opts)
    la.up()
    a.p.connected = false
    la.down('transport close')
    la.wake('visible')
    expect(a.p.reconnects).toBe(1)
    la.stop()

    for (const reason of ['io client disconnect', 'io server disconnect']) {
      const b = port()
      const lb = createLiveness(b.lp, opts)
      lb.up()
      b.p.connected = false
      lb.down(reason)
      lb.wake('online')
      expect(b.p.reconnects).toBe(0)
      lb.stop()
    }
  })

  it('stops being quiet after two failed repairs, until the connection comes back', () => {
    const { p, lp } = port()
    const changes: Array<[boolean, string | undefined]> = []
    const live = createLiveness(lp, opts)
    live.onRepairing((on, outcome) => changes.push([on, outcome]))
    live.up()
    p.connected = false
    live.down('ping timeout') // repair 1
    vi.advanceTimersByTime(12_000) // not signed in again → repair 2
    expect(p.reconnects).toBe(2)
    expect(live.repairing()).toBe(true)
    vi.advanceTimersByTime(12_000) // failed again → the banner may show
    expect(p.reconnects).toBe(2)
    expect(live.repairing()).toBe(false)
    expect(changes.at(-1)).toEqual([false, 'gave-up'])
    // no new quiet episode while it stays down
    live.wake('online')
    live.down('ping timeout')
    expect(p.reconnects).toBe(2)
    // back on its own: quiet repairs are possible again
    p.connected = true
    live.up()
    p.connected = false
    live.down('ping timeout')
    expect(p.reconnects).toBe(3)
    live.stop()
  })

  it('never acts on a socket that never signed in, or one held down on purpose', () => {
    const a = port()
    const la = createLiveness(a.lp, opts)
    a.p.connected = false
    la.down('ping timeout')
    la.wake('online')
    vi.advanceTimersByTime(60_000)
    expect(a.p.reconnects + a.p.probes).toBe(0)
    la.stop()

    const b = port()
    const lb = createLiveness(b.lp, { ...opts, held: () => true })
    lb.up()
    b.p.connected = false
    lb.down('ping timeout')
    lb.wake('online')
    expect(b.p.reconnects).toBe(0)
    lb.stop()
  })
})

describe('attachSocketLiveness', () => {
  function realish() {
    const handlers = new Map<string, Array<(...a: any[]) => void>>()
    const manager = new Map<string, Array<(...a: any[]) => void>>()
    const emitted: Array<[string, unknown]> = []
    const s = {
      connected: true,
      on(ev: string, cb: (...a: any[]) => void) {
        handlers.set(ev, [...(handlers.get(ev) ?? []), cb])
        return s
      },
      emit(ev: string, payload?: unknown) {
        emitted.push([ev, payload])
        return s
      },
      connect: vi.fn(() => {
        s.connected = true
      }),
      disconnect: vi.fn(() => {
        s.connected = false
        for (const cb of handlers.get('disconnect') ?? []) cb('io client disconnect')
      }),
      io: {
        on(ev: string, cb: (...a: any[]) => void) {
          manager.set(ev, [...(manager.get(ev) ?? []), cb])
        }
      },
      fire(ev: string, ...a: unknown[]) {
        for (const cb of handlers.get(ev) ?? []) cb(...a)
      },
      heartbeat() {
        for (const cb of manager.get('ping') ?? []) cb()
      },
      emitted
    }
    return s
  }

  it('watches a real socket once, probes with time:sync and reopens a dead one', () => {
    const s = realish()
    const live = attachSocketLiveness(s)
    expect(attachSocketLiveness(s)).toBe(live)
    s.fire('auth:ok')
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(25_000)
      s.heartbeat()
    }
    expect(s.emitted.filter(([e]) => e === 'time:sync')).toEqual([])
    vi.advanceTimersByTime(45_000) // the heartbeats stopped
    expect(s.emitted.filter(([e]) => e === 'time:sync').length).toBe(1)
    vi.advanceTimersByTime(5000)
    expect(s.disconnect).toHaveBeenCalledTimes(1)
    expect(s.connect).toHaveBeenCalledTimes(1)
    expect(live?.repairing()).toBe(true)
    s.fire('auth:ok')
    expect(live?.repairing()).toBe(false)
  })

  it('a socket-shaped object without a manager gets no watch', () => {
    expect(
      attachSocketLiveness({
        connected: true,
        on: () => {},
        emit: () => {},
        connect: () => {},
        disconnect: () => {}
      })
    ).toBe(null)
  })
})
