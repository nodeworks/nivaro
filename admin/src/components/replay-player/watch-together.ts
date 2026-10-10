/**
 * Watch together (#1399) — the pure half and the per-tab session.
 *
 * The admin who shares a replay leads: their playhead, pauses, seeks and
 * speed go out over the socket (room replay:<key>, api/src/services/
 * replay-watch.ts) and every admin who opened the watch link follows. The
 * leader sends on every change and a heartbeat while playing; a follower
 * moves only when it has drifted, so a little network jitter never stutters.
 */
import { useSyncExternalStore } from 'react'

export type WatchRole = 'leader' | 'follower'

export interface Viewer {
  id: string
  name: string
  leader: boolean
}

export interface RemoteState {
  playing: boolean
  time: number
  speed: number
  by?: string
}

export interface WatchState {
  status: 'joining' | 'joined' | 'denied'
  /** What the server made of us — a would-be leader in a room that has one follows. */
  role: WatchRole | null
  viewers: Viewer[]
  remote: RemoteState | null
  denied: string | null
}

export type WatchAction =
  | { type: 'reset' }
  | { type: 'joined'; leader: boolean }
  | { type: 'roster'; viewers: Viewer[] }
  | { type: 'remote'; state: RemoteState }
  | { type: 'denied'; reason: string }

export const INITIAL_WATCH: WatchState = {
  status: 'joining',
  role: null,
  viewers: [],
  remote: null,
  denied: null
}

export function watchReducer(state: WatchState, action: WatchAction): WatchState {
  switch (action.type) {
    case 'reset':
      return INITIAL_WATCH
    case 'joined':
      return {
        ...state,
        status: 'joined',
        role: action.leader ? 'leader' : 'follower',
        denied: null
      }
    case 'roster':
      return { ...state, viewers: action.viewers }
    case 'remote':
      return state.role === 'leader' ? state : { ...state, remote: action.state }
    case 'denied':
      return { ...state, status: 'denied', denied: action.reason }
  }
}

/** The room has people in it but nobody leads (the sharer closed the replay). */
export function hostLeft(state: WatchState): boolean {
  return (
    state.status === 'joined' && state.viewers.length > 0 && !state.viewers.some((v) => v.leader)
  )
}

export function hostName(state: WatchState): string | null {
  return state.viewers.find((v) => v.leader)?.name ?? state.remote?.by ?? null
}

/** A follower further than this from the leader seeks; closer it just plays on. */
export const FOLLOW_DRIFT_MS = 2_000

export interface FollowStep {
  /** Seek (and set play / pause) to here; null = stay. */
  seekTo: number | null
  /** Play (true) / pause (false) — null = already right. */
  play: boolean | null
  /** Change speed to this — null = already right. */
  speed: number | null
}

/** What a follower does with the leader's latest state. */
export function followAction(
  local: { time: number; playing: boolean; speed: number },
  remote: RemoteState,
  drift = FOLLOW_DRIFT_MS
): FollowStep {
  const off = Math.abs(local.time - remote.time)
  const seekTo = off > drift || (!remote.playing && off > 250) ? remote.time : null
  return {
    seekTo,
    play: local.playing === remote.playing ? null : remote.playing,
    speed: local.speed === remote.speed ? null : remote.speed
  }
}

/** Heartbeat while playing even when nothing changed, so late joiners and drift catch up. */
export const LEAD_HEARTBEAT_MS = 3_000

/**
 * Should the leader send its state now? On play / pause, a speed change, a
 * jump (seek, a chapter, a skipped gap) or the heartbeat.
 */
export function leaderShouldSend(
  last: { time: number; playing: boolean; speed: number; at: number } | null,
  now: { time: number; playing: boolean; speed: number; at: number }
): boolean {
  if (!last) return true
  if (last.playing !== now.playing || last.speed !== now.speed) return true
  const expected = last.playing ? last.time + (now.at - last.at) * last.speed : last.time
  if (Math.abs(now.time - expected) > 1_000) return true
  return now.playing && now.at - last.at >= LEAD_HEARTBEAT_MS
}

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

/** 16 unguessable characters for the room key. */
export function makeWatchKey(rand: (n: number) => Uint8Array = defaultRandom): string {
  return Array.from(rand(16), (b) => KEY_ALPHABET[b % KEY_ALPHABET.length]).join('')
}

function defaultRandom(n: number): Uint8Array {
  const a = new Uint8Array(n)
  crypto.getRandomValues(a)
  return a
}

export const WATCH_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/

/**
 * The link to this moment of this recording; with a key, opening it joins the
 * watch party. `t` is the moment — the player opens a few seconds before it.
 */
export function replayLink(
  origin: string,
  recordingId: string,
  time: number,
  key?: string | null
): string {
  const q = new URLSearchParams({
    recording: recordingId,
    t: String(Math.max(0, Math.round(time)))
  })
  if (key) q.set('watch', key)
  return `${origin}/session-replays?${q.toString()}`
}

export function deniedText(reason: string | null): string {
  switch (reason) {
    case 'admins-only':
      return 'Only admins can watch replays together.'
    case 'no-recording':
      return 'This recording no longer exists.'
    case 'other-recording':
      return 'That watch link is for a different recording.'
    case 'bad-key':
      return 'That watch link is not valid.'
    case 'not-signed-in':
      return 'Reconnecting…'
    default:
      return 'Watching together is unavailable right now.'
  }
}

// ── The tab's watch session — survives the hand-off to the floating player ──

export interface WatchSession {
  recordingId: string
  key: string
  role: WatchRole
}

let session: WatchSession | null = null
const listeners = new Set<() => void>()

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function getWatchSession(): WatchSession | null {
  return session
}

export function setWatchSession(next: WatchSession | null): void {
  session = next
  for (const l of listeners) l()
}

/** The session for this recording, or null. */
export function useWatchSession(recordingId: string): WatchSession | null {
  const s = useSyncExternalStore(subscribe, getWatchSession, getWatchSession)
  return s && s.recordingId === recordingId ? s : null
}
