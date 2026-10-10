/**
 * One place every shared surface asks "what did they just see?" (#1370, #1377).
 *
 * The session recorder lives in the HOST — admin/src/lib/use-session-recorder.ts
 * or @nivaro/react's useSessionRecorder — but the surfaces that want its clip
 * (an error boundary helper, the support dialog, Report a problem) are shared
 * components. The recorder registers its capture function here once at module
 * load; shared code calls `captureReplayClip()` and never imports a host.
 *
 * Resolves null when no recorder is registered, both replay modes are off,
 * or the capture takes longer than the timeout — a report must never wait on
 * or break because of replay.
 */

export interface ReplayLink {
  recording_id: string
  /** Milliseconds into the recording where the moment happened. Null for a
   *  clip — the whole clip IS the context (the moment is its end). */
  offset_ms: number | null
}

/** Why the clip is being cut: the server labels the recording by it
 *  (error → app 'error-clip', support → app 'support-clip'). */
export type ReplayClipKind = 'error' | 'support'

type Capture = (kind: ReplayClipKind) => Promise<ReplayLink | null>
/**
 * Two-phase capture: take the moment NOW (the clip's events, or the live
 * recording's offset), upload later. A support dialog snapshots when it
 * opens — by the time the person has typed their question the rolling
 * buffer would hold mostly the dialog itself.
 */
type Snapshot = (kind: ReplayClipKind) => (() => Promise<ReplayLink | null>) | null

let capture: Capture | null = null
let snapshot: Snapshot | null = null

/** Called by a host's recorder module. Returns an undo for tests / HMR. */
export function registerReplayCapture(fn: Capture, snap?: Snapshot): () => void {
  capture = fn
  snapshot = snap ?? null
  return () => {
    if (capture === fn) {
      capture = null
      snapshot = null
    }
  }
}

async function withTimeout(
  p: Promise<ReplayLink | null>,
  timeoutMs: number
): Promise<ReplayLink | null> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      })
    ])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function captureReplayClip(
  kind: ReplayClipKind = 'error',
  timeoutMs = 4000
): Promise<ReplayLink | null> {
  const fn = capture
  if (!fn) return null
  try {
    return await withTimeout(fn(kind), timeoutMs)
  } catch {
    return null
  }
}

export interface PreparedReplayClip {
  /** Upload what was taken at prepare time; null when nothing is recording. */
  commit(timeoutMs?: number): Promise<ReplayLink | null>
}

/**
 * Take the moment now, upload on commit — nothing leaves the browser until
 * then, so a dialog that is cancelled uploads nothing. Without a recorder
 * snapshot it falls back to capturing at commit time.
 */
export function prepareReplayClip(kind: ReplayClipKind): PreparedReplayClip {
  let taken: (() => Promise<ReplayLink | null>) | null = null
  try {
    taken = snapshot ? snapshot(kind) : null
  } catch {
    taken = null
  }
  return {
    commit(timeoutMs = 6000) {
      if (taken) return withTimeout(taken(), timeoutMs).catch(() => null)
      return captureReplayClip(kind, timeoutMs)
    }
  }
}

/** The admin's replay deep link: /session-replays?recording=<id>&t=<ms>. */
export function replayHref(
  link: ReplayLink | { recording_id: string; offset_ms?: number | null },
  base = ''
): string {
  const t = link.offset_ms != null ? `&t=${Math.max(0, Math.floor(link.offset_ms))}` : ''
  return `${base.replace(/\/$/, '')}/session-replays?recording=${encodeURIComponent(link.recording_id)}${t}`
}

/**
 * Where in a clip "the moment" is. An error clip has none (the whole clip is
 * the context); a support clip is the moment of asking — its last event,
 * measured from its first (the player's t=0).
 */
export function clipEndOffset(events: unknown[], kind: ReplayClipKind): number | null {
  if (kind !== 'support' || events.length === 0) return null
  const ts = (e: unknown) => (e as { timestamp?: unknown } | null)?.timestamp
  const first = ts(events[0])
  const last = ts(events[events.length - 1])
  if (typeof first !== 'number' || typeof last !== 'number') return null
  return Math.max(0, last - first)
}

/** Add the clip kind to a session-recording start command (POST /start body). */
export function withClipKind<T extends { _body?: unknown }>(cmd: T, kind: ReplayClipKind): T {
  return { ...cmd, _body: { ...((cmd._body as object | undefined) ?? {}), clip_kind: kind } }
}
