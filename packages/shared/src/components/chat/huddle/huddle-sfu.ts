import type { Room } from 'livekit-client'
import type { Report } from './huddle-audio-logic'

/**
 * Large huddles (#2859) — the browser side of the LiveKit SFU path. Above the
 * instance's switch-at size the server says `huddle:mode {mode:'sfu'}`; the
 * store then opens one of these: connect to the media server with a token the
 * API minted for this room, publish the microphone, the camera (#2858) and the
 * screen while they are on, and hand every remote track back by the SOCKET id
 * it belongs to and the SOURCE it was published as, so the roster, tiles and
 * hidden audio elements work exactly as in mesh mode.
 *
 * `livekit-client` is loaded with a dynamic import: a mesh-only instance never
 * downloads it. Presence stays the server's Redis roster — LiveKit is media.
 * The token never allows data publishing; point-and-draw rides the socket in
 * this mode (huddle:mark, huddle-draw.ts).
 */

export interface SfuTokenConfig {
  url: string
  token: string
  room: string
  identity: string
  ttl_s: number
}

/** Which slot a remote track fills: the voice, the camera tile or the shared screen. */
export type SfuSource = 'mic' | 'camera' | 'screen'

export interface SfuEvents {
  onTrack(socket: string, source: SfuSource, stream: MediaStream): void
  onTrackEnd(socket: string, source: SfuSource): void
  /** The media server closed the link (or it failed for good). */
  onDisconnected(): void
  /** The link to the media server dropped and is being restored (#2849 counts these). */
  onReconnecting?(): void
}

/**
 * Route a subscribed track by what it was published as (#2858): a camera goes to
 * the person's camera tile, a screen share to the screen slot, audio to their voice.
 * Screen-share audio is never published here, so it is ignored rather than allowed
 * to replace the voice. An unlabelled video counts as a screen (the pre-#2858 rule).
 */
export function routeSfuTrack(kind: string, source: string): SfuSource | null {
  if (kind === 'audio') return source === 'screen_share_audio' ? null : 'mic'
  if (kind !== 'video') return null
  if (source === 'camera') return 'camera'
  if (source === 'screen_share' || source === 'unknown' || !source) return 'screen'
  return null
}

/** LiveKit's per-participant grade, as the quality sampler reads it (#2848). */
export type SfuGrade = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown'

/** What the one quality sampler reads from the SFU link each poll (#2848/#2849). */
export interface SfuStats {
  /** One entry per remote person: the stats of the tracks I receive from them. */
  peers: Array<{ socket: string; reports: Report[]; grade: SfuGrade }>
  /** My own uplink: the stats of what I publish, and LiveKit's grade of my connection. */
  local: { reports: Report[]; grade: SfuGrade }
  /** The sender of my published screen (null when not sharing), for the poor-link downshift. */
  screenSender: RTCRtpSender | null
}

/** Identity is `<user id>#<socket id>` (minted by the server); the socket is what the roster keys on. */
export function socketFromIdentity(identity: string): string {
  const i = identity.lastIndexOf('#')
  return i >= 0 ? identity.slice(i + 1) : identity
}

/** How long mesh links stay open after the SFU connected, so nobody hears a gap. */
export const MESH_OVERLAP_MS = 3000

type LiveKit = typeof import('livekit-client')

let lib: Promise<LiveKit> | null = null
/** One import per page; the chunk is only fetched the first time a huddle goes large. */
export function loadLiveKit(): Promise<LiveKit> {
  if (!lib) lib = import('livekit-client')
  return lib
}

async function reportsOf(
  track: { getRTCStatsReport(): Promise<RTCStatsReport | undefined> } | undefined
): Promise<Report[]> {
  if (!track) return []
  try {
    const r = await track.getRTCStatsReport()
    return r ? [...r.values()] : []
  } catch {
    return []
  }
}

export class SfuSession {
  private room: Room | null = null
  private lk: LiveKit | null = null
  private screen: MediaStreamTrack | null = null
  /** The camera as published: a clone, so pausing it never blanks my own preview. */
  private camera: MediaStreamTrack | null = null
  private closed = false

