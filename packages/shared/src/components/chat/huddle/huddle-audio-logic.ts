/**
 * Huddle audio quality and control (#2845–#2848) — the pure decisions, kept
 * apart from the engines that feed them so they can be tested without a
 * browser: when a level counts as speaking, how the stage orders people,
 * which key does what, and how a page of WebRTC stats grades a link.
 */

// ── #2845 Speaking ──────────────────────────────────────────────────────────

/** RMS (0–1) at which a voice starts counting as speaking, and the lower bar it must fall under to stop. */
export const SPEAK_ON = 0.02
export const SPEAK_OFF = 0.012
/** A pause shorter than this (between words) does not end "speaking". */
export const SPEAK_HOLD_MS = 300
/** The stage re-orders people at most this often, so a lively call does not jitter. */
export const REORDER_MS = 2000

/** RMS with hysteresis and a hold: one gate per voice. */
export class SpeakingGate {
  speaking = false
  private quietSince: number | null = null
  constructor(
    private on = SPEAK_ON,
    private off = SPEAK_OFF,
    private holdMs = SPEAK_HOLD_MS
  ) {}
  push(level: number, now: number): boolean {
    if (level >= this.on) {
      this.speaking = true
      this.quietSince = null
    } else if (this.speaking) {
      if (level < this.off) {
        this.quietSince ??= now
        if (now - this.quietSince >= this.holdMs) {
          this.speaking = false
          this.quietSince = null
        }
      } else {
        this.quietSince = null
      }
    }
    return this.speaking
  }
  reset() {
    this.speaking = false
    this.quietSince = null
  }
}

/** Root mean square of a time-domain buffer (samples in -1..1). */
export function rms(samples: ArrayLike<number>): number {
  if (!samples.length) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

/** A meter's 0–1 fill for an RMS level: -60 dBFS reads empty, -10 dBFS full. */
export function meterFill(level: number): number {
  if (level <= 0) return 0
  const db = 20 * Math.log10(level)
  return Math.min(1, Math.max(0, (db + 60) / 50))
}

/** Keep the previous order for people still here, append arrivals in roster order. */
export function reconcileOrder(prev: string[], roster: string[]): string[] {
  const here = new Set(roster)
  const kept = prev.filter((id) => here.has(id))
  const seen = new Set(kept)
  for (const id of roster) if (!seen.has(id)) kept.push(id)
  return kept
}

/** Most recent speaker first; people who never spoke keep their place (stable sort). */
export function orderByLastSpoke(order: string[], lastSpoke: Record<string, number>): string[] {
  return order
    .map((id, i) => ({ id, i, t: lastSpoke[id] ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => (b.t === a.t ? a.i - b.i : b.t > a.t ? 1 : -1))
    .map((x) => x.id)
}

export function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

// ── #2846 Shortcuts ─────────────────────────────────────────────────────────

export type ShortcutAction = 'ptt' | 'mute' | 'share' | 'leave' | 'help'

export interface KeyLike {
  key: string
  code?: string
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  repeat?: boolean
}

/**
 * Where focus is, as far as shortcuts care: typing somewhere (never steal
 * keys), on a control that Space would press, inside a list that types ahead,
 * or on a huddle control itself (where Space is push-to-talk again).
 */
export interface FocusKind {
  editable: boolean
  interactive: boolean
  typeahead: boolean
  inHuddleControls: boolean
}

export const NO_FOCUS: FocusKind = {
  editable: false,
  interactive: false,
  typeahead: false,
  inHuddleControls: false
}

/** Which huddle shortcut a keydown is, if any. Space only means push-to-talk while muted. */
export function shortcutFor(
  e: KeyLike,
  focus: FocusKind,
  ctx: { muted: boolean; canShare: boolean }
): ShortcutAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  if (focus.editable) return null
  const space = e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar'
  if (space) {
    if (!ctx.muted) return null
    if (focus.interactive && !focus.inHuddleControls) return null
    return 'ptt'
  }
  if (e.repeat || focus.typeahead) return null
  if (e.key === '?') return 'help'
  const k = e.key.length === 1 ? e.key.toLowerCase() : ''
  if (k === 'm' && !e.shiftKey) return 'mute'
  if (k === 's' && e.shiftKey) return ctx.canShare ? 'share' : null
  if (k === 'l' && !e.shiftKey) return 'leave'
  return null
}

export const HUDDLE_SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ['Space'], label: 'Hold to talk while muted' },
  { keys: ['M'], label: 'Mute or unmute' },
  { keys: ['Shift', 'S'], label: 'Share your screen or stop' },
  { keys: ['L'], label: 'Leave the huddle' },
  { keys: ['?'], label: 'Show these shortcuts' }
]

