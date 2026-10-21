/**
 * Huddle call quality (#2849): what a browser reports about its own calls when it leaves —
 * how many of its peer links ran through the TURN relay, how many hit an ICE failure, the
 * average packet loss and round-trip time. Numbers only; the server clamps them again and
 * stores totals per huddle, never per person.
 */
import type { PeerQuality, StatsCursor } from './huddle-audio-logic'

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

/**
 * One link as the quality sampler last measured it (huddle-link-quality.ts, both media
 * modes) → the few numbers the report needs (pure). Loss counts are the running totals.
 */
export function linkSummaryOf(
  q: Pick<PeerQuality, 'path' | 'rtt'>,
  cursor: Pick<StatsCursor, 'lost' | 'received'>
): LinkSummary {
  return {
    relay: q.path == null ? null : q.path === 'relay',
    lost: cursor.lost,
    received: cursor.received,
    rttMs: q.rtt == null ? null : q.rtt
  }
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
