/**
 * Picture-in-picture replay (#1401) — which recording is floating, and the
 * hand-back to the Session replays page. Module state (one per tab) so the
 * floating window, mounted once at app level, outlives every route change.
 *
 * rrweb replays into an iframe, and a moved iframe reloads, so floating hands
 * the playhead from the page's player to the app-level one (and back) rather
 * than moving one player: there is only ever one playing.
 */
import { useEffect, useSyncExternalStore } from 'react'

/** The list row the replay came from — the page re-opens its sheet with it. */
export interface FloatedRecording {
  id: string
}

export interface FloatingReplay {
  recording: FloatedRecording
  title: string
  /** Playhead (ms into the recording) at the hand-off. */
  at: number
  live: boolean
}

export interface DockRequest {
  recording: FloatedRecording
  at: number
}

/**
 * ReplayPlayer opens `startAt` minus 5 s (the issue log's "watch the moment"
 * lead); a hand-off adds it back so playback continues where it was.
 */
export const RESUME_LEAD_MS = 5_000
export function resumeStartAt(at: number): number {
  return Math.max(0, at) + RESUME_LEAD_MS
}

let floating: FloatingReplay | null = null
let dock: DockRequest | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function getFloatingReplay(): FloatingReplay | null {
  return floating
}

export function getDockRequest(): DockRequest | null {
  return dock
}

/** Detach a replay into the floating window. */
export function floatReplay(next: FloatingReplay): void {
  floating = next
  dock = null
  emit()
}

/** Close the floating window without returning it anywhere. */
export function closeFloatingReplay(): void {
  if (!floating) return
  floating = null
  emit()
}

/** Close the floating window and ask the Session replays page to open it at `at`. */
export function dockFloatingReplay(at: number): DockRequest | null {
  if (!floating) return null
  dock = { recording: floating.recording, at }
  floating = null
  emit()
  return dock
}

export function useFloatingReplay(): FloatingReplay | null {
  return useSyncExternalStore(subscribe, getFloatingReplay, getFloatingReplay)
}

/** The page side of the hand-back: `open` runs once per dock request. */
export function useDockedReplay(open: (recording: FloatedRecording, at: number) => void): void {
  const req = useSyncExternalStore(subscribe, getDockRequest, getDockRequest)
  // biome-ignore lint/correctness/useExhaustiveDependencies: one call per request
  useEffect(() => {
    if (!req) return
    dock = null
    emit()
    open(req.recording, req.at)
  }, [req])
}

/** Tests only. */
export function resetFloatingReplay(): void {
  floating = null
  dock = null
  emit()
}
