import { describe, expect, it } from 'vitest'
import type { PeerQuality } from './huddle-audio-logic'
import { POOR_SCREEN, QualityEngine, type QualityHost, withSfuGrade } from './huddle-link-quality'
import { aggregateQuality, type LinkSummary } from './huddle-quality'
import type { SfuStats } from './huddle-sfu'
import type { HuddleQualitySnapshot } from './huddle-store'

/** One link's stats page: a selected pair (direct or relay) + audio in/out counters. */
function page(o: { relay?: boolean; rtt?: number; lost?: number; received?: number }) {
  return [
    { id: 't', type: 'transport', selectedCandidatePairId: 'p' },
    {
      id: 'p',
      type: 'candidate-pair',
      localCandidateId: 'l',
      remoteCandidateId: 'r',
      currentRoundTripTime: (o.rtt ?? 40) / 1000,
      bytesReceived: 1000,
      bytesSent: 1000
    },
    { id: 'l', type: 'local-candidate', candidateType: o.relay ? 'relay' : 'host' },
    { id: 'r', type: 'remote-candidate', candidateType: 'srflx' },
    {
      id: 'in',
      type: 'inbound-rtp',
      kind: 'audio',
      packetsLost: o.lost ?? 0,
      packetsReceived: o.received ?? 100,
      jitter: 0.005
    }
  ]
}

function fakeSender() {
  const params: { encodings: Array<Record<string, unknown>> } = { encodings: [{}] }
  return {
    params,
    getParameters: () => params,
    setParameters: async (p: typeof params) => {
      params.encodings = p.encodings
    }
  } as unknown as RTCRtpSender & { params: typeof params }
}

function harness(sources: () => Awaited<ReturnType<QualityHost['sources']>>) {
  const reports: Array<HuddleQualitySnapshot | null> = []
  const recorded = new Map<string, LinkSummary>()
  const host: QualityHost = {
    subscribe: () => () => undefined,
    live: () => ({
      room: 'ch:1',
      users: new Map([
        ['A', 'u-a'],
        ['B', 'u-b']
      ])
    }),
    sources: async () => sources(),
    report: (q) => reports.push(q),
    record: (s, sum) => recorded.set(s, sum)
  }
  return { engine: new QualityEngine(host), reports, recorded }
}

describe('one quality sampler, mesh mode (#2848/#2849)', () => {
  it('grades each connected link, records it for the leave report, and skips the rest', async () => {
    let lost = 0
    const pcA = {
      connectionState: 'connected',
      getStats: async () =>
        new Map(page({ relay: true, lost, received: 100 }).map((r) => [r.id, r]))
    }
    const pcB = { connectionState: 'connecting', getStats: async () => new Map() }
    const { engine, reports, recorded } = harness(() => ({
      mode: 'mesh',
      links: [
        { socket: 'A', pc: pcA as unknown as RTCPeerConnection, screenSender: null },
        { socket: 'B', pc: pcB as unknown as RTCPeerConnection, screenSender: null }
      ]
    }))
    await engine.sample(1000)
    lost = 2
    await engine.sample(3000)
    const snap = engine.getSnapshot()
    expect(Object.keys(snap.peers)).toEqual(['A'])
    expect(snap.peers.A.path).toBe('relay')
    expect(reports.at(-1)?.peers[0]).toMatchObject({ socket: 'A', user: 'u-a', path: 'relay' })
    // The leave report is built from the same sample.
    expect(recorded.get('A')).toEqual({ relay: true, lost: 2, received: 100, rttMs: 40 })
    expect(recorded.has('B')).toBe(false)
    expect(aggregateQuality([...recorded.values()], 0)).toMatchObject({ relay_share: 1 })
  })

  it('turns a poor link’s screen down after 10 s and the banner on when every link is poor', async () => {
    const sender = fakeSender()
    const pc = {
      connectionState: 'connected',
      getStats: async () => new Map(page({ rtt: 900 }).map((r) => [r.id, r]))
    }
    const { engine } = harness(() => ({
      mode: 'mesh',
      links: [{ socket: 'A', pc: pc as unknown as RTCPeerConnection, screenSender: sender }]
    }))
    for (let t = 0; t <= 10_000; t += 2000) await engine.sample(t)
    expect(sender.params.encodings[0]).toMatchObject(POOR_SCREEN)
    // The banner waits for every link to have been poor (sustained) for another 10 s.
    expect(engine.getSnapshot().poor).toBe(false)
    for (let t = 12_000; t <= 20_000; t += 2000) await engine.sample(t)
    expect(engine.getSnapshot().poor).toBe(true)
  })
})

