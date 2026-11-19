import { describe, expect, it } from 'vitest'
import { readableIssue } from '../../../services/issue-readable.js'
import { createWatchdog, type StallReport, stallMessage } from '../../../services/stall-watchdog.js'

function harness(opts: { pool?: StallReport['pool'] } = {}) {
  let t = 0
  let probeResolve: (() => void) | null = null
  const reports: StallReport[] = []
  const state = { pool: opts.pool ?? null }
  const dog = createWatchdog(
    {
      now: () => t,
      probe: () =>
        new Promise<void>((r) => {
          probeResolve = r
        }),
      inflight: () => [
        { route: '/api/items/:collection', method: 'GET', age_ms: 9000, caller: 'u1', phase: 'sql' }
      ],
      pool: () => state.pool,
      report: (r) => reports.push(r)
    },
    'web-1'
  )
  return {
    reports,
    state,
    advance: async (ms: number) => {
      t += ms
      dog.tick()
      await Promise.resolve()
    },
    finishProbe: async () => {
      probeResolve?.()
      probeResolve = null
      await new Promise((r) => setTimeout(r, 0))
    }
  }
}

describe('stall watchdog', () => {
  it('reports a main-loop freeze with what was in flight', async () => {
    const h = harness()
    await h.advance(1000)
    await h.finishProbe()
    await h.advance(11_000) // the 1 s tick fired 10 s late
    const loop = h.reports.find((r) => r.kind === 'main-loop')
    expect(loop?.ms).toBe(10_000)
    expect(loop?.inflight[0].route).toBe('/api/items/:collection')
    expect(stallMessage(loop!)).toBe(
      'Process stalled 10.0s (main loop blocked) on web-1 — in flight: GET /api/items/:collection'
    )
  })

  it('reports backed-up helper threads while still stuck, once per episode', async () => {
    const h = harness()
    await h.advance(1000) // probe starts and never answers
    await h.advance(1000)
    await h.advance(1000)
    await h.advance(1000)
    expect(h.reports.filter((r) => r.kind === 'helper-threads')).toHaveLength(1)
    expect(h.reports[0].ms).toBeGreaterThanOrEqual(2000)
  })

  it('a quick helper-thread answer is never a stall', async () => {
    const h = harness()
    for (let i = 0; i < 5; i++) {
      await h.advance(1000)
      await h.finishProbe()
    }
    expect(h.reports).toHaveLength(0)
  })

  it('reports every connection taken with requests queued, continuously', async () => {
    const h = harness({ pool: { used: 60, pending: 4, max: 60 } })
    for (let i = 0; i < 4; i++) {
      await h.advance(1000)
      await h.finishProbe()
    }
    expect(h.reports.filter((r) => r.kind === 'connections')).toHaveLength(1)
    // a pool with a free connection is fine
    const ok = harness({ pool: { used: 59, pending: 0, max: 60 } })
    for (let i = 0; i < 4; i++) {
      await ok.advance(1000)
      await ok.finishProbe()
    }
    expect(ok.reports).toHaveLength(0)
  })

  it('at most one report per kind per minute', async () => {
    const h = harness()
    await h.advance(1000)
    await h.finishProbe()
    await h.advance(5000)
    await h.finishProbe()
    await h.advance(5000)
    await h.finishProbe()
    expect(h.reports.filter((r) => r.kind === 'main-loop')).toHaveLength(1)
    await h.advance(61_000)
    expect(h.reports.filter((r) => r.kind === 'main-loop')).toHaveLength(2)
  })

  it('reads as a plain sentence in the issue log', () => {
    const r = readableIssue({
      title:
        '[server] process-stall: Process stalled 10.0s (helper threads backed up) on web-1 — in flight: GET /api/x'
    })
    expect(r?.title).toBe('A server process froze for 10.0 s (helper threads backed up)')
    expect(r?.description).toMatch(/shared file storage/)
  })
})
