import { createLevelMeter, type LevelMeter } from './huddle-audio'
import {
  orderByLastSpoke,
  REORDER_MS,
  reconcileOrder,
  SpeakingGate,
  sameOrder
} from './huddle-audio-logic'
import { huddleStore } from './huddle-store'

/**
 * Who is speaking (#2845). One analyser per remote voice plus one on a clone
 * of my own microphone (a clone keeps listening while I am muted, which is
 * how "You are muted" knows to appear). Ten readings a second feed a gate per
 * voice; the snapshot only changes when someone starts or stops, so React
 * re-renders at speech pace, not at sample pace.
 */

export interface SpeakingSnapshot {
  /** Peer sockets currently speaking. */
  speaking: Record<string, true>
  /** I am speaking and not muted. */
  selfSpeaking: boolean
  /** I am talking into a muted microphone. */
  mutedTalking: boolean
  /** Peer sockets, most recent speaker first (re-ordered at most every 2 s). */
  order: string[]
}

const EMPTY: SpeakingSnapshot = {
  speaking: {},
  selfSpeaking: false,
  mutedTalking: false,
  order: []
}
const TICK_MS = 100

interface Voice {
  stream: MediaStream
  meter: LevelMeter
  gate: SpeakingGate
}

class SpeakingEngine {
  private snap: SpeakingSnapshot = EMPTY
  private listeners = new Set<() => void>()
  private voices = new Map<string, Voice>()
  private self: (Voice & { source: MediaStream }) | null = null
  private lastSpoke: Record<string, number> = {}
  private lastReorder = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private started = false

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }
  getSnapshot = () => this.snap
  private emit(next: SpeakingSnapshot) {
    this.snap = next
    for (const l of this.listeners) l()
  }

  start() {
    if (this.started || typeof window === 'undefined') return
    this.started = true
    huddleStore.subscribe(() => this.sync())
    this.sync()
  }

  /** My own microphone level right now (0–1 RMS), muted or not; 0 when not in a huddle. */
  selfLevel(): number {
    return this.self?.meter.level() ?? 0
  }

  private sync() {
    const s = huddleStore.getSnapshot()
    if (s.status !== 'live') {
      this.stopAll()
      return
    }
    // Remote voices: one meter per audio stream, rebuilt when the stream object changes.
    for (const [socket, v] of this.voices) {
      const peer = s.peers.find((p) => p.socket === socket)
      if (!peer || peer.audio !== v.stream) {
        v.meter.stop()
        this.voices.delete(socket)
      }
    }
    for (const p of s.peers) {
      if (!p.audio || this.voices.has(p.socket)) continue
      const meter = createLevelMeter(p.audio)
      if (meter) this.voices.set(p.socket, { stream: p.audio, meter, gate: new SpeakingGate() })
    }
    // My microphone: a clone, so the meter still hears me while the sent track is disabled.
    const mic = huddleStore.localMic()
    if (this.self && this.self.source !== mic) this.dropSelf()
    if (!this.self && mic) {
      const track = mic.getAudioTracks()[0]
      if (track) {
        const clone = new MediaStream([track.clone()])
        const meter = createLevelMeter(clone)
        if (meter) this.self = { source: mic, stream: clone, meter, gate: new SpeakingGate() }
        else for (const t of clone.getTracks()) t.stop()
      }
    }
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  private tick() {
    const s = huddleStore.getSnapshot()
    if (s.status !== 'live') return
    const now = Date.now()
    const speaking: Record<string, true> = {}
    for (const p of s.peers) {
      const v = this.voices.get(p.socket)
      if (!v) continue
      const on = v.gate.push(p.muted ? 0 : v.meter.level(), now)
      if (on) {
        speaking[p.socket] = true
        this.lastSpoke[p.socket] = now
      }
    }
    const selfOn = this.self ? this.self.gate.push(this.self.meter.level(), now) : false
    const selfSpeaking = selfOn && !s.muted
    const mutedTalking = selfOn && s.muted

    const roster = s.peers.map((p) => p.socket)
    let order = reconcileOrder(this.snap.order, roster)
    if (now - this.lastReorder >= REORDER_MS) {
      const sorted = orderByLastSpoke(order, this.lastSpoke)
      if (!sameOrder(sorted, order)) {
        order = sorted
        this.lastReorder = now
      }
    }

    const prev = this.snap
    const keys = Object.keys(speaking)
    const changed =
      prev.selfSpeaking !== selfSpeaking ||
      prev.mutedTalking !== mutedTalking ||
      !sameOrder(prev.order, order) ||
      keys.length !== Object.keys(prev.speaking).length ||
      keys.some((k) => !prev.speaking[k])
    if (changed) this.emit({ speaking, selfSpeaking, mutedTalking, order })
  }

  private dropSelf() {
    if (!this.self) return
    this.self.meter.stop()
    for (const t of this.self.stream.getTracks()) t.stop()
    this.self = null
  }

  private stopAll() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const [, v] of this.voices) v.meter.stop()
    this.voices.clear()
    this.dropSelf()
    this.lastSpoke = {}
    this.lastReorder = 0
    if (this.snap !== EMPTY) this.emit(EMPTY)
  }
}

export const huddleSpeaking = new SpeakingEngine()