  async connect(cfg: SfuTokenConfig, events: SfuEvents): Promise<void> {
    const lk = await loadLiveKit()
    if (this.closed) return
    this.lk = lk
    const room = new lk.Room({ adaptiveStream: true, dynacast: true })
    this.room = room
    const isMine = (p: { identity: string }) => p.identity === room.localParticipant.identity
    const deliver = (
      track: { kind: string; source: string; mediaStreamTrack: MediaStreamTrack },
      participant: { identity: string }
    ) => {
      const source = routeSfuTrack(track.kind, track.source)
      if (!source || isMine(participant)) return
      events.onTrack(
        socketFromIdentity(participant.identity),
        source,
        new MediaStream([track.mediaStreamTrack])
      )
    }
    room
      .on(lk.RoomEvent.TrackSubscribed, (track, _pub, participant) => deliver(track, participant))
      .on(lk.RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
        const source = routeSfuTrack(track.kind, track.source)
        if (source) events.onTrackEnd(socketFromIdentity(participant.identity), source)
      })
      // A paused camera (#2858, past the live-camera limit) is a muted publication: its tile
      // goes, and comes back on unmute. A muted microphone keeps its element (silence).
      .on(lk.RoomEvent.TrackMuted, (pub, participant) => {
        if (pub.kind !== lk.Track.Kind.Video || isMine(participant)) return
        const source = routeSfuTrack(pub.kind, pub.source)
        if (source) events.onTrackEnd(socketFromIdentity(participant.identity), source)
      })
      .on(lk.RoomEvent.TrackUnmuted, (pub, participant) => {
        if (pub.kind !== lk.Track.Kind.Video || !pub.track) return
        deliver(pub.track, participant)
      })
      .on(lk.RoomEvent.Reconnecting, () => events.onReconnecting?.())
      .on(lk.RoomEvent.Disconnected, () => {
        if (!this.closed) events.onDisconnected()
      })
    await room.connect(cfg.url, cfg.token, { autoSubscribe: true })
    if (this.closed) {
      await room.disconnect()
      this.room = null
    }
  }

  get connected(): boolean {
    return !!this.room && !!this.lk && this.room.state === this.lk.ConnectionState.Connected
  }

  /** Publish the store's own microphone track (the one mute toggles). */
  async publishMic(track: MediaStreamTrack): Promise<void> {
    if (!this.room || !this.lk) return
    await this.room.localParticipant.publishTrack(track, {
      source: this.lk.Track.Source.Microphone,
      dtx: true,
      red: true
    })
  }

  /** Swap the published microphone for another device's track in place (#2847 device picker). */
  async replaceMic(track: MediaStreamTrack): Promise<void> {
    if (!this.room || !this.lk) return
    const pub = this.room.localParticipant.getTrackPublication(this.lk.Track.Source.Microphone)
    if (pub?.track) await pub.track.replaceTrack(track, { userProvidedTrack: true })
    else await this.publishMic(track)
  }

  async publishScreen(track: MediaStreamTrack): Promise<void> {
    if (!this.room || !this.lk) return
    await this.room.localParticipant.publishTrack(track, {
      source: this.lk.Track.Source.ScreenShare,
      simulcast: false
    })
    this.screen = track
  }

  async unpublishScreen(): Promise<void> {
    if (!this.room || !this.screen) return
    const t = this.screen
    this.screen = null
    // The store stops the MediaStreamTrack itself (it owns the stream).
    await this.room.localParticipant.unpublishTrack(t, false)
  }

  /**
   * Publish my camera as its own Camera-source track (#2858), simulcast so the SFU can
   * send a small layer to small tiles. `paused` = past the live-camera limit: published
   * muted, so nobody receives frames until a place frees up.
   */
  async publishCamera(track: MediaStreamTrack, paused: boolean): Promise<void> {
    if (!this.room || !this.lk || this.camera) return
    const clone = track.clone()
    this.camera = clone
    try {
      const pub = await this.room.localParticipant.publishTrack(clone, {
        source: this.lk.Track.Source.Camera,
        simulcast: true
      })
      if (this.camera !== clone) {
        await this.room?.localParticipant.unpublishTrack(clone, true)
        return
      }
      if (paused) await pub.mute()
    } catch (err) {
      if (this.camera === clone) this.camera = null
      clone.stop()
      throw err
    }
  }

  async unpublishCamera(): Promise<void> {
    const t = this.camera
    this.camera = null
    if (!t) return
    try {
      if (this.room) await this.room.localParticipant.unpublishTrack(t, true)
    } finally {
      t.stop()
    }
  }

  /** The live-camera limit moved me in or out of line (#2858): mute or unmute the camera. */
  async setCameraPaused(paused: boolean): Promise<void> {
    if (!this.room || !this.lk || !this.camera) return
    const pub = this.room.localParticipant.getTrackPublication(this.lk.Track.Source.Camera)
    if (!pub) return
    if (paused) await pub.mute()
    else await pub.unmute()
  }

  /** Mirror the mute state so the SFU stops forwarding silence frames. */
  async setMicMuted(muted: boolean): Promise<void> {
    if (!this.room || !this.lk) return
    const pub = this.room.localParticipant.getTrackPublication(this.lk.Track.Source.Microphone)
    if (!pub) return
    if (muted) await pub.mute()
    else await pub.unmute()
  }

  /**
   * One poll's worth of stats for the quality sampler (#2848/#2849): per remote person the
   * receiver stats of their voice (else any track of theirs), my microphone's sender stats,
   * and LiveKit's own connection grades. Null when not connected.
   */
  async stats(): Promise<SfuStats | null> {
    const room = this.room
    const lk = this.lk
    if (!room || !lk || room.state !== lk.ConnectionState.Connected) return null
    const peers: SfuStats['peers'] = []
    for (const p of room.remoteParticipants.values()) {
      const pubs = [...p.trackPublications.values()].filter((t) => t.track)
      const voice = pubs.find((t) => t.source === lk.Track.Source.Microphone) ?? pubs[0]
      peers.push({
        socket: socketFromIdentity(p.identity),
        reports: await reportsOf(voice?.track),
        grade: p.connectionQuality as SfuGrade
      })
    }
    const me = room.localParticipant
    const mic = me.getTrackPublication(lk.Track.Source.Microphone)?.track
    const screen = me.getTrackPublication(lk.Track.Source.ScreenShare)?.track
    return {
      peers,
      local: { reports: await reportsOf(mic), grade: me.connectionQuality as SfuGrade },
      screenSender: this.screen ? (screen?.sender ?? null) : null
    }
  }

  disconnect(): void {
    this.closed = true
    const room = this.room
    this.room = null
    this.screen = null
    for (const t of this.camera ? [this.camera] : []) t.stop()
    this.camera = null
    if (room) void room.disconnect().catch(() => null)
  }
}
