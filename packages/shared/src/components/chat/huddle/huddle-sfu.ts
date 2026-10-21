import type { Room } from 'livekit-client'

/**
 * Large huddles (#2859) — the browser side of the LiveKit SFU path. Above the
 * instance's switch-at size the server says `huddle:mode {mode:'sfu'}`; the
 * store then opens one of these: connect to the media server with a token the
 * API minted for this room, publish the microphone (and the screen while
 * sharing), and hand every remote track back by the SOCKET id it belongs to,
 * so the roster, tiles and hidden audio elements work exactly as in mesh mode.
 *
 * `livekit-client` is loaded with a dynamic import: a mesh-only instance never
 * downloads it. Presence stays the server's Redis roster — LiveKit is media.
 */

export interface SfuTokenConfig {
  url: string
  token: string
  room: string
  identity: string
  ttl_s: number
}

export interface SfuEvents {
  onTrack(socket: string, kind: 'audio' | 'video', stream: MediaStream): void
  onTrackEnd(socket: string, kind: 'audio' | 'video'): void
  /** The media server closed the link (or it failed for good). */
  onDisconnected(): void
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

export class SfuSession {
  private room: Room | null = null
  private lk: LiveKit | null = null
  private screen: MediaStreamTrack | null = null
  private closed = false

  async connect(cfg: SfuTokenConfig, events: SfuEvents): Promise<void> {
    const lk = await loadLiveKit()
    if (this.closed) return
    this.lk = lk
    const room = new lk.Room({ adaptiveStream: true, dynacast: true })
    this.room = room
    room
      .on(lk.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        const kind = track.kind === lk.Track.Kind.Video ? 'video' : 'audio'
        if (kind === 'audio' && track.kind !== lk.Track.Kind.Audio) return
        events.onTrack(
          socketFromIdentity(participant.identity),
          kind,
          new MediaStream([track.mediaStreamTrack])
        )
      })
      .on(lk.RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
        if (track.kind !== lk.Track.Kind.Video && track.kind !== lk.Track.Kind.Audio) return
        events.onTrackEnd(
          socketFromIdentity(participant.identity),
          track.kind === lk.Track.Kind.Video ? 'video' : 'audio'
        )
      })
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

  /** Mirror the mute state so the SFU stops forwarding silence frames. */
  async setMicMuted(muted: boolean): Promise<void> {
    if (!this.room || !this.lk) return
    const pub = this.room.localParticipant.getTrackPublication(this.lk.Track.Source.Microphone)
    if (!pub) return
    if (muted) await pub.mute()
    else await pub.unmute()
  }

  disconnect(): void {
    this.closed = true
    const room = this.room
    this.room = null
    this.screen = null
    if (room) void room.disconnect().catch(() => null)
  }
}
