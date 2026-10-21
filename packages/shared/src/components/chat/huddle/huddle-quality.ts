/**
 * Huddle call quality (#2849): what a browser reports about its own calls when it leaves —
 * how many of its peer links ran through the TURN relay, how many hit an ICE failure, the
 * average packet loss and round-trip time. Numbers only; the server clamps them again and
 * stores totals per huddle, never per person.
 */

export interface LinkSummary {
  /** The selected candidate pair used a relay (null = no selected pair was found). */
  relay: boolean | null
  lost: number
  received: number
  rttMs: number | null
}

export interface QualityReport {
  relay_share: number
  ice_failed: number
  avg_loss: number | null
  avg_rtt: number | null
}

type StatsLike = { forEach(cb: (value: any) => void): void; get?(id: string): any }

/** One peer connection's stats → the few numbers the report needs (pure). */
export function summarizeStats(report: StatsLike): LinkSummary {
  const byId = new Map<string, any>()
  const all: any[] = []
  report.forEach((v) => {
    all.push(v)
    if (v?.id) byId.set(v.id, v)
  })
  let selectedId: string | null = null
  for (const v of all)
    if (v.type === 'transport' && v.selectedCandidatePairId) selectedId = v.selectedCandidatePairId
  let pair: any = selectedId ? byId.get(selectedId) : null
  if (!pair)
    pair = all.find((v) => v.type === 'candidate-pair' && v.nominated && v.state === 'succeeded')
  let relay: boolean | null = null
  let rttMs: number | null = null
  if (pair) {
    const local = byId.get(pair.localCandidateId)
    const remote = byId.get(pair.remoteCandidateId)
    relay = local?.candidateType === 'relay' || remote?.candidateType === 'relay'
    if (typeof pair.currentRoundTripTime === 'number') rttMs = pair.currentRoundTripTime * 1000
  }
  let lost = 0
  let received = 0
  for (const v of all) {
    if (v.type === 'inbound-rtp' && (v.kind ?? v.mediaType) === 'audio') {
      lost += Math.max(0, Number(v.packetsLost) || 0)
      received += Math.max(0, Number(v.packetsReceived) || 0)
    }
  }
  return { relay, lost, received, rttMs }
}

/** Several links + the ICE failures seen → one report, or null when there is nothing to say. */
export function aggregateQuality(links: LinkSummary[], iceFailed: number): QualityReport | null {
  if (!links.length && !iceFailed) return null
  const known = links.filter((l) => l.relay != null)
  const lost = links.reduce((a, l) => a + l.lost, 0)
  const received = links.reduce((a, l) => a + l.received, 0)
  const rtts = links.map((l) => l.rttMs).filter((v): v is number => v != null)
  return {
    relay_share: known.length ? known.filter((l) => l.relay).length / known.length : 0,
    ice_failed: iceFailed,
    avg_loss: lost + received > 0 ? lost / (lost + received) : null,
    avg_rtt: rtts.length ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length) : null
  }
}
