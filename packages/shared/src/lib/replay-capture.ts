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

let capture: Capture | null = null

/** Called by a host's recorder module. Returns an undo for tests / HMR. */
export function registerReplayCapture(fn: Capture): () => void {
  capture = fn
  return () => {
    if (capture === fn) capture = null
  }
}

export async function captureReplayClip(
  kind: ReplayClipKind = 'error',
  timeoutMs = 4000
): Promise<ReplayLink | null> {
  const fn = capture
  if (!fn) return null
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      fn(kind),
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

/** The admin's replay deep link: /session-replays?recording=<id>&t=<ms>. */
export function replayHref(
  link: ReplayLink | { recording_id: string; offset_ms?: number | null },
  base = ''
): string {
  const t = link.offset_ms != null ? `&t=${Math.max(0, Math.floor(link.offset_ms))}` : ''
  return `${base.replace(/\/$/, '')}/session-replays?recording=${encodeURIComponent(link.recording_id)}${t}`
}
