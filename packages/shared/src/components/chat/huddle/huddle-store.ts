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
 *
 * Large huddles (#2859): when the server says the huddle outgrew the mesh
 * (`huddle:mode {mode:'sfu'}`, or `mode` on huddle:joined) the store moves to
 * a LiveKit SFU through huddle-sfu.ts — same roster, same controls, same
 * hidden audio elements; the mesh links stay open for MESH_OVERLAP_MS so
 * nobody hears a gap, then close. A huddle never goes back to mesh mid-call.
 */
import { loadDevicePrefs, micConstraints } from './huddle-device-prefs'
import { huddleLive } from './huddle-live'
import { aggregateQuality, type LinkSummary } from './huddle-quality'
import {
  MESH_OVERLAP_MS,
  SfuSession,
  type SfuSource,
  type SfuStats,
  type SfuTokenConfig
} from './huddle-sfu'

export interface HuddlePeer {
  socket: string
  user: string
  name: string | null
  muted: boolean
  screen: boolean
  since: number
  /** #2857 — when their hand went up (null = down). */
  hand_at?: number | null
  /** #2858 — their camera's MediaStream id while it is on, and when it went on. */
  cam?: string | null
  cam_at?: number | null
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
export type HuddleMode = 'mesh' | 'sfu'

export interface LivePeer extends HuddlePeer {
  /** The peer's microphone, once the connection delivered it. */
  audio: MediaStream | null
  /** The peer's screen, while they share. */
  video: MediaStream | null
  connection: 'new' | 'connecting' | 'connected' | 'failed'
  /** #2858 — the peer's camera, while it is on and reaching us. */
  camera?: MediaStream | null
}

/**
 * Feature modules (stage tools, camera, drawing…) hook into the store here
 * instead of growing this file. Every hook is optional.
 */
export interface HuddleExtension {
  /** The host's transport was bound: subscribe, return the unsubscribers. */
  attach?(transport: HuddleTransport): Array<() => void>
  /** A peer connection was made (mic + screen tracks already added), before it negotiates. */
  link?(socket: string, pc: RTCPeerConnection): void
  /** A peer connection closed (they left, or the link was rebuilt). */
  unlink?(socket: string): void
  /** I am live in a huddle (first join or a rejoin): re-announce what the server forgot. */
  joined?(): void
  /** I left the huddle, or was removed. */
  teardown?(): void
  /** #2858: the huddle moved to the SFU and my microphone is published there. */
  sfu?(session: SfuSession): void
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
  /** How media travels (#2859): browser to browser, or through the instance's SFU. */
  mode: HuddleMode
  /** The microphone in use, by name (#2847). */
  micLabel: string | null
  /** #2857 — when my hand went up, from the server's roster (null = down). */
  handAt: number | null
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
  peers: [],
  mode: 'mesh',
  micLabel: null,
  handAt: null
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
    out.push(prev ? { ...prev, ...p } : { ...p, audio: null, video: null, connection: 'new' })
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
  /** #2849 — the latest stats per peer link (from the quality sampler) and the ICE failures seen. */
  private linkStats = new Map<string, LinkSummary>()
  private iceFailed = 0
  /** #2859: the SFU link while the huddle is large; mesh links close once it carries audio. */
  private sfu: SfuSession | null = null
  private fetchSfu: ((room: string, socket: string) => Promise<SfuTokenConfig>) | null = null
  private meshCloseTimer: ReturnType<typeof setTimeout> | null = null
  /** Peers whose audio already comes through the SFU (the mesh may close once all do). */
  private sfuAudio = new Set<string>()
  /** Every video stream each peer sends (screen and camera), live or muted, by stream id. */
  private remoteVideo = new Map<string, Map<string, { stream: MediaStream; live: boolean }>>()
  /** #2858: on the SFU each video arrives labelled — the camera and the screen, per peer. */
  private sfuVideo = new Map<string, { camera: MediaStream | null; screen: MediaStream | null }>()
  private exts = new Set<HuddleExtension>()
  private extOffs = new Map<HuddleExtension, Array<() => void>>()
  /** Called just before Leave goes out (#2854: a pending note edit is sent first). */
  private beforeLeave = new Set<(room: string) => void>()

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
  onBeforeLeave(cb: (room: string) => void) {
    this.beforeLeave.add(cb)
    return () => {
      this.beforeLeave.delete(cb)
    }
  }
  /** The host's socket adapter, for modules that ride the huddle (huddle-collab-store.ts). */
  transportNow(): HuddleTransport | null {
    return this.transport
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
  attach(
    transport: HuddleTransport,
    fetchIce: (room: string) => Promise<IceConfig>,
    fetchSfu?: (room: string, socket: string) => Promise<SfuTokenConfig>
  ) {
    this.fetchIce = fetchIce
    this.fetchSfu = fetchSfu ?? null
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
      // #2859: the huddle outgrew the mesh — everyone moves to the SFU.
      transport.on('huddle:mode', (p: { room: string; mode: HuddleMode }) => this.onMode(p)),
      // A reconnect is a new server socket: join again and rebuild every link.
      transport.on('auth:ok', () => {
        if (this.state.room && this.state.status === 'live') {
          this.transport?.emit('huddle:join', { room: this.state.room })
        }
      })
    ]
    for (const ext of this.exts) this.attachExt(ext)
  }

  // ── Extensions ────────────────────────────────────────────────────────────
  /** Plug a feature module in (idempotent per object); returns the unplug. */
  use(ext: HuddleExtension): () => void {
    if (!this.exts.has(ext)) {
      this.exts.add(ext)
      if (this.transport) this.attachExt(ext)
      if (this.state.status === 'live') {
        for (const [socket, link] of this.links) ext.link?.(socket, link.pc)
      }
    }
    return () => {
      for (const off of this.extOffs.get(ext) ?? []) off()
      this.extOffs.delete(ext)
      this.exts.delete(ext)
    }
  }

  private attachExt(ext: HuddleExtension) {
    for (const off of this.extOffs.get(ext) ?? []) off()
    this.extOffs.set(ext, this.transport && ext.attach ? ext.attach(this.transport) : [])
  }

  /** Emit a huddle event for the room I am live in; false when I am in none. */
  send(event: string, payload: Record<string, unknown> = {}): boolean {
    if (!this.state.room || this.state.status !== 'live' || !this.transport) return false
    this.transport.emit(event, { ...payload, room: this.state.room })
    return true
  }

  /** Every open peer connection, by the peer's socket id. */
  forEachLink(fn: (socket: string, pc: RTCPeerConnection) => void) {
    for (const [socket, link] of this.links) fn(socket, link.pc)
  }

  /**
   * Close a mesh link and forget it. Quietly: its "closed" state must not read as a failed
   * peer (#2859). `keepAudio` = the SFU already owns this peer's audio element.
   */
  private closeLink(socket: string, link: PeerLink, keepAudio = false) {
    link.pc.onconnectionstatechange = null
    link.pc.ontrack = null
    link.pc.onicecandidate = null
    link.pc.onnegotiationneeded = null
    link.pc.close()
    this.links.delete(socket)
    if (!keepAudio) this.dropAudio(socket)
    this.remoteVideo.delete(socket)
    for (const ext of this.exts) ext.unlink?.(socket)
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
        audio: micConstraints(loadDevicePrefs())
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
    this.set({ micLabel: this.mic.getAudioTracks()[0]?.label || null })
    await this.iceServers(room).catch(() => null)
    this.transport.emit('huddle:join', { room })
  }

  leave(): void {
    const room = this.state.room
    if (room) {
      // #2854: a pending note edit goes out first.
      for (const cb of this.beforeLeave) cb(room)
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
    if (this.meshCloseTimer) clearTimeout(this.meshCloseTimer)
    this.meshCloseTimer = null
    this.sfu?.disconnect()
    this.sfu = null
    this.sfuAudio.clear()
    this.sfuVideo.clear()
    for (const [socket, link] of this.links) this.closeLink(socket, link)
    for (const socket of [...this.audio.keys()]) this.dropAudio(socket)
    this.remoteVideo.clear()
    for (const t of this.mic?.getTracks() ?? []) t.stop()
    this.mic = null
    for (const t of this.state.localScreen?.getTracks() ?? []) t.stop()
    for (const ext of this.exts) ext.teardown?.()
    this.set({ ...IDLE, muted: this.state.muted })
  }

  private onJoined(p: { room: string; self: string; peers: HuddlePeer[]; mode?: HuddleMode }) {
    if (p.room !== this.state.room) return
    // A rejoin after a reconnect: every old link names a socket id that is gone.
    const rejoined = !!this.state.self && this.state.self !== p.self
    if (rejoined) {
      for (const [socket, link] of this.links) this.closeLink(socket, link)
    }
    const peers = mergeRoster([], p.peers, p.self)
    const since = Math.min(Date.now(), ...p.peers.map((x) => x.since).filter(Boolean))
    const mode: HuddleMode = p.mode === 'sfu' ? 'sfu' : 'mesh'
    this.set({ status: 'live', self: p.self, peers, startedAt: since, error: null, mode })
    // #2859: a huddle already on the SFU (or a new socket id after a reconnect) joins it directly.
    if (mode === 'sfu') void this.enterSfu(rejoined)
    else for (const peer of peers) void this.link(peer.socket)
    if (this.ping) clearInterval(this.ping)
    this.ping = setInterval(() => {
      if (this.state.room) this.transport?.emit('huddle:ping', { room: this.state.room })
    }, PING_MS)
    if (this.state.muted || this.state.sharing) {
      this.transport?.emit('huddle:state', {
        room: p.room,
        muted: this.state.muted,
        screen: this.state.sharing
      })
    }
    for (const ext of this.exts) ext.joined?.()
  }

  private onPeers(p: { room: string; peers: HuddlePeer[]; mode?: HuddleMode }) {
    this.setRoster(p.room, p.peers)
    if (p.room !== this.state.room || this.state.status !== 'live') return
    // #2859: the roster says the huddle is on the SFU (a missed huddle:mode) — move too.
    if (p.mode === 'sfu' && this.state.mode !== 'sfu') void this.enterSfu(false)
    const self = this.state.self
    const peers = mergeRoster(this.state.peers, p.peers, self)
    // Links to people who left close; people who arrived get one.
    for (const [socket, link] of this.links) {
      if (!peers.some((x) => x.socket === socket)) this.closeLink(socket, link)
    }
    // Their audio element goes with them, whichever way the sound came (mesh or SFU).
    for (const socket of [...this.audio.keys()]) {
      if (!peers.some((x) => x.socket === socket)) this.dropAudio(socket)
    }
    for (const socket of [...this.sfuVideo.keys()]) {
      if (!peers.some((x) => x.socket === socket)) this.sfuVideo.delete(socket)
    }
    // A link whose tracks arrived before the roster named the peer: pick them up now.
    for (const peer of peers) {
      if (peer.audio || peer.video) continue
      // SFU audio that landed before the roster named the peer lives in its element already.
      const el = this.audio.get(peer.socket)
      if (this.sfuAudio.has(peer.socket) && el?.srcObject instanceof MediaStream) {
        peer.audio = el.srcObject
        peer.connection = 'connected'
        continue
      }
      const link = this.links.get(peer.socket)
      if (!link) continue
      for (const r of link.pc.getReceivers()) {
        if (r.track?.readyState !== 'live') continue
        const ms = new MediaStream([r.track])
        if (r.track.kind === 'video') {
          if (!this.remoteVideo.get(peer.socket)?.size) peer.video = ms
        } else peer.audio = ms
      }
    }
    // The roster says which of a peer's video streams is the camera (#2858).
    for (const peer of peers) {
      if (this.remoteVideo.get(peer.socket)?.size) {
        Object.assign(peer, this.videoOf(peer.socket, peer.cam ?? null))
      }
    }
    const mine = self ? p.peers.find((x) => x.socket === self) : undefined
    this.set({ peers, handAt: mine?.hand_at ?? null })
    if (this.state.mode === 'sfu') return
    for (const peer of peers) if (!this.links.has(peer.socket)) void this.link(peer.socket)
  }

  // ── Large huddles (#2859) ─────────────────────────────────────────────────
  private onMode(p: { room: string; mode: HuddleMode }) {
    if (p.room !== this.state.room || this.state.status !== 'live') return
    if (p.mode === 'sfu' && this.state.mode !== 'sfu') void this.enterSfu(false)
  }

  /**
   * Move this browser onto the SFU: fetch a token for the room, connect, publish
   * the mic (and the screen if sharing), then close the mesh links once the SFU
   * carries audio — at most MESH_OVERLAP_MS later. `fresh` = my socket id changed
   * (a reconnect), so any earlier session is for an identity that no longer exists.
   */
  private async enterSfu(fresh: boolean): Promise<void> {
    const room = this.state.room
    const self = this.state.self
    if (!room || !self) return
    if (this.sfu && !fresh) return
    this.set({ mode: 'sfu' })
    if (!this.fetchSfu) return
    this.sfu?.disconnect()
    this.sfu = null
    let session: SfuSession
    try {
      const cfg = await this.fetchSfu(room, self)
      if (this.state.room !== room || this.state.self !== self) return
      session = new SfuSession()
      this.sfu = session
      await session.connect(cfg, {
        onTrack: (socket, source, stream) => this.onSfuTrack(socket, source, stream),
        onTrackEnd: (socket, source) => this.onSfuTrackEnd(socket, source),
        onReconnecting: () => {
          if (this.sfu === session) this.iceFailed++
        },
        onDisconnected: () => {
          if (this.sfu !== session) return
          this.leave()
          this.set({
            status: 'error',
            error: 'The media server dropped the call. Join again to continue.',
            room
          })
        }
      })
      if (this.sfu !== session) return
      const mic = this.mic?.getAudioTracks()[0]
      if (mic) await session.publishMic(mic)
      if (this.state.muted) void session.setMicMuted(true)
      const screen = this.state.localScreen?.getVideoTracks()[0]
      if (screen && this.state.sharing) await session.publishScreen(screen)
      // #2858: the camera (and anything else riding the media) follows the call onto the SFU.
      for (const ext of this.exts) ext.sfu?.(session)
    } catch {
      if (this.state.room !== room) return
      this.leave()
      this.set({
        status: 'error',
        error: 'Could not reach the media server for this large huddle.',
        room
      })
      return
    }
    if (this.meshCloseTimer) clearTimeout(this.meshCloseTimer)
    this.meshCloseTimer = setTimeout(() => this.closeMeshLinks(), MESH_OVERLAP_MS)
  }

  /** The SFU's labelled video for a peer (#2858): camera tile and shared screen, apart. */
  private sfuVideoOf(socket: string) {
    let v = this.sfuVideo.get(socket)
    if (!v) {
      v = { camera: null, screen: null }
      this.sfuVideo.set(socket, v)
    }
    return v
  }

  private onSfuTrack(socket: string, source: SfuSource, stream: MediaStream) {
    if (source === 'camera') {
      this.sfuVideoOf(socket).camera = stream
      this.updatePeer(socket, { camera: stream })
      return
    }
    if (source === 'screen') {
      this.sfuVideoOf(socket).screen = stream
      this.updatePeer(socket, { video: stream })
      return
    }
    this.sfuAudio.add(socket)
    this.updatePeer(socket, { audio: stream, connection: 'connected' })
    this.playAudio(socket, stream)
    // Once everyone I can hear comes through the SFU, the mesh has nothing left to carry.
    const waiting = this.state.peers.some(
      (p) => this.links.has(p.socket) && !this.sfuAudio.has(p.socket)
    )
    if (!waiting && this.links.size) this.closeMeshLinks()
  }

  private onSfuTrackEnd(socket: string, source: SfuSource) {
    if (source === 'mic') return this.updatePeer(socket, { audio: null })
    const v = this.sfuVideo.get(socket)
    if (source === 'camera') {
      if (v) v.camera = null
      this.updatePeer(socket, { camera: null })
    } else {
      if (v) v.screen = null
      this.updatePeer(socket, { video: null })
    }
  }

  /**
   * Close the mesh after the switch: the SFU streams already own the audio elements, and
   * the tiles show what the SFU delivers (a mesh-only video would be a frozen frame).
   */
  private closeMeshLinks() {
    if (this.meshCloseTimer) clearTimeout(this.meshCloseTimer)
    this.meshCloseTimer = null
    for (const [socket, link] of this.links) this.closeLink(socket, link, true)
    this.set({
      peers: this.state.peers.map((p) => ({
        ...p,
        connection: this.sfuAudio.has(p.socket) ? 'connected' : 'connecting',
        video: this.sfuVideo.get(p.socket)?.screen ?? null,
        camera: this.sfuVideo.get(p.socket)?.camera ?? null
      }))
    })
  }

  /** The SFU link while the huddle is large and connected (#2858 camera, #2848 stats). */
  sfuSession(): SfuSession | null {
    return this.state.mode === 'sfu' && this.sfu?.connected ? this.sfu : null
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
    // On the SFU there are no mesh links to make (a late offer from a peer is ignored).
    if (this.state.mode === 'sfu') return null
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
    // Before the first negotiation, so a data channel or camera rides the same offer.
    for (const ext of this.exts) ext.link?.(socket, pc)
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
        this.trackVideo(socket, stream, e.track)
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

  /** A peer's video track: a screen share, or (#2858) the camera the roster names. */
  private trackVideo(socket: string, stream: MediaStream, track: MediaStreamTrack) {
    let byId = this.remoteVideo.get(socket)
    if (!byId) {
      byId = new Map()
      this.remoteVideo.set(socket, byId)
    }
    const entry = { stream, live: true }
    byId.set(stream.id, entry)
    const refresh = () => {
      const cam = this.state.peers.find((p) => p.socket === socket)?.cam ?? null
      this.updatePeer(socket, this.videoOf(socket, cam))
    }
    track.onended = () => {
      this.remoteVideo.get(socket)?.delete(stream.id)
      refresh()
    }
    track.onmute = () => {
      entry.live = false
      refresh()
    }
    track.onunmute = () => {
      entry.live = true
      refresh()
    }
    refresh()
  }

  private videoOf(
    socket: string,
    cam: string | null
  ): { video: MediaStream | null; camera: MediaStream | null } {
    let video: MediaStream | null = null
    let camera: MediaStream | null = null
    for (const [id, v] of this.remoteVideo.get(socket) ?? []) {
      if (!v.live) continue
      if (cam && id === cam) camera = v.stream
      else video = v.stream
    }
    return { video, camera }
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
      if (this.sinkId) void applySink(el, this.sinkId)
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
    void this.sfu?.setMicMuted(muted)
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
    if (this.state.mode === 'sfu') void this.sfu?.publishScreen(track)
    else for (const [, link] of this.links) link.screenSender = link.pc.addTrack(track, stream)
    this.set({ sharing: true, localScreen: stream })
    this.transport?.emit('huddle:state', { room: this.state.room, screen: true })
  }

  stopShare(): void {
    if (!this.state.sharing) return
    void this.sfu?.unpublishScreen()
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

  // ── Audio quality and control (#2845–#2848) ───────────────────────────────
  private sinkId = ''
  private quality: HuddleQualitySnapshot | null = null

  /** The microphone stream I send (null when not in a huddle). */
  localMic(): MediaStream | null {
    return this.mic
  }

  /** Each peer link, for stats and sender tuning — read-only use. */
  peerLinks(): Array<{ socket: string; pc: RTCPeerConnection; screenSender: RTCRtpSender | null }> {
    return [...this.links].map(([socket, l]) => ({
      socket,
      pc: l.pc,
      screenSender: l.screenSender
    }))
  }

  /**
   * What the one quality sampler reads (#2848/#2849), in either mode: the mesh's peer
   * connections, or (#2859) the SFU link's per-person and own-uplink stats. While the
   * mesh is closing after a switch the SFU is the one that counts.
   */
  async qualitySources(): Promise<
    | { mode: 'mesh'; links: ReturnType<HuddleStore['peerLinks']> }
    | { mode: 'sfu'; sfu: SfuStats | null }
  > {
    if (this.state.mode === 'sfu') {
      return { mode: 'sfu', sfu: this.sfu ? await this.sfu.stats().catch(() => null) : null }
    }
    return { mode: 'mesh', links: this.peerLinks() }
  }

  /** The sampler's latest summary of one link, kept for the leave-time report (#2849). */
  recordLinkStats(socket: string, summary: LinkSummary) {
    if (this.state.status === 'live') this.linkStats.set(socket, summary)
  }

  /** Swap the microphone on every link in place (replaceTrack: no renegotiation). */
  async swapMic(stream: MediaStream): Promise<void> {
    const track = stream.getAudioTracks()[0]
    if (!track || !this.state.room || this.state.status === 'idle') {
      for (const t of stream.getTracks()) t.stop()
      return
    }
    track.enabled = !this.state.muted
    const old = this.mic
    this.mic = stream
    for (const [, link] of this.links) {
      for (const sender of link.pc.getSenders()) {
        if (sender === link.screenSender || sender.track?.kind !== 'audio') continue
        await sender.replaceTrack(track).catch(() => null)
      }
    }
    // A large huddle (#2859) sends the mic through the SFU, not the mesh links.
    if (this.sfu) await this.sfu.replaceMic(track).catch(() => null)
    for (const t of old?.getTracks() ?? []) t.stop()
    this.set({ micLabel: track.label || null })
  }

  /** Play everyone through this output ('' = the system default), where the browser can. */
  setSpeaker(sinkId: string) {
    this.sinkId = sinkId
    for (const [, el] of this.audio) void applySink(el, sinkId)
  }

  speaker(): string {
    return this.sinkId
  }

  /** Written by the quality monitor every poll; read by anyone through getHuddleQuality(). */
  reportQuality(q: HuddleQualitySnapshot | null) {
    this.quality = q
  }

  getHuddleQuality(): HuddleQualitySnapshot | null {
    return this.state.status === 'live' ? this.quality : null
  }
}

/** A point-in-time view of the call's links (#2848), for anything that reports on it. */
export interface HuddleQualitySnapshot {
  at: number
  room: string
  /** My own side looks poor (every connected link poor for 10 s). */
  poor: boolean
  peers: Array<{
    socket: string
    user: string
    rtt: number | null
    loss: number | null
    jitter: number | null
    path: 'direct' | 'relay' | null
    inKbps: number | null
    outKbps: number | null
    bars: 0 | 1 | 2 | 3 | 4
  }>
}

async function applySink(el: HTMLAudioElement, sinkId: string) {
  const media = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
  if (typeof media.setSinkId !== 'function') return
  await media.setSinkId(sinkId).catch(() => null)
}

interface SignalIn {
  room: string
  from: string
  user: { id: string; name: string | null }
  data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }
}

export const huddleStore = new HuddleStore()

/** The latest connection-quality snapshot of the huddle I am in (null = none / not measured). */
export function getHuddleQuality(): HuddleQualitySnapshot | null {
  return huddleStore.getHuddleQuality()
}

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
