import type { SfuSession } from './huddle-sfu'
import { type HuddleExtension, type HuddlePeer, huddleStore } from './huddle-store'

/**
 * Optional camera in a huddle (#2858). Off by default. Turning it on captures
 * 640x360 at 15 fps and adds the track to every peer connection — the store's
 * perfect-negotiation path renegotiates on its own. The roster carries the
 * camera's stream id (`cam`) so the others can tell it from a screen share.
 *
 * In a mesh, every camera is uploaded once per peer, so only the first
 * MAX_LIVE_CAMERAS cameras (in the order they went on, `cam_at`) stay live.
 * Everyone works the same answer out from the same roster: a camera past the
 * limit pauses its own sending (replaceTrack(null), no renegotiation) and says
 * "Video paused to keep the call smooth"; it resumes by itself when a place
 * frees up.
 *
 * In a large huddle (#2859, LiveKit SFU) the camera is published once as its
 * own Camera-source track; the others receive it labelled, so it fills the
 * camera tile and never the screen slot. The same four-camera rule pauses it
 * there by muting the publication.
 */

export const MAX_LIVE_CAMERAS = 4

type CamPeer = Pick<HuddlePeer, 'socket' | 'cam' | 'cam_at'>

/** Sockets whose camera is on but past the limit — the same answer on every client. */
export function pausedCameras(roster: CamPeer[], limit = MAX_LIVE_CAMERAS): Set<string> {
  const on = roster
    .filter((p) => !!p.cam)
    .sort((a, b) => (a.cam_at ?? 0) - (b.cam_at ?? 0) || (a.socket < b.socket ? -1 : 1))
  return new Set(on.slice(limit).map((p) => p.socket))
}

/** 1, 2 or 4 columns' worth of tiles; a narrow stage gets a scrolling strip. */
export function videoLayout(count: number, width: number): 'strip' | 'one' | 'two' {
  if (width > 0 && width < 360 && count > 1) return 'strip'
  return count <= 1 ? 'one' : 'two'
}

export interface CameraState {
  stream: MediaStream | null
  starting: boolean
  /** Past the live-camera limit: my camera is on but nobody receives it. */
  paused: boolean
  error: string | null
}

const OFF: CameraState = { stream: null, starting: false, paused: false, error: null }

type Listener = () => void

class CameraStore {
  private state: CameraState = OFF
  private listeners = new Set<Listener>()
  private senders = new Map<string, RTCRtpSender>()
  /** The SFU link my camera is published on (#2859), while the huddle is large. */
  private sfu: SfuSession | null = null
  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }
  getSnapshot = () => this.state
  private set(patch: Partial<CameraState>) {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  private track(): MediaStreamTrack | null {
    return this.state.stream?.getVideoTracks()[0] ?? null
  }

  async start(): Promise<void> {
    const s = huddleStore.getSnapshot()
    if (s.status !== 'live' || this.state.stream || this.state.starting) return
    this.set({ starting: true, error: null })
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 360 },
          frameRate: { ideal: 15, max: 15 }
        },
        audio: false
      })
    } catch (err) {
      const name = (err as { name?: string })?.name
      this.set({
        starting: false,
        error:
          name === 'NotAllowedError'
            ? 'Camera access was refused. Allow it in the browser and try again.'
            : name === 'NotFoundError'
              ? 'No camera was found.'
              : 'The camera could not be started.'
      })
      return
    }
    // Left the huddle while the browser asked: nothing to send it to.
    if (huddleStore.getSnapshot().status !== 'live') {
      for (const t of stream.getTracks()) t.stop()
      this.set({ starting: false })
      return
    }
    const track = stream.getVideoTracks()[0]
    if (track) track.onended = () => this.stop()
    this.set({ stream, starting: false })
    // The roster learns the stream id first, so the others file the track as a camera.
    huddleStore.send('huddle:state', { camera: stream.id })
    huddleStore.forEachLink((socket, pc) => this.addTo(socket, pc))
    const sfu = huddleStore.sfuSession()
    if (sfu) this.publishOn(sfu)
  }

  private publishOn(session: SfuSession) {
    this.sfu = session
    const track = this.track()
    if (track) void session.publishCamera(track, this.state.paused).catch(() => null)
  }

  stop(): void {
    const stream = this.state.stream
    if (!stream) return
    for (const t of stream.getTracks()) t.stop()
    huddleStore.forEachLink((socket, pc) => {
      const sender = this.senders.get(socket)
      if (!sender) return
      try {
        pc.removeTrack(sender)
      } catch {
        /* already closed */
      }
    })
    this.senders.clear()
    void this.sfu?.unpublishCamera().catch(() => null)
    this.set({ ...OFF })
    huddleStore.send('huddle:state', { camera: null })
  }

  toggle() {
    if (this.state.stream) this.stop()
    else void this.start()
  }

  clearError() {
    if (this.state.error) this.set({ error: null })
  }

  private addTo(socket: string, pc: RTCPeerConnection) {
    const track = this.track()
    const stream = this.state.stream
    if (!track || !stream || this.senders.has(socket) || pc.signalingState === 'closed') return
    const sender = pc.addTrack(track, stream)
    this.senders.set(socket, sender)
    if (this.state.paused) void sender.replaceTrack(null).catch(() => null)
  }

  /** Re-read the roster: pause or resume my sending when my place in line changed. */
  evaluate() {
    const s = huddleStore.getSnapshot()
    if (!this.state.stream || !s.room || !s.self) {
      if (this.state.paused) this.set({ paused: false })
      return
    }
    const roster = huddleStore.roster(s.room) ?? []
    const paused = pausedCameras(roster).has(s.self)
    if (paused === this.state.paused) return
    const track = paused ? null : this.track()
    for (const sender of this.senders.values()) void sender.replaceTrack(track).catch(() => null)
    void this.sfu?.setCameraPaused(paused).catch(() => null)
    this.set({ paused })
  }

  readonly ext: HuddleExtension = {
    attach: () => [huddleStore.subscribeRosters(() => this.evaluate())],
    link: (socket, pc) => this.addTo(socket, pc),
    unlink: (socket) => {
      this.senders.delete(socket)
    },
    joined: () => {
      // A rejoin is a new server socket: the old senders went with the old links.
      if (this.state.stream) huddleStore.send('huddle:state', { camera: this.state.stream.id })
    },
    sfu: (session) => this.publishOn(session),
    teardown: () => {
      for (const t of this.state.stream?.getTracks() ?? []) t.stop()
      this.senders.clear()
      this.sfu = null
      this.set({ ...OFF })
    }
  }
}

export const cameraStore = new CameraStore()

export function installHuddleCamera() {
  huddleStore.use(cameraStore.ext)
}

export function cameraSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
}
