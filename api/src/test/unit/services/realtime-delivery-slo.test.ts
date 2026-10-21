import { beforeEach, describe, expect, it } from 'vitest'
import {
  acceptAck,
  ackDelayMs,
  ackEvery,
  ackSampled,
  burnOf,
  burnVerdict,
  computeDeliverySlo,
  deliveryBucket,
  figuresOf,
  noteDeliverySample,
  setDeliveryRedis
} from '../../../services/realtime-delivery-slo.js'

/** Just enough of ioredis for hash histograms: multi().hincrby/expire, pipeline().hgetall. */
function fakeRedis() {
  const hashes = new Map<string, Map<string, number>>()
  const multi = () => {
    const ops: Array<() => void> = []
    const chain = {
      hincrby(key: string, field: string, n: number) {
        ops.push(() => {
          const h = hashes.get(key) ?? new Map()
          h.set(field, (h.get(field) ?? 0) + n)
          hashes.set(key, h)
        })
        return chain
      },
      expire() {
        return chain
      },
      async exec() {
        for (const op of ops) op()
        return []
      }
    }
    return chain
  }
  const pipeline = () => {
    const keys: string[] = []
    const chain = {
      hgetall(key: string) {
        keys.push(key)
        return chain
      },
      async exec() {
        return keys.map((k) => [
          null,
          Object.fromEntries([...(hashes.get(k) ?? new Map())].map(([f, n]) => [f, String(n)]))
        ])
      }
    }
    return chain
  }
  return { multi, pipeline, hashes } as any
}

const targets = { delivery_p95_ms: 2000, delivery_good_pct: 95, window_days: 7 }

describe('realtime delivery SLO (#2477)', () => {
  beforeEach(() => {
    delete process.env.REALTIME_ACK_EVERY
    setDeliveryRedis(null)
  })

  it('samples one event in N by journal sequence', () => {
    expect(ackEvery({})).toBe(50)
    expect(ackEvery({ REALTIME_ACK_EVERY: '0' })).toBe(0)
    expect(ackSampled(100, 50)).toBe(true)
    expect(ackSampled(101, 50)).toBe(false)
    expect(ackSampled(100, 0)).toBe(false)
    expect(ackSampled(null, 50)).toBe(false)
  })

  it('buckets like the request SLO', () => {
    expect(deliveryBucket(10)).toBe(25)
    expect(deliveryBucket(1999)).toBe(2000)
    expect(deliveryBucket(12_000)).toBe(15_000)
  })

  it('trusts a client receive time only inside the round trip it can see', () => {
    // Fits: rx − st = 120, the ack arrived 300 ms after the send.
    expect(ackDelayMs({ st: 1000, rx: 1120, ackAt: 1300, rttMs: 80 })).toBe(120)
    // A drifting clock claims a receive after the ack arrived → estimate from the ack instead.
    expect(ackDelayMs({ st: 1000, rx: 5000, ackAt: 1300, rttMs: 80 })).toBe(260)
    // No usable rx and no rtt: the whole ceiling.
    expect(ackDelayMs({ st: 1000, rx: 'x', ackAt: 1300, rttMs: null })).toBe(300)
    // An ack from before the send, or minutes later, is not a delivery.
    expect(ackDelayMs({ st: 2000, rx: 2001, ackAt: 1000, rttMs: 10 })).toBeNull()
    expect(ackDelayMs({ st: 1000, rx: 1001, ackAt: 1000 + 200_000, rttMs: 10 })).toBeNull()
    expect(ackDelayMs({ st: 'nope', rx: 1, ackAt: 2, rttMs: 1 })).toBeNull()
  })

  it('counts missed deliveries as bad and above every bucket', () => {
    const c = new Map([
      ['probe|a|100', 90],
      ['probe|a|3000', 5],
      ['probe|a|x', 5]
    ])
    const f = figuresOf(c, 2000)
    expect(f.samples).toBe(100)
    expect(f.missed).toBe(5)
    expect(f.good_pct).toBe(90)
    expect(f.p95_ms).toBe(3000)
    // 10% bad against a 5% allowance burns at 2×.
    expect(burnOf(f, 95)).toBe(2)
    const worse = figuresOf(new Map([['probe|a|x', 10]]), 2000)
    expect(worse.p95_ms).toBeNull()
    expect(burnOf(figuresOf(new Map(), 2000), 95)).toBeNull()
  })

  it('pages on a fast burn with enough samples, warns on a slow one', () => {
    expect(burnVerdict({ h1: { burn: 20, samples: 12 }, h6: { burn: 3, samples: 72 } })).toEqual({
      state: 'fast',
      burn: 20
    })
    // Two bad probes in a quiet hour are not a page.
    expect(burnVerdict({ h1: { burn: 20, samples: 2 }, h6: { burn: 1, samples: 10 } }).state).toBe(
      'ok'
    )
    expect(burnVerdict({ h1: { burn: 2, samples: 12 }, h6: { burn: 7, samples: 72 } }).state).toBe(
      'slow'
    )
  })

  it('keeps per-source, per-replica histograms and reports burn windows', async () => {
    const redis = fakeRedis()
    const now = Date.UTC(2026, 9, 21, 12, 0, 0)
    for (let i = 0; i < 19; i++)
      await noteDeliverySample('probe', 150, { redis, node: 'api-1', at: now - i * 60_000 })
    await noteDeliverySample('probe', null, { redis, node: 'api-1', at: now - 60_000 })
    for (let i = 0; i < 10; i++)
      await noteDeliverySample('client', 400, { redis, node: 'api-2', at: now - i * 1000 })
    const slo = await computeDeliverySlo(targets, { redis, now })
    expect(slo).not.toBeNull()
    expect(slo!.overall.samples).toBe(30)
    expect(slo!.overall.missed).toBe(1)
    expect(slo!.by_source.probe.samples).toBe(20)
    expect(slo!.by_source.client.p95_ms).toBe(425)
    expect(slo!.by_node.map((n) => `${n.source}:${n.node}`).sort()).toEqual([
      'client:api-2',
      'probe:api-1'
    ])
    // 1 bad of 30 in the last hour = 3.3% against 5% allowed.
    expect(slo!.burn.h1).toBe(0.67)
    expect(slo!.overall.meets).toBe(true)
    expect(slo!.days).toHaveLength(1)
  })

  it('accepts a sampled ack once per socket per few seconds, never an unsampled one', async () => {
    const redis = fakeRedis()
    setDeliveryRedis(redis)
    const now = 10_000_000
    expect(acceptAck('s1', { seq: 51, st: now - 100, rx: now - 50 }, 20, now)).toBeNull()
    expect(acceptAck('s1', { seq: 50, st: now - 100, rx: now - 50 }, 20, now)).toBe(50)
    expect(acceptAck('s1', { seq: 100, st: now - 100, rx: now - 50 }, 20, now + 1000)).toBeNull()
    expect(acceptAck('s1', { seq: 100, st: now, rx: now + 30 }, 20, now + 6000)).toBe(30)
    process.env.REALTIME_ACK_EVERY = '0'
    expect(acceptAck('s2', { seq: 50, st: now - 100, rx: now - 50 }, 20, now)).toBeNull()
  })
})
