/**
 * Huddles (#2457) — the browser side, as one module store that outlives any
 * room view: you can open another room, or close the chat panel, and keep
 * talking. React reads it through useSyncExternalStore (see useHuddle.ts).
 *
 * Media is a WebRTC mesh: every participant holds one RTCPeerConnection per
 * other participant, carrying the microphone and, while sharing, a screen
 * track. Offers, answers and candidates are relayed by the server over the
 * chat socket (`huddle:signal`); it never sees audio. Negotiation follows the
 * "perfect negotiation" pattern, with the lower socket id the polite side, so
 * two people joining at once never deadlock.
 *
 * Nothing here imports socket.io: the transport is the host's RealtimeAdapter
 * (`on` / `emit`), which admin and portals already mount.
 */

import { huddleLive } from './huddle-live'
import { aggregateQuality, type LinkSummary, summarizeStats } from './huddle-quality'

export interface HuddlePeer {
  socket: string
  user: string
  name: string | null
  muted: boolean
  screen: boolean
  since: number
}

export interface HuddleTransport {
  on(event: string, cb: (payload: any) => void): () => void
  emit(event: string, payload?: any): void
}

export interface IceConfig {
  enabled: boolean
  iceServers: RTCIceServer[]
  ttl_s: number
  max_participants: number
}

export type HuddleStatus = 'idle' | 'joining' | 'live' | 'error'

export interface LivePeer extends HuddlePeer {
  /** The peer's microphone, once the connection delivered it. */
  audio: MediaStream | null
  /** The peer's screen, while they share. */
  video: MediaStream | null
  connection: 'new' | 'connecting' | 'connected' | 'failed'
}

export interface HuddleState {
  /** The room whose huddle I am in (null = none). */
  room: string | null
  status: HuddleStatus
  error: string | null
  self: string | null
  muted: boolean
  sharing: boolean
  localScreen: MediaStream | null
  startedAt: number | null
  peers: LivePeer[]
}

const IDLE: HuddleState = {
  room: null,
  status: 'idle',
  error: null,
  self: null,
  muted: false,
  sharing: false,
  localScreen: null,
  startedAt: null,
  peers: []
}

/** Every 15 s the server hears we are still here (it forgets us after 45 s). */
const PING_MS = 15_000

/** The lower socket id yields in a glare (perfect negotiation's "polite" side). */
export function politeFor(self: string, other: string): boolean {
  return self < other
}

/** Merge a fresh roster into the live peers, keeping streams and connection state. */
export function mergeRoster(
  current: LivePeer[],
  roster: HuddlePeer[],
  self: string | null
): LivePeer[] {
  const out: LivePeer[] = []
  for (const p of roster) {
    if (p.socket === self) continue
    const prev = current.find((c) => c.socket === p.socket)
    out.push(
      prev
        ? { ...prev, name: p.name, muted: p.muted, screen: p.screen, user: p.user, since: p.since }
        : { ...p, audio: null, video: null, connection: 'new' }
    )
  }
  return out
}