// ── #2847 Devices ───────────────────────────────────────────────────────────

export interface DeviceLike {
  deviceId: string
  kind: string
  label: string
  groupId?: string
}

/** A device whose name says it sits on your head (or in your ears). */
const HEADSET = /head(set|phone)|ear(bud|phone|pod)|airpods|buds|bluetooth|hands-?free/i

/** Chrome's pseudo entries ("Default - …", "Communications - …") are never a new device. */
export function isPseudoDevice(d: DeviceLike): boolean {
  return d.deviceId === 'default' || d.deviceId === 'communications' || d.deviceId === ''
}

export type DeviceChange =
  | { kind: 'switch'; device: DeviceLike }
  | { kind: 'fallback' }
  | { kind: 'none' }

/**
 * After `devicechange`: a headset microphone that just appeared wins; the
 * microphone in use disappearing falls back to the default; anything else is
 * left alone.
 */
export function micChange(
  before: DeviceLike[],
  after: DeviceLike[],
  currentId: string | null
): DeviceChange {
  const mics = (l: DeviceLike[]) => l.filter((d) => d.kind === 'audioinput' && !isPseudoDevice(d))
  const known = new Set(mics(before).map((d) => d.deviceId))
  const arrived = mics(after).find((d) => !known.has(d.deviceId) && HEADSET.test(d.label))
  if (arrived && arrived.deviceId !== currentId) return { kind: 'switch', device: arrived }
  if (
    currentId &&
    !isPseudoDevice({ deviceId: currentId, kind: 'audioinput', label: '' }) &&
    !after.some((d) => d.kind === 'audioinput' && d.deviceId === currentId)
  ) {
    return { kind: 'fallback' }
  }
  return { kind: 'none' }
}

// ── #2848 Connection quality ────────────────────────────────────────────────

export interface PeerQuality {
  /** Round trip in ms (null = not measured yet). */
  rtt: number | null
  /** Packet loss in percent, the worse of what I receive and what they report receiving. */
  loss: number | null
  /** Jitter of what I receive, in ms. */
  jitter: number | null
  path: 'direct' | 'relay' | null
  /** Bitrate in kbit/s, in and out. */
  inKbps: number | null
  outKbps: number | null
  /** 0 = unknown, 1 = bad … 4 = good. */
  bars: 0 | 1 | 2 | 3 | 4
  poor: boolean
}

/** Counters carried between two polls of the same link. */
export interface StatsCursor {
  at: number
  bytesIn: number
  bytesOut: number
  lost: number
  received: number
}

export const POOR_LOSS = 5
export const POOR_RTT = 400
/** A link must stay poor this long before anything reacts, and good this long to recover. */
export const POOR_AFTER_MS = 10_000
export const RECOVER_AFTER_MS = 6_000

export function gradeQuality(q: {
  rtt: number | null
  loss: number | null
  jitter: number | null
}): 0 | 1 | 2 | 3 | 4 {
  if (q.rtt == null && q.loss == null) return 0
  const rtt = q.rtt ?? 0
  const loss = q.loss ?? 0
  const jitter = q.jitter ?? 0
  if (rtt < 150 && loss < 1 && jitter < 30) return 4
  if (rtt < 300 && loss < 3 && jitter < 50) return 3
  if (rtt <= POOR_RTT && loss <= POOR_LOSS && jitter < 100) return 2
  return 1
}

export function isPoor(q: { rtt: number | null; loss: number | null }): boolean {
  return (q.loss ?? 0) > POOR_LOSS || (q.rtt ?? 0) > POOR_RTT
}

export type Report = Record<string, any>

