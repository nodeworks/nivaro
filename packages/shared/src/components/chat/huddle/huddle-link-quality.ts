import {
  type PeerQuality,
  PoorDetector,
  type StatsCursor,
  summarizeStats
} from './huddle-audio-logic'
import { type HuddleQualitySnapshot, huddleStore } from './huddle-store'

/**
 * Connection quality per peer (#2848). Every 2 s each RTCPeerConnection is
 * asked for its stats; the numbers grade the link (four bars), and two kinds
 * of sustained trouble react:
 *  - one link poor for 10 s while I share → that link's screen track drops to
 *    a lower bitrate and half resolution (RTCRtpSender.setParameters, no
 *    renegotiation), restored once it has been fine for 6 s;
 *  - every connected link poor for 10 s → the problem is most likely my own
 *    connection, and the stage says so.
 */

export interface QualityState {
  peers: Record<string, PeerQuality>
  /** "Your connection is poor" — every connected link has been poor for 10 s. */
  poor: boolean
}

const EMPTY: QualityState = { peers: {}, poor: false }
const POLL_MS = 2000
/** What a poor link gets while I share my screen. */
const POOR_SCREEN = { maxBitrate: 250_000, scaleResolutionDownBy: 2 }

interface LinkWatch {
  cursor: StatsCursor | null
  detector: PoorDetector
  /** The screen sender currently turned down for this link. */
  lowered: RTCRtpSender | null
}

class QualityEngine {
  private state: QualityState = EMPTY
  private listeners = new Set<() => void>()
  private watches = new Map<string, LinkWatch>()
  private local = new PoorDetector()
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private started = false

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }
  getSnapshot = () => this.state
  private emit(next: QualityState) {
    this.state = next
    for (const l of this.listeners) l()
  }

  start() {
    if (this.started || typeof window === 'undefined') return
    this.started = true
    huddleStore.subscribe(() => this.sync())
    this.sync()
  }

  private sync() {
    const live = huddleStore.getSnapshot().status === 'live'
    if (live && !this.timer) {
      this.timer = setInterval(() => void this.poll(), POLL_MS)
    } else if (!live && this.timer) {
      clearInterval(this.timer)
      this.timer = null
      this.watches.clear()
      this.local = new PoorDetector()
      huddleStore.reportQuality(null)
      this.emit(EMPTY)
    }
  }

  private async poll() {
    if (this.polling) return
    this.polling = true
    try {
      await this.pollOnce()
    } finally {
      this.polling = false
    }
  }

  private async pollOnce() {
    const s = huddleStore.getSnapshot()
    if (s.status !== 'live' || !s.room) return
    const now = Date.now()
    const links = huddleStore.peerLinks()
    for (const socket of this.watches.keys()) {
      if (!links.some((l) => l.socket === socket)) this.watches.delete(socket)
    }
    const peers: Record<string, PeerQuality> = {}
    let connected = 0
    let poorLinks = 0
    for (const link of links) {
      if (link.pc.connectionState !== 'connected') continue
      let reports: Array<Record<string, any>>
      try {
        const stats = await link.pc.getStats()
        reports = [...stats.values()]
      } catch {
        continue
      }
      let w = this.watches.get(link.socket)
      if (!w) {
        w = { cursor: null, detector: new PoorDetector(), lowered: null }
        this.watches.set(link.socket, w)
      }
      const { quality, cursor } = summarizeStats(reports, w.cursor, now)
      w.cursor = cursor
      peers[link.socket] = quality
      connected++
      const sustained = w.detector.push(quality.poor, now)
      if (sustained) poorLinks++
      await this.tuneScreen(w, link.screenSender, sustained)
    }
    const poor = this.local.push(connected > 0 && poorLinks === connected, now)
    const next = { peers, poor }
    this.emit(next)
    huddleStore.reportQuality(snapshotOf(s.room, next, now))
  }

  private async tuneScreen(w: LinkWatch, sender: RTCRtpSender | null, poor: boolean) {
    if (w.lowered && w.lowered !== sender) w.lowered = null // the share ended or restarted
    if (!sender) return
    if (poor && !w.lowered) {
      if (await setScreenEncoding(sender, POOR_SCREEN)) w.lowered = sender
    } else if (!poor && w.lowered) {
      if (await setScreenEncoding(sender, null)) w.lowered = null
    }
  }
}

async function setScreenEncoding(
  sender: RTCRtpSender,
  low: { maxBitrate: number; scaleResolutionDownBy: number } | null
): Promise<boolean> {
  try {
    const params = sender.getParameters()
    if (!params.encodings?.length) params.encodings = [{}]
    const enc = params.encodings[0]
    if (low) {
      enc.maxBitrate = low.maxBitrate
      enc.scaleResolutionDownBy = low.scaleResolutionDownBy
    } else {
      delete enc.maxBitrate
      enc.scaleResolutionDownBy = 1
    }
    await sender.setParameters(params)
    return true
  } catch {
    return false
  }
}

function snapshotOf(room: string, q: QualityState, at: number): HuddleQualitySnapshot {
  const users = new Map(huddleStore.getSnapshot().peers.map((p) => [p.socket, p.user]))
  return {
    at,
    room,
    poor: q.poor,
    peers: Object.entries(q.peers).map(([socket, p]) => ({
      socket,
      user: users.get(socket) ?? '',
      rtt: p.rtt,
      loss: p.loss,
      jitter: p.jitter,
      path: p.path,
      inKbps: p.inKbps,
      outKbps: p.outKbps,
      bars: p.bars
    }))
  }
}

export const huddleQuality = new QualityEngine()