/** "Rob, Amy and 2 others" for the header pill. */
export function peerSummary(peers: Array<{ name: string | null }>): string {
  const names = peers.map((p) => p.name || 'Someone')
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names[0]}, ${names[1]} and ${names.length - 2} other${names.length - 2 === 1 ? '' : 's'}`
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const mm = String(m % 60).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

interface PeerLink {
  pc: RTCPeerConnection
  polite: boolean
  makingOffer: boolean
  ignoreOffer: boolean
  screenSender: RTCRtpSender | null
  /** Signals from this peer are applied one at a time, in the order they came. */
  queue: Promise<void>
}

type Listener = () => void

class HuddleStore {
  private state: HuddleState = IDLE
  private listeners = new Set<Listener>()
  /** Who is in each room's huddle (rooms I am NOT in too) — from the server's broadcasts. */
  private rosters = new Map<string, HuddlePeer[]>()
  private rosterListeners = new Set<Listener>()
  private transport: HuddleTransport | null = null
  private offs: Array<() => void> = []
  private links = new Map<string, PeerLink>()
  private mic: MediaStream | null = null
  /** The last /ice answer, per room: TURN credentials are minted for the room being joined. */
  private ice: { room: string; at: number; cfg: IceConfig } | null = null
  private fetchIce: ((room: string) => Promise<IceConfig>) | null = null
  private ping: ReturnType<typeof setInterval> | null = null
  /** One hidden <audio> per peer, owned here so sound survives any room view unmounting. */
  private audio = new Map<string, HTMLAudioElement>()
  /** #2849 — the latest stats per peer link (sampled on each ping) and the ICE failures seen. */
  private linkStats = new Map<string, LinkSummary>()
  private iceFailed = 0

  // ── React plumbing ────────────────────────────────────────────────────────
  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }
  getSnapshot = () => this.state
  subscribeRosters = (l: Listener) => {
    this.rosterListeners.add(l)
    return () => {
      this.rosterListeners.delete(l)
    }
  }
  roster(room: string): HuddlePeer[] | undefined {
    return this.rosters.get(room)
  }
  private set(patch: Partial<HuddleState>) {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }
  private setRoster(room: string, peers: HuddlePeer[]) {
    this.rosters.set(room, peers)
    for (const l of this.rosterListeners) l()
  }
  /** A REST read of a room's roster (the first paint, before any broadcast). */
  seedRoster(room: string, peers: HuddlePeer[]) {
    if (!this.rosters.has(room)) this.setRoster(room, peers)
  }

  // ── Transport ─────────────────────────────────────────────────────────────
  /** Bind the host's socket adapter once; later calls with the same adapter are no-ops. */
  attach(transport: HuddleTransport, fetchIce: (room: string) => Promise<IceConfig>) {
    this.fetchIce = fetchIce
    if (this.transport === transport) return
    for (const off of this.offs) off()
    this.transport = transport
    huddleLive.attach(transport)
    this.offs = [
      transport.on('huddle:peers', (p: { room: string; peers: HuddlePeer[] }) => this.onPeers(p)),
      transport.on('huddle:joined', (p: { room: string; self: string; peers: HuddlePeer[] }) =>
        this.onJoined(p)
      ),
      transport.on('huddle:signal', (p: SignalIn) => void this.onSignal(p)),
      transport.on('huddle:denied', (p: { room: string | null; reason: string }) =>
        this.onDenied(p)
      ),
      // A reconnect is a new server socket: join again and rebuild every link.
      transport.on('auth:ok', () => {
        if (this.state.room && this.state.status === 'live') {
          this.transport?.emit('huddle:join', { room: this.state.room })
        }
      })
    ]
  }

  private async iceServers(room: string): Promise<RTCIceServer[]> {
    if (!this.fetchIce) return []
    const ttl = this.ice ? Math.min(this.ice.cfg.ttl_s, 3600) * 1000 * 0.8 : 0
    if (!this.ice || this.ice.room !== room || Date.now() - this.ice.at > ttl) {
      this.ice = { room, at: Date.now(), cfg: await this.fetchIce(room) }
    }
    return this.ice.cfg.iceServers
  }

  // ── Join / leave ──────────────────────────────────────────────────────────
  async join(room: string): Promise<void> {
    if (!this.transport) return
    const active = this.state.status === 'joining' || this.state.status === 'live'
    if (this.state.room === room && active) return
    if (this.state.room && active) this.leave()
    this.linkStats.clear()
    this.iceFailed = 0
    this.set({ room, status: 'joining', error: null, startedAt: null })
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      })
    } catch (err) {
      const name = (err as { name?: string })?.name
      this.set({
        status: 'error',
        error:
          name === 'NotAllowedError'
            ? 'Microphone access was refused. Allow it in the browser and try again.'
            : name === 'NotFoundError'
              ? 'No microphone was found.'
              : 'The microphone could not be started.'
      })
      return
    }
    for (const t of this.mic.getAudioTracks()) t.enabled = !this.state.muted
    await this.iceServers(room).catch(() => null)
    this.transport.emit('huddle:join', { room })
  }

  leave(): void {
    const room = this.state.room
    if (room) {
      // Sent before the leave, on the same socket, so the server tallies it into the session.
      const report = aggregateQuality([...this.linkStats.values()], this.iceFailed)
      if (report && this.state.status === 'live') {
        this.transport?.emit('huddle:quality', { room, ...report })
      }
      this.transport?.emit('huddle:leave', { room })
    }
    this.teardown()
  }

  private teardown() {
    if (this.ping) clearInterval(this.ping)
    this.ping = null
    for (const [socket, link] of this.links) {
      link.pc.close()
      this.dropAudio(socket)
    }
    this.links.clear()
    for (const t of this.mic?.getTracks() ?? []) t.stop()
    this.mic = null
    for (const t of this.state.localScreen?.getTracks() ?? []) t.stop()
    this.set({ ...IDLE, muted: this.state.muted })
  }

  private onJoined(p: { room: string; self: string; peers: HuddlePeer[] }) {
    if (p.room !== this.state.room) return
    // A rejoin after a reconnect: every old link names a socket id that is gone.
    if (this.state.self && this.state.self !== p.self) {
      for (const [socket, link] of this.links) {
        link.pc.close()
        this.dropAudio(socket)
      }
      this.links.clear()
    }
    const peers = mergeRoster([], p.peers, p.self)
    const since = Math.min(Date.now(), ...p.peers.map((x) => x.since).filter(Boolean))
    this.set({ status: 'live', self: p.self, peers, startedAt: since, error: null })
    for (const peer of peers) void this.link(peer.socket)
    if (this.ping) clearInterval(this.ping)
    this.ping = setInterval(() => {
      if (this.state.room) this.transport?.emit('huddle:ping', { room: this.state.room })
      void this.sampleQuality()
    }, PING_MS)
    if (this.state.muted || this.state.sharing) {
      this.transport?.emit('huddle:state', {
        room: p.room,
        muted: this.state.muted,
        screen: this.state.sharing
      })
    }
  }

  private onPeers(p: { room: string; peers: HuddlePeer[] }) {
    this.setRoster(p.room, p.peers)
    if (p.room !== this.state.room || this.state.status !== 'live') return
    const self = this.state.self
    const peers = mergeRoster(this.state.peers, p.peers, self)
    // Links to people who left close; people who arrived get one.
    for (const [socket, link] of this.links) {
      if (!peers.some((x) => x.socket === socket)) {
        link.pc.close()
        this.links.delete(socket)
        this.dropAudio(socket)
      }
    }
    // A link whose tracks arrived before the roster named the peer: pick them up now.
    for (const peer of peers) {
      const link = this.links.get(peer.socket)
      if (!link || peer.audio || peer.video) continue
      for (const r of link.pc.getReceivers()) {
        if (r.track?.readyState !== 'live') continue
        const ms = new MediaStream([r.track])
        if (r.track.kind === 'video') peer.video = ms
        else peer.audio = ms
      }
    }
    this.set({ peers })
    for (const peer of peers) if (!this.links.has(peer.socket)) void this.link(peer.socket)
  }

  private onDenied(p: { room: string | null; reason: string }) {
    if (p.room && p.room !== this.state.room) return
    const text: Record<string, string> = {
      full: 'This huddle is full.',
      'no-access': 'You no longer have access to this room.',
      off: 'Huddles are turned off on this instance.',
      'no-dm': 'Huddles run in channels and record rooms.',
      'not-signed-in': 'Sign in again to join.',
      unavailable: 'The huddle service is unavailable right now.'
    }
    this.teardown()
    this.set({
      status: 'error',
      error: text[p.reason] ?? 'Could not join the huddle.',
      room: p.room
    })
  }

  clearError() {
    if (this.state.status === 'error') this.set({ ...IDLE, muted: this.state.muted })
  }

  // ── Peer links ────────────────────────────────────────────────────────────
  private updatePeer(socket: string, patch: Partial<LivePeer>) {
    this.set({
      peers: this.state.peers.map((p) => (p.socket === socket ? { ...p, ...patch } : p))
    })
  }

  private async link(socket: string): Promise<PeerLink | null> {
    const existing = this.links.get(socket)
    if (existing) return existing
    const self = this.state.self
    const room = this.state.room
    if (!self || !room || !this.transport) return null
    const iceServers = await this.iceServers(room).catch(() => [] as RTCIceServer[])
    if (this.links.has(socket)) return this.links.get(socket) ?? null
    const pc = new RTCPeerConnection({ iceServers })
    const link: PeerLink = {
      pc,
      polite: politeFor(self, socket),
      makingOffer: false,
      ignoreOffer: false,
      screenSender: null,
      queue: Promise.resolve()
    }
    this.links.set(socket, link)
    for (const t of this.mic?.getAudioTracks() ?? []) pc.addTrack(t, this.mic as MediaStream)
    const screen = this.state.localScreen?.getVideoTracks()[0]
    if (screen && this.state.localScreen) {
      link.screenSender = pc.addTrack(screen, this.state.localScreen)
    }
    pc.onnegotiationneeded = async () => {
      try {
        link.makingOffer = true
        await pc.setLocalDescription()
        this.signal(socket, { description: pc.localDescription })
      } catch {
        /* the next change negotiates again */
      } finally {
        link.makingOffer = false
      }
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal(socket, { candidate: e.candidate.toJSON() })
    }
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track])
      if (e.track.kind === 'video') {
        this.updatePeer(socket, { video: stream })
        e.track.onended = () => this.updatePeer(socket, { video: null })
        e.track.onmute = () => this.updatePeer(socket, { video: null })
        e.track.onunmute = () => this.updatePeer(socket, { video: stream })
      } else {
        this.updatePeer(socket, { audio: stream })
        this.playAudio(socket, stream)
      }
    }
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState
      this.updatePeer(socket, {
        connection:
          s === 'connected'
            ? 'connected'
            : s === 'failed' || s === 'closed'
              ? 'failed'
              : 'connecting'
      })
      if (s === 'failed') {
        this.iceFailed++
        pc.restartIce?.()
      }
    }
    return link
  }

  private async sampleQuality() {
    for (const [socket, link] of this.links) {
      try {
        this.linkStats.set(socket, summarizeStats(await link.pc.getStats()))
      } catch {
        /* a closed link has no stats */
      }
    }
  }

  private playAudio(socket: string, stream: MediaStream) {
    if (typeof document === 'undefined') return
    let el = this.audio.get(socket)
    if (!el) {
      el = document.createElement('audio')
      el.autoplay = true
      el.setAttribute('data-huddle-audio', socket)
      el.style.display = 'none'
      document.body.appendChild(el)
      this.audio.set(socket, el)
    }
    el.srcObject = stream
    void el.play().catch(() => null)
  }

  private dropAudio(socket: string) {
    const el = this.audio.get(socket)
    if (!el) return
    el.srcObject = null
    el.remove()
    this.audio.delete(socket)
  }

  private signal(to: string, data: unknown) {
    if (!this.state.room) return
    this.transport?.emit('huddle:signal', { room: this.state.room, to, data })
  }

  private async onSignal(p: SignalIn) {
    if (p.room !== this.state.room || this.state.status !== 'live') return
    const link = await this.link(p.from)
    if (!link) return
    link.queue = link.queue.then(() => this.applySignal(link, p)).catch(() => undefined)
    return link.queue
  }

  private async applySignal(link: PeerLink, p: SignalIn) {
    const { pc } = link
    if (pc.signalingState === 'closed') return
    try {
      if (p.data.description) {
        const description = p.data.description
        const collision =
          description.type === 'offer' && (link.makingOffer || pc.signalingState !== 'stable')
        link.ignoreOffer = !link.polite && collision
        if (link.ignoreOffer) return
        await pc.setRemoteDescription(description)
        if (description.type === 'offer') {
          await pc.setLocalDescription()
          this.signal(p.from, { description: pc.localDescription })
        }
      } else if (p.data.candidate) {
        try {
          await pc.addIceCandidate(p.data.candidate)
        } catch (err) {
          if (!link.ignoreOffer) throw err
        }
      }
    } catch {
      /* a torn negotiation: the next offer repairs it */
    }
  }

  // ── Controls ──────────────────────────────────────────────────────────────
  setMuted(muted: boolean) {
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = !muted
    this.set({ muted })
    if (this.state.room && this.state.status === 'live') {
      this.transport?.emit('huddle:state', { room: this.state.room, muted })
    }
  }

  async startShare(): Promise<void> {
    if (this.state.status !== 'live' || this.state.sharing) return
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 15, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      })
    } catch {
      return
    }
    const track = stream.getVideoTracks()[0]
    if (!track) return
    track.onended = () => this.stopShare()
    for (const [, link] of this.links) link.screenSender = link.pc.addTrack(track, stream)
    this.set({ sharing: true, localScreen: stream })
    this.transport?.emit('huddle:state', { room: this.state.room, screen: true })
  }

  stopShare(): void {
    if (!this.state.sharing) return
    for (const t of this.state.localScreen?.getTracks() ?? []) t.stop()
    for (const [, link] of this.links) {
      if (link.screenSender) {
        try {
          link.pc.removeTrack(link.screenSender)
        } catch {
          /* already closed */
        }
        link.screenSender = null
      }
    }
    this.set({ sharing: false, localScreen: null })
    if (this.state.room && this.state.status === 'live') {
      this.transport?.emit('huddle:state', { room: this.state.room, screen: false })
    }
  }
}

interface SignalIn {
  room: string
  from: string
  user: { id: string; name: string | null }
  data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }
}

export const huddleStore = new HuddleStore()

/** Browser support, read once per render (SSR-safe). */
export function huddleSupport(): { audio: boolean; screen: boolean } {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return { audio: false, screen: false }
  }
  const md = navigator.mediaDevices
  return {
    audio: !!md?.getUserMedia && typeof RTCPeerConnection !== 'undefined',
    screen: !!md?.getDisplayMedia
  }
}