/** One poll of `pc.getStats()` (as an array of reports) → this link's quality. */
export function summarizeStats(
  reports: Report[],
  prev: StatsCursor | null,
  now: number
): { quality: PeerQuality; cursor: StatsCursor } {
  const byId = new Map<string, Report>()
  for (const r of reports) if (r?.id) byId.set(r.id, r)
  const transport = reports.find((r) => r.type === 'transport' && r.selectedCandidatePairId)
  const pair =
    (transport && byId.get(transport.selectedCandidatePairId)) ||
    reports.find((r) => r.type === 'candidate-pair' && r.selected) ||
    reports.find((r) => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded')
  const local = pair ? byId.get(pair.localCandidateId) : undefined
  const remote = pair ? byId.get(pair.remoteCandidateId) : undefined
  const path: PeerQuality['path'] = pair
    ? local?.candidateType === 'relay' || remote?.candidateType === 'relay'
      ? 'relay'
      : 'direct'
    : null

  const inbound = reports.filter(
    (r) => r.type === 'inbound-rtp' && (r.kind ?? r.mediaType) === 'audio'
  )
  const remoteIn = reports.filter(
    (r) => r.type === 'remote-inbound-rtp' && (r.kind ?? r.mediaType) === 'audio'
  )
  let lost = 0
  let received = 0
  let jitter: number | null = null
  for (const r of inbound) {
    lost += Math.max(0, Number(r.packetsLost) || 0)
    received += Number(r.packetsReceived) || 0
    if (typeof r.jitter === 'number') jitter = Math.max(jitter ?? 0, r.jitter * 1000)
  }

  let rtt: number | null =
    typeof pair?.currentRoundTripTime === 'number' ? pair.currentRoundTripTime * 1000 : null
  let outLoss: number | null = null
  for (const r of remoteIn) {
    if (rtt == null && typeof r.roundTripTime === 'number') rtt = r.roundTripTime * 1000
    if (typeof r.fractionLost === 'number') outLoss = Math.max(outLoss ?? 0, r.fractionLost * 100)
  }

  let inLoss: number | null = null
  if (prev && inbound.length) {
    const dl = lost - prev.lost
    const dr = received - prev.received
    if (dl + dr > 0) inLoss = (Math.max(0, dl) / (Math.max(0, dl) + Math.max(0, dr))) * 100
  }
  const loss = inLoss == null && outLoss == null ? null : Math.max(inLoss ?? 0, outLoss ?? 0)

  const bytesIn = Number(pair?.bytesReceived) || 0
  const bytesOut = Number(pair?.bytesSent) || 0
  let inKbps: number | null = null
  let outKbps: number | null = null
  if (prev && now > prev.at) {
    const dt = (now - prev.at) / 1000
    inKbps = Math.max(0, ((bytesIn - prev.bytesIn) * 8) / 1000 / dt)
    outKbps = Math.max(0, ((bytesOut - prev.bytesOut) * 8) / 1000 / dt)
  }

  const base = { rtt, loss, jitter }
  return {
    quality: {
      ...base,
      path,
      inKbps,
      outKbps,
      bars: gradeQuality(base),
      poor: isPoor(base)
    },
    cursor: { at: now, bytesIn, bytesOut, lost, received }
  }
}

/** Poor for POOR_AFTER_MS turns it on; good for RECOVER_AFTER_MS turns it off. */
export class PoorDetector {
  active = false
  private since: number | null = null
  constructor(
    private afterMs = POOR_AFTER_MS,
    private recoverMs = RECOVER_AFTER_MS
  ) {}
  push(poor: boolean, now: number): boolean {
    if (poor === this.active) {
      this.since = null
      return this.active
    }
    this.since ??= now
    if (now - this.since >= (this.active ? this.recoverMs : this.afterMs)) {
      this.active = poor
      this.since = null
    }
    return this.active
  }
}

/** "Good connection · 42 ms · 0.3 % loss · 8 ms jitter · direct · 31 kbit/s in, 30 out". */
export function qualityTip(name: string, q: PeerQuality | undefined): string {
  if (!q || q.bars === 0) return `${name} — measuring the connection`
  const word = ['', 'Bad', 'Weak', 'Fair', 'Good'][q.bars]
  const parts = [`${word} connection to ${name}`]
  if (q.rtt != null) parts.push(`${Math.round(q.rtt)} ms`)
  if (q.loss != null) parts.push(`${q.loss < 10 ? q.loss.toFixed(1) : Math.round(q.loss)} % loss`)
  if (q.jitter != null) parts.push(`${Math.round(q.jitter)} ms jitter`)
  if (q.path) parts.push(q.path === 'relay' ? 'via relay' : 'direct')
  if (q.inKbps != null && q.outKbps != null) {
    parts.push(`${Math.round(q.inKbps)} kbit/s in, ${Math.round(q.outKbps)} out`)
  }
  return parts.join(' · ')
}