describe('one quality sampler, SFU mode (#2859)', () => {
  const sfu = (o: {
    grade?: SfuStats['local']['grade']
    peerGrade?: SfuStats['local']['grade']
    rtt?: number
    sender?: RTCRtpSender | null
  }): SfuStats => ({
    peers: [{ socket: 'B', reports: page({ relay: false }), grade: o.peerGrade ?? 'excellent' }],
    local: { reports: page({ rtt: o.rtt ?? 40 }), grade: o.grade ?? 'excellent' },
    screenSender: o.sender ?? null
  })

  it('grades each person from their voice’s receiver stats and LiveKit’s grade', async () => {
    const { engine, recorded } = harness(() => ({ mode: 'sfu', sfu: sfu({ peerGrade: 'poor' }) }))
    await engine.sample(1000)
    const b = engine.getSnapshot().peers.B
    expect(b.bars).toBe(1)
    expect(b.poor).toBe(true)
    expect(recorded.get('B')).toMatchObject({ relay: false, received: 100 })
    // A peer's poor link is theirs, not mine: no banner.
    expect(engine.getSnapshot().poor).toBe(false)
  })

  it('my uplink decides the banner and the screen downshift', async () => {
    const sender = fakeSender()
    let grade: SfuStats['local']['grade'] = 'lost'
    const { engine } = harness(() => ({ mode: 'sfu', sfu: sfu({ grade, sender }) }))
    for (let t = 0; t <= 10_000; t += 2000) await engine.sample(t)
    expect(engine.getSnapshot().poor).toBe(true)
    expect(sender.params.encodings[0]).toMatchObject(POOR_SCREEN)
    grade = 'excellent'
    for (let t = 12_000; t <= 20_000; t += 2000) await engine.sample(t)
    expect(engine.getSnapshot().poor).toBe(false)
    expect(sender.params.encodings[0]).toMatchObject({ scaleResolutionDownBy: 1 })
    expect(sender.params.encodings[0].maxBitrate).toBeUndefined()
  })

  it('a link still (re)connecting yields no peers and keeps the last verdict', async () => {
    const { engine, reports } = harness(() => ({ mode: 'sfu', sfu: null }))
    await engine.sample(1000)
    expect(engine.getSnapshot()).toEqual({ peers: {}, poor: false })
    expect(reports).toHaveLength(1)
  })

  it('switching modes starts the counters afresh', async () => {
    let mode: 'mesh' | 'sfu' = 'mesh'
    const pc = {
      connectionState: 'connected',
      getStats: async () => new Map(page({ lost: 50, received: 50 }).map((r) => [r.id, r]))
    }
    const { engine } = harness(() =>
      mode === 'mesh'
        ? {
            mode,
            links: [{ socket: 'B', pc: pc as unknown as RTCPeerConnection, screenSender: null }]
          }
        : { mode, sfu: sfu({}) }
    )
    await engine.sample(1000)
    mode = 'sfu'
    await engine.sample(3000)
    // No delta against the mesh link's counters: loss is unknown on the first SFU poll.
    expect(engine.getSnapshot().peers.B.loss).toBeNull()
  })
})

describe('withSfuGrade', () => {
  const q: PeerQuality = {
    rtt: 40,
    loss: 0,
    jitter: 5,
    path: 'direct',
    inKbps: null,
    outKbps: null,
    bars: 4,
    poor: false
  }
  it('only ever lowers the bars', () => {
    expect(withSfuGrade(q, 'good').bars).toBe(3)
    expect(withSfuGrade({ ...q, bars: 2 }, 'excellent').bars).toBe(2)
    expect(withSfuGrade({ ...q, bars: 0 }, 'excellent').bars).toBe(4)
    expect(withSfuGrade(q, 'unknown')).toBe(q)
    expect(withSfuGrade(q, 'lost')).toMatchObject({ bars: 1, poor: true })
  })
})
