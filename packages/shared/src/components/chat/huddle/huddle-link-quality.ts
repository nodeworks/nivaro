import {
  type PeerQuality,
  PoorDetector,
  type Report,
  type StatsCursor,
  summarizeStats
} from './huddle-audio-logic'
import { type LinkSummary, linkSummaryOf } from './huddle-quality'
import type { SfuGrade, SfuStats } from './huddle-sfu'
import { type HuddleQualitySnapshot, huddleStore } from './huddle-store'

/**
 * Connection quality (#2848) and the leave-time call report (#2849) — ONE
 * sampler for both, in both media modes. Every 2 s it reads the stats:
 *  - mesh: each RTCPeerConnection's getStats();
 *  - SFU (#2859, LiveKit): the receiver stats of each person's voice, my
 *    microphone's sender stats, and LiveKit's own connection grade per person.
 * The numbers grade each link (four bars), are kept per link for the report
 * sent on Leave, and two kinds of sustained trouble react:
 *  - mesh: one link poor for 10 s while I share → that link's screen track
 *    drops to a lower bitrate and half resolution (RTCRtpSender.setParameters,
 *    no renegotiation), restored once it has been fine for 6 s; every
 *    connected link poor for 10 s → "Your connection is poor";
 *  - SFU: one upload serves everyone, so MY uplink decides both — poor for
 *    10 s turns the screen down and shows the banner.
 */

export interface QualityState {
  peers: Record<string, PeerQuality>
  /** "Your connection is poor" — my side of the call has been poor for 10 s. */
  poor: boolean
}

const EMPTY: QualityState = { peers: {}, poor: false }
export const QUALITY_POLL_MS = 2000
/** What a poor link gets while I share my screen. */
export const POOR_SCREEN = { maxBitrate: 250_000, scaleResolutionDownBy: 2 }

/** LiveKit's grade → bars: it only ever lowers what the stats say, and poor/lost is poor. */
export function withSfuGrade(q: PeerQuality, grade: SfuGrade | null): PeerQuality {
  if (!grade || grade === 'unknown') return q
  const lk = grade === 'excellent' ? 4 : grade === 'good' ? 3 : 1
  const bars = (q.bars === 0 ? lk : Math.min(q.bars, lk)) as PeerQuality['bars']
  return { ...q, bars, poor: q.poor || grade === 'poor' || grade === 'lost' }
}

type MeshLink = { socket: string; pc: RTCPeerConnection; screenSender: RTCRtpSender | null }

/** Where the sampler reads from and writes to — the huddle store, or a test's fake. */
export interface QualityHost {
  subscribe(l: () => void): () => void
  /** The room I am live in and who is in it (socket → user id); null when not live. */
  live(): { room: string; users: Map<string, string> } | null
  sources(): Promise<{ mode: 'mesh'; links: MeshLink[] } | { mode: 'sfu'; sfu: SfuStats | null }>
  /** The latest snapshot, for getHuddleQuality(). */
  report(q: HuddleQualitySnapshot | null): void
  /** One link's numbers for the report sent on Leave (#2849). */
  record(socket: string, summary: LinkSummary): void
}

interface LinkWatch {
  cursor: StatsCursor | null
  detector: PoorDetector
  /** The screen sender currently turned down for this link. */
  lowered: RTCRtpSender | null
}

const newWatch = (): LinkWatch => ({ cursor: null, detector: new PoorDetector(), lowered: null })

export class QualityEngine {
  private state: QualityState = EMPTY
  private listeners = new Set<() => void>()
  private watches = new Map<string, LinkWatch>()
  /** My own side: every mesh link poor, or (SFU) my uplink poor. */
  private local = newWatch()
  private mode: 'mesh' | 'sfu' | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private started = false

