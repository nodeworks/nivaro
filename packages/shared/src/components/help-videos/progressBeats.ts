import { bucketIndex } from './playerMath'

// What the player reports about watching, kept free of React so it can be
// tested in node. The server bounds progress by the time since the FIRST
// beat it saw, so a beat goes out the moment watching starts: without it a
// short video played straight through (first beat only at the end) could
// never collect 18 of its 20 sections.

export type ProgressBody = {
  position_ms: number
  watched_ms_delta: number
  buckets: string
  version_id?: string
}
export type PostBeat = (body: ProgressBody, keepalive: boolean) => Promise<unknown>

const EMPTY = '0'.repeat(20)

export function createProgressBeats(post: PostBeat) {
  const seen: boolean[] = new Array(20).fill(false)
  let watched = 0
  let lastTick: number | null = null
  let opened = false

  /** Sends one beat; a failed send keeps its watched time for the next one. */
  const sendBody = (body: ProgressBody, keepalive: boolean) => {
    const delta = body.watched_ms_delta
    return post(body, keepalive).catch(() => {
      watched += delta
      return null
    })
  }

  return {
    /** True once watching has started (the opening beat went out). */
    get opened() {
      return opened
    },
    /** Watching just started: open the server's watch period now, with
     *  nothing seen yet. Only the first call sends. */
    open(position_ms: number, version_id?: string) {
      if (opened) return null
      opened = true
      return sendBody(
        { position_ms: Math.round(position_ms), watched_ms_delta: 0, buckets: EMPTY, version_id },
        false
      )
    },
    /** One frame of playback at `editedMs` of `totalMs`, at time `now` (ms). */
    see(editedMs: number, totalMs: number, now: number) {
      if (!totalMs) return
      if (lastTick !== null) watched += Math.min(1000, Math.max(0, now - lastTick))
      lastTick = now
      seen[bucketIndex(editedMs, totalMs)] = true
    },
    /** Playback stopped: the next frame starts a new watched stretch. */
    idle() {
      lastTick = null
    },
    /** The sections seen so far and the watched time since the last beat.
     *  Nothing is sent before watching has started. */
    beat(position_ms: number, version_id?: string, keepalive = false) {
      if (!opened) return null
      const body: ProgressBody = {
        position_ms: Math.round(position_ms),
        watched_ms_delta: Math.round(watched),
        buckets: seen.map((b) => (b ? '1' : '0')).join(''),
        version_id
      }
      watched = 0
      return sendBody(body, keepalive)
    }
  }
}
export type ProgressBeats = ReturnType<typeof createProgressBeats>
