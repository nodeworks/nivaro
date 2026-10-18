import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireReadSlot,
  gateServerTiming,
  holdsReadSlot,
  readGateStats,
  resetReadGate,
  sharedGatedRead,
  withReadGate
} from '../../../services/read-gate.js'
import { resetSingleFlight, singleFlight } from '../../../services/single-flight.js'

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('singleFlight (#2452)', () => {
  beforeEach(() => resetSingleFlight())

  it('shares one run between N concurrent callers of the same key', async () => {
    const gate = deferred<number>()
    const run = vi.fn(() => gate.promise)
    const calls = Array.from({ length: 10 }, () => singleFlight('cq:a:{}', run))
    expect(calls.filter((c) => c.shared)).toHaveLength(9)
    gate.resolve(42)
    expect(await Promise.all(calls.map((c) => c.promise))).toEqual(Array(10).fill(42))
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does not share across different keys', async () => {
    const run = vi.fn(async () => 1)
    const a = singleFlight('cq:a:{"p":1}', run)
    const b = singleFlight('cq:a:{"p":2}', run)
    expect(a.shared || b.shared).toBe(false)
    await Promise.all([a.promise, b.promise])
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not keep a rejected run for later callers', async () => {
    let n = 0
    const run = vi.fn(async () => {
      n++
      if (n === 1) throw new Error('boom')
      return 'ok'
    })
    const first = singleFlight('k', run)
    const joiner = singleFlight('k', run)
    await expect(first.promise).rejects.toThrow('boom')
    await expect(joiner.promise).rejects.toThrow('boom')
    const later = singleFlight('k', run)
    expect(later.shared).toBe(false)
    await expect(later.promise).resolves.toBe('ok')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a resolved run once it settled', async () => {
    const run = vi.fn(async () => 'x')
    await singleFlight('k', run).promise
    await singleFlight('k', run).promise
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('aborts the run only when every attached caller has gone', async () => {
    const seen = deferred<AbortSignal>()
    const hold = deferred<string>()
    const a = new AbortController()
    const b = new AbortController()
    const lead = singleFlight(
      'k',
      ({ signal }) => {
        seen.resolve(signal)
        return hold.promise
      },
      { signal: a.signal }
    )
    singleFlight('k', async () => 'never', { signal: b.signal })
    const signal = await seen.promise
    a.abort()
    expect(signal.aborted).toBe(false)
    b.abort()
    expect(signal.aborted).toBe(true)
    hold.resolve('done')
    await lead.promise
  })

  it('joinPending:false runs alone instead of waiting on a flight that has not started', async () => {
    const hold = deferred<string>()
    const lead = singleFlight('k', () => hold.promise)
    const alone = singleFlight('k', async () => 'own', { joinPending: false })
    expect(alone.shared).toBe(false)
    expect(await alone.promise).toBe('own')
    hold.resolve('lead')
    expect(await lead.promise).toBe('lead')
  })
})

describe('read gate (#2452)', () => {
  beforeEach(() => {
    resetReadGate({ global: 2, perUser: 1, maxWaitMs: 10_000 })
    resetSingleFlight()
  })
  afterEach(() => vi.useRealTimers())

  it('respects the global limit and grants FIFO', async () => {
    const a = await acquireReadSlot('u1')
    const b = await acquireReadSlot('u2')
    const order: string[] = []
    const c = acquireReadSlot('u3').then((s) => {
      order.push('u3')
      return s
    })
    const d = acquireReadSlot('u4').then((s) => {
      order.push('u4')
      return s
    })
    await tick()
    expect(readGateStats().queued).toBe(2)
    a.release()
    const sc = await c
    expect(order).toEqual(['u3'])
    b.release()
    const sd = await d
    expect(order).toEqual(['u3', 'u4'])
    sc.release()
    sd.release()
    expect(readGateStats().active).toBe(0)
  })

  it('respects the per-user sub-limit without blocking other users', async () => {
    const a = await acquireReadSlot('u1')
    let second = false
    const a2 = acquireReadSlot('u1').then((s) => {
      second = true
      return s
    })
    // Another user is not stuck behind u1's queued request.
    const b = await acquireReadSlot('u2')
    await tick()
    expect(second).toBe(false)
    a.release()
    const s2 = await a2
    expect(second).toBe(true)
    s2.release()
    b.release()
  })

  it('fails open after the max wait instead of erroring', async () => {
    vi.useFakeTimers()
    resetReadGate({ global: 1, perUser: 1, maxWaitMs: 30_000 })
    const held = await acquireReadSlot('u1')
    const waiting = acquireReadSlot('u2')
    await vi.advanceTimersByTimeAsync(30_001)
    const slot = await waiting
    expect(slot.overflow).toBe(true)
    expect(readGateStats().timed_out).toBe(1)
    slot.release()
    held.release()
    expect(readGateStats().active).toBe(0)
  })

  it('leaves the queue when the client goes away while waiting', async () => {
    resetReadGate({ global: 1, perUser: 1, maxWaitMs: 10_000 })
    const held = await acquireReadSlot('u1')
    const ac = new AbortController()
    const waiting = acquireReadSlot('u2', ac.signal)
    await tick()
    ac.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    expect(readGateStats().queued).toBe(0)
    held.release()
    expect(readGateStats().active).toBe(0)
  })

  it('releases the slot when the body throws', async () => {
    await expect(
      withReadGate('u1', async () => {
        throw new Error('bad sql')
      })
    ).rejects.toThrow('bad sql')
    expect(readGateStats().active).toBe(0)
    await expect(withReadGate('u1', async () => 'next')).resolves.toBe('next')
  })

  it('is re-entrant: a nested gated call inside a held slot never waits', async () => {
    resetReadGate({ global: 1, perUser: 1, maxWaitMs: 60_000 })
    const out = await withReadGate('u1', async () => {
      expect(holdsReadSlot()).toBe(true)
      return withReadGate('u1', async () => 'inner')
    })
    expect(out).toBe('inner')
    expect(readGateStats().reentrant).toBe(1)
    expect(holdsReadSlot()).toBe(false)
  })

  it('a slot holder does not deadlock on a queued flight for the same key', async () => {
    resetReadGate({ global: 1, perUser: 4, maxWaitMs: 60_000 })
    const release = deferred()
    // u1 holds the only slot and, inside it, asks for key K.
    const holderRun = withReadGate('u1', async () => {
      await release.promise
      return sharedGatedRead('K', 'u1', async () => 'from-holder')
    })
    await tick()
    // u2 leads K first, but is queued behind u1's slot.
    const queued = sharedGatedRead('K', 'u2', async () => 'from-u2')
    await tick()
    release.resolve()
    // u1 must not join u2's queued flight (that would wait on itself).
    expect((await holderRun).value).toBe('from-holder')
    expect((await queued).value).toBe('from-u2')
    expect(readGateStats().active).toBe(0)
  })

  it('sharedGatedRead runs one body for concurrent callers and reports the wait', async () => {
    resetReadGate({ global: 1, perUser: 1, maxWaitMs: 60_000 })
    const blocker = await acquireReadSlot('other')
    const body = vi.fn(async () => [{ n: 1 }])
    const calls = Array.from({ length: 5 }, (_, i) => sharedGatedRead('cq:x:{}', `u${i}`, body))
    await new Promise((r) => setTimeout(r, 15))
    blocker.release()
    const results = await Promise.all(calls)
    expect(body).toHaveBeenCalledTimes(1)
    expect(results.filter((r) => r.shared)).toHaveLength(4)
    expect(results[0].waitedMs).toBeGreaterThan(0)
  })

  it('writes Server-Timing parts and appends to an existing header', () => {
    const headers: Record<string, string> = { 'server-timing': 'db;dur=3' }
    const reply = {
      getHeader: (n: string) => headers[n.toLowerCase()],
      header: (n: string, v: string) => {
        headers[n.toLowerCase()] = v
      }
    }
    gateServerTiming(reply, { waitedMs: 12, shared: true })
    expect(headers['server-timing']).toBe('db;dur=3, gate;dur=12, flight;desc="shared"')
  })
})