  constructor(
    private host: QualityHost,
    private pollMs = QUALITY_POLL_MS
  ) {}

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
    this.host.subscribe(() => this.sync())
    this.sync()
  }

  private reset() {
    this.watches.clear()
    this.local = newWatch()
    this.mode = null
  }

  private sync() {
    const live = !!this.host.live()
    if (live && !this.timer) {
      this.timer = setInterval(() => void this.poll(), this.pollMs)
    } else if (!live && this.timer) {
      clearInterval(this.timer)
      this.timer = null
      this.reset()
      this.host.report(null)
      this.emit(EMPTY)
    }
  }

  private async poll() {
    if (this.polling) return
    this.polling = true
    try {
      await this.sample()
    } finally {
      this.polling = false
    }
  }

  /** One poll (public for tests). */
  async sample(now = Date.now()): Promise<void> {
    const live = this.host.live()
    if (!live) return
    const src = await this.host.sources()
    // Counters from a mesh connection mean nothing to the SFU link (and back).
    if (this.mode !== src.mode) {
      this.reset()
      this.mode = src.mode
    }
    const peers: Record<string, PeerQuality> = {}
    let poor: boolean
    if (src.mode === 'mesh') {
      this.prune(src.links.map((l) => l.socket))
      let connected = 0
      let poorLinks = 0
      for (const link of src.links) {
        if (link.pc.connectionState !== 'connected') continue
        let reports: Report[]
        try {
          reports = [...(await link.pc.getStats()).values()]
        } catch {
          continue
        }
        const { quality, watch } = this.measure(link.socket, reports, null, now, true)
        peers[link.socket] = quality
        connected++
        const sustained = watch.detector.push(quality.poor, now)
        if (sustained) poorLinks++
        await tuneScreen(watch, link.screenSender, sustained)
      }
      poor = this.local.detector.push(connected > 0 && poorLinks === connected, now)
    } else if (src.sfu) {
      const sfu = src.sfu
      this.prune(sfu.peers.map((p) => p.socket))
      for (const p of sfu.peers) {
        const { quality, watch } = this.measure(p.socket, p.reports, p.grade, now, true)
        peers[p.socket] = quality
        watch.detector.push(quality.poor, now)
      }
      const mine = this.measureLocal(sfu.local.reports, sfu.local.grade, now)
      poor = this.local.detector.push(mine.poor, now)
      await tuneScreen(this.local, sfu.screenSender, poor)
    } else {
      // The SFU link is (re)connecting: nothing to measure this round.
      poor = this.local.detector.active
    }
    const next = { peers, poor }
    this.emit(next)
    this.host.report(snapshotOf(live.room, live.users, next, now))
  }

  private prune(sockets: string[]) {
    for (const socket of this.watches.keys()) {
      if (!sockets.includes(socket)) this.watches.delete(socket)
    }
  }

  private measure(
    socket: string,
    reports: Report[],
    grade: SfuGrade | null,
    now: number,
    record: boolean
  ): { quality: PeerQuality; watch: LinkWatch } {
    let watch = this.watches.get(socket)
    if (!watch) {
      watch = newWatch()
      this.watches.set(socket, watch)
    }
    const { quality, cursor } = summarizeStats(reports, watch.cursor, now)
    watch.cursor = cursor
    const graded = withSfuGrade(quality, grade)
    if (record) this.host.record(socket, linkSummaryOf(graded, cursor))
    return { quality: graded, watch }
  }

  private measureLocal(reports: Report[], grade: SfuGrade, now: number): PeerQuality {
    const { quality, cursor } = summarizeStats(reports, this.local.cursor, now)
    this.local.cursor = cursor
    return withSfuGrade(quality, grade)
  }
}

async function tuneScreen(w: LinkWatch, sender: RTCRtpSender | null, poor: boolean) {
  if (w.lowered && w.lowered !== sender) w.lowered = null // the share ended or restarted
  if (!sender) return
  if (poor && !w.lowered) {
    if (await setScreenEncoding(sender, POOR_SCREEN)) w.lowered = sender
  } else if (!poor && w.lowered) {
    if (await setScreenEncoding(sender, null)) w.lowered = null
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

function snapshotOf(
  room: string,
  users: Map<string, string>,
  q: QualityState,
  at: number
): HuddleQualitySnapshot {
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

const storeHost: QualityHost = {
  subscribe: (l) => huddleStore.subscribe(l),
  live: () => {
    const s = huddleStore.getSnapshot()
    if (s.status !== 'live' || !s.room) return null
    return { room: s.room, users: new Map(s.peers.map((p) => [p.socket, p.user])) }
  },
  sources: () => huddleStore.qualitySources(),
  report: (q) => huddleStore.reportQuality(q),
  record: (socket, summary) => huddleStore.recordLinkStats(socket, summary)
}

export const huddleQuality = new QualityEngine(storeHost)
