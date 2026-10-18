import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWithTenantDb } from '../../../db/tenant-context.js'
import {
  acquireReadSlot,
  gateServerTiming,
  holdsReadSlot,
  type ReadSlot,
  readGateStats,
  resetReadGate,
  sharedGatedRead,
  withReadGate,
  withReadGateEach
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

/** Run `fn` inside a cloud tenant context (the tenant middleware's ALS). */
function inTenant<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    runWithTenantDb({} as never, tenant, () => fn().then(resolve, reject), tenant)
  })
}

/** A slot request that records when it was granted. */
function track(who: string, signal?: AbortSignal) {
  const state: { slot: ReadSlot | null } = { slot: null }
  const p = acquireReadSlot(who, signal).then((s) => {
    state.slot = s
    return s
  })
  return { p, state }
}

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
    const join = singleFlight('k', async () => 'never', { signal: b.signal })
    const signal = await seen.promise
    a.abort()
    await expect(lead.promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(signal.aborted).toBe(false)
    b.abort()
    await expect(join.promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(signal.aborted).toBe(true)
    hold.resolve('done')
  })

  it('a joiner that disconnects stops waiting without cancelling the run for others', async () => {
    const hold = deferred<string>()
    const lead = singleFlight('k', () => hold.promise)
    const ac = new AbortController()
    const join = singleFlight('k', async () => 'never', { signal: ac.signal })
    ac.abort()
    await expect(join.promise).rejects.toMatchObject({ name: 'AbortError' })
    hold.resolve('answer')
    await expect(lead.promise).resolves.toBe('answer')
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

  it('work-conserving: a lone user may use every slot on an idle gate', async () => {
    resetReadGate({ global: 3, perUser: 1, maxWaitMs: 10_000 })
    const slots = await Promise.all([1, 2, 3].map(() => acquireReadSlot('u1')))
    expect(readGateStats().active).toBe(3)
    for (const s of slots) s.release()
  })

  it('under contention the per-user share applies: a waiting user goes before an over-share one', async () => {
    resetReadGate({ global: 3, perUser: 1, maxWaitMs: 10_000 })
    const held = await Promise.all([1, 2, 3].map(() => acquireReadSlot('u1')))
    const u1More = track('u1') // older, but u1 is over its share
    const u2 = track('u2')
    await tick()
    held[0].release()
    await tick()
    expect(u2.state.slot?.who).toBe('u2')
    expect(u1More.state.slot).toBeNull()
    // Once nobody else waits, u1 may take a free slot again.
    held[1].release()
    await tick()
    expect(u1More.state.slot?.who).toBe('u1')
    u2.state.slot?.release()
    u1More.state.slot?.release()
    held[2].release()
    expect(readGateStats().active).toBe(0)
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

  it('fire-and-forget work started in a gated body is not re-entrant after release', async () => {
    resetReadGate({ global: 1, perUser: 1, maxWaitMs: 60_000 })
    const later = deferred()
    let after: Promise<boolean> | null = null
    await withReadGate('u1', async () => {
      after = later.promise.then(() => holdsReadSlot())
    })
    later.resolve()
    expect(await after).toBe(false)
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

  it('sharedGatedRead runs one body for concurrent callers and every caller reports the wait', async () => {
    resetReadGate({ global: 1, perUser: 1, maxWaitMs: 60_000 })
    const blocker = await acquireReadSlot('other')
    const body = vi.fn(async () => [{ n: 1 }])
    const waits: number[] = []
    const calls = Array.from({ length: 5 }, (_, i) =>
      sharedGatedRead('cq:x:{}', `u${i}`, body, { onWait: (ms) => waits.push(ms) })
    )
    await new Promise((r) => setTimeout(r, 15))
    blocker.release()
    const results = await Promise.all(calls)
    expect(body).toHaveBeenCalledTimes(1)
    expect(results.filter((r) => r.shared)).toHaveLength(4)
    expect(results.every((r) => r.waitedMs > 0)).toBe(true)
    expect(waits).toHaveLength(5)
    expect(readGateStats().active).toBe(0)
  })

  it('a queued flight starts as soon as ANY participant is granted, and the others withdraw', async () => {
    resetReadGate({ global: 3, perUser: 1, maxWaitMs: 60_000 })
    const a = await acquireReadSlot('u1')
    const b = await acquireReadSlot('u9')
    const c = await acquireReadSlot('u9') // lone-user work-conserving grant: gate now full
    const u9More = track('u9')
    const ran: string[] = []
    const body = deferred()
    const lead = sharedGatedRead('K', 'u1', async () => {
      ran.push('run')
      await body.promise
      return 'answer'
    })
    const join = sharedGatedRead('K', 'u2', async () => 'never')
    await tick()
    expect(readGateStats().queued).toBe(3)
    // One slot frees: u9 and u1 are at their share while others wait; the
    // joiner u2 is not — its entry starts the flight for both.
    c.release()
    await tick()
    expect(ran).toEqual(['run'])
    // u1's queue entry for K was withdrawn; only u9's own request remains.
    expect(readGateStats().queued).toBe(1)
    body.resolve()
    expect((await lead).value).toBe('answer')
    expect((await join).value).toBe('answer')
    a.release()
    await u9More.p
    u9More.state.slot?.release()
    b.release()
    expect(readGateStats().active).toBe(0)
  })

  it('counts per tenant: a tenant is capped below its pool, other tenants are unaffected', async () => {
    resetReadGate({ global: 20, perUser: 20, maxWaitMs: 60_000 })
    // TENANT_POOL_MAX is 5 → a tenant gets 4 slots.
    const t1 = await inTenant('t1', () =>
      Promise.all([1, 2, 3, 4].map((i) => acquireReadSlot(`u${i}`)))
    )
    const fifth = inTenant('t1', () => Promise.resolve(track('u5')))
    const { state } = await fifth
    await tick()
    expect(state.slot).toBeNull()
    expect(await inTenant('t1', async () => readGateStats().limits.global)).toBe(4)
    // Tenant t2 and self-hosted have their own counts.
    const other = await inTenant('t2', () => acquireReadSlot('u1'))
    const self = await acquireReadSlot('u1')
    expect(other.overflow || self.overflow).toBe(false)
    expect(readGateStats().active).toBe(1)
    t1[0].release()
    await tick()
    expect(state.slot?.who).toBe('u5')
    state.slot?.release()
    for (const s of [...t1.slice(1), other, self]) s.release()
  })

  it('withReadGateEach gives every source query its own slot', async () => {
    resetReadGate({ global: 2, perUser: 10, maxWaitMs: 60_000 })
    let running = 0
    let peak = 0
    const source = async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return 1
    }
    let longest = 0
    const out = await withReadGateEach('u1', [source, source, source, source], {
      onWait: (ms) => {
        longest = ms
      }
    })
    expect(out).toEqual([1, 1, 1, 1])
    expect(peak).toBe(2)
    expect(longest).toBeGreaterThan(0)
    expect(readGateStats().acquired).toBe(4)
    expect(readGateStats().active).toBe(0)
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
