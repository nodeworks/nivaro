import { beforeEach, describe, expect, it } from 'vitest'
import { noteStampedDelivery } from '../../../services/realtime-ack-sample.js'
import {
  _resetAckBucketsForTests,
  acceptAck,
  ackDelayMs,
  ackEvery,
  ackSampled,
  ackSilenceRecent,
  burnOf,
  burnVerdict,
  computeDeliverySlo,
  deliveryBucket,
  deliveryByNodeRecent,
  figuresOf,
  judgeAckSilence,
  judgeDeliveryByNode,
  noteDeliverySample,
  setDeliveryRedis,
  takeAckToken
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

  it('takes an ack only from a signed-in person, with the stamp the server kept, rate-limited', async () => {
    _resetAckBucketsForTests()
    const redis = fakeRedis()
    setDeliveryRedis(redis)
    const now = 10_000_000
    const kept = new Map([
      [50, now - 100],
      [100, now - 200],
      [150, now - 300],
      [200, now - 50]
    ])
    const lookupStamp = async (seq: number) => kept.get(seq) ?? null
    const ack = (user: string | null, p: Record<string, unknown>, at = now) =>
      acceptAck(user, p, 20, { now: at, lookupStamp })
    // Unauthenticated socket: dropped.
    expect(await ack(null, { seq: 50, st: now - 100, rx: now - 50 })).toBeNull()
    // A sequence the server did not stamp: dropped (the kept stamp is the proof).
    expect(await ack('u1', { seq: 51, st: now - 100, rx: now - 50 })).toBeNull()
    // A forged stamp (claims a slow delivery that never happened): dropped.
    expect(await ack('u1', { seq: 50, st: now - 90_000, rx: now - 50 })).toBeNull()
    // A sequence the server never stamped (or whose stamp expired): dropped.
    expect(await ack('u2', { seq: 250, st: now - 100, rx: now - 50 })).toBeNull()
    // The real stamp: recorded.
    expect(await ack('u3', { seq: 100, st: now - 200, rx: now - 150 })).toBe(50)
    // Per person, not per socket: two tokens, then refused until refilled.
    expect(await ack('u4', { seq: 50, st: now - 100, rx: now - 50 })).toBe(50)
    expect(await ack('u4', { seq: 150, st: now - 300, rx: now - 250 })).toBe(50)
    expect(await ack('u4', { seq: 200, st: now - 50, rx: now - 20 })).toBeNull()
    expect(await ack('u4', { seq: 200, st: now - 50, rx: now - 20 }, now + 10_000)).toBe(30)
    process.env.REALTIME_ACK_EVERY = '0'
    expect(await ack('u5', { seq: 50, st: now - 100, rx: now - 50 })).toBeNull()
  })

  it('takes an ack for an event the time floor stamped off the 1-in-N grid', async () => {
    _resetAckBucketsForTests()
    const redis = fakeRedis()
    setDeliveryRedis(redis)
    const now = 10_000_000
    const lookupStamp = async (seq: number) => (seq === 73 ? now - 400 : null)
    expect(
      await acceptAck('u1', { seq: 73, st: now - 400, rx: now - 300 }, 20, { now, lookupStamp })
    ).toBe(100)
    expect(
      await acceptAck('u2', { seq: 0, st: now - 400, rx: now - 300 }, 20, { now, lookupStamp })
    ).toBeNull()
  })

  it('tells a silent check from a quiet one (staging demo 2026-10-26)', async () => {
    const redis = fakeRedis()
    const now = 50_000_000
    // Nothing anywhere: idle, never an alarm.
    const empty = await ackSilenceRecent(15, { redis, now })
    expect(empty).toEqual({
      window_minutes: 15,
      client_samples: 0,
      stamped_events: 0,
      socket_deliveries: 0
    })
    expect(judgeAckSilence(empty!).status).toBe('idle')
    // Sampled events reached 12 sockets (realtime process) and no ack came back: silent.
    for (let i = 0; i < 4; i++)
      noteStampedDelivery(redis, 'collection:orders', 3, { node: 'rt-1', at: now - i * 60_000 })
    // The probe's synthetic socket is never counted.
    noteStampedDelivery(redis, 'probe:abc', 1, { node: 'rt-1', at: now })
    await new Promise((r) => setImmediate(r))
    const silent = await ackSilenceRecent(15, { redis, now })
    expect(silent).toMatchObject({ client_samples: 0, stamped_events: 4, socket_deliveries: 12 })
    const v = judgeAckSilence(silent!)
    expect(v.status).toBe('silent')
    expect(v.detail).toMatch(/no client acknowledged one/)
    // A probe sample does not count as a client acknowledgement.
    await noteDeliverySample('probe', 40, { redis, at: now, node: 'web-1' })
    expect(judgeAckSilence((await ackSilenceRecent(15, { redis, now }))!).status).toBe('silent')
    // One client acknowledgement and the check is measuring again.
    await noteDeliverySample('client', 120, { redis, at: now, node: 'rt-1' })
    const ok = await ackSilenceRecent(15, { redis, now })
    expect(ok?.client_samples).toBe(1)
    expect(judgeAckSilence(ok!).status).toBe('ok')
    // Older than the window: forgotten.
    expect((await ackSilenceRecent(15, { redis, now: now + 3_600_000 }))?.socket_deliveries).toBe(0)
    // Too few deliveries to call it broken.
    expect(
      judgeAckSilence({
        window_minutes: 15,
        client_samples: 0,
        stamped_events: 1,
        socket_deliveries: 3
      }).status
    ).toBe('idle')
    // Acknowledgements switched off: never an alarm.
    process.env.REALTIME_ACK_EVERY = '0'
    expect(judgeAckSilence(silent!).status).toBe('idle')
  })

  it('a full bucket map drops the least recently used people, not everyone', () => {
    _resetAckBucketsForTests()
    expect(takeAckToken('first', 0)).toBe(true)
    expect(takeAckToken('first', 0)).toBe(true)
    expect(takeAckToken('first', 0)).toBe(false)
    for (let i = 0; i < 5000; i++) takeAckToken(`u${i}`, 1)
    // 'first' was the oldest and is gone (a fresh bucket); the newest keep theirs.
    expect(takeAckToken('first', 2)).toBe(true)
    expect(takeAckToken('u4999', 2)).toBe(true)
    expect(takeAckToken('u4999', 2)).toBe(false)
  })

  it('keeps no figures in cloud mode', async () => {
    const redis = fakeRedis()
    process.env.CLOUD_META_DB_URL = 'x'
    try {
      await noteDeliverySample('probe', 100, { redis, node: 'n' })
      expect(redis.hashes.size).toBe(0)
      expect(await computeDeliverySlo(targets, { redis })).toBeNull()
    } finally {
      delete process.env.CLOUD_META_DB_URL
    }
  })

  it('judges delivery per node: one replica under target fails the monitor (3.2)', async () => {
    const redis = fakeRedis()
    const now = Date.UTC(2026, 9, 23, 16, 12, 0)
    // web-1 stalls: 30 of 100 deliveries take 3.5 s; web-2 delivers in 300 ms.
    for (let i = 0; i < 100; i++) {
      await noteDeliverySample('client', i < 30 ? 3500 : 300, {
        redis,
        node: 'staging · web-1',
        at: now - i * 2000
      })
      await noteDeliverySample('client', 300, {
        redis,
        node: 'staging · web-2',
        at: now - i * 2000
      })
    }
    // An old stall outside the window is not counted.
    for (let i = 0; i < 50; i++)
      await noteDeliverySample('client', 9000, {
        redis,
        node: 'staging · web-2',
        at: now - 3 * 3_600_000
      })
    const rows = await deliveryByNodeRecent(15, 2000, { redis, now })
    expect(rows?.map((r) => [r.node, r.samples, r.good_pct])).toEqual([
      ['staging · web-1', 100, 70],
      ['staging · web-2', 100, 100]
    ])
    const v = judgeDeliveryByNode(
      rows ?? [],
      { target_ms: 2000, good_pct: 95, min_samples: 20 },
      15
    )
    expect(v.status).toBe('failing')
    expect(v.metric).toBe(70)
    expect(v.detail.split('Within target:')[0]).toContain('web-1')
    expect(v.detail.split('Within target:')[0]).not.toContain('web-2')

    const quiet = judgeDeliveryByNode(
      rows ?? [],
      { target_ms: 2000, good_pct: 95, min_samples: 500 },
      15
    )
    expect(quiet.status).toBe('unknown')
    const fine = judgeDeliveryByNode(
      (rows ?? []).filter((r) => r.node.endsWith('web-2')),
      { target_ms: 2000, good_pct: 95, min_samples: 20 },
      15
    )
    expect(fine.status).toBe('ok')
  })

  it('per-node delivery is off in cloud mode', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    try {
      expect(await deliveryByNodeRecent(15, 2000, { redis: fakeRedis() })).toBeNull()
    } finally {
      delete process.env.CLOUD_META_DB_URL
    }
  })
})
