import { sourceToEdited } from './edits'
import type { VideoEdits } from './types'

// The soft "tick" a click ripple makes. Two short decaying tones, quiet next
// to a narrated recording. The render mixes the same sound into the finished
// file (api/src/services/help-video-render-plan.ts, RIPPLE_TICK — keep the two
// in step), so the live player plays it only when it draws the edits itself.

/** [frequency Hz, peak amplitude, decay rate /s]: sum of a·e^(−k·t)·sin(2πf·t). */
export const RIPPLE_TICK_TONES: ReadonlyArray<readonly [number, number, number]> = [
  [1800, 0.12, 140],
  [600, 0.06, 60]
]
/** How long the tick lasts, in seconds. */
export const RIPPLE_TICK_SECONDS = 0.06
/** Ripples closer together than this make one tick. */
export const RIPPLE_TICK_MERGE_MS = 80

/** The SOURCE moments a ripple starts that viewers see (cut-out ones
 *  dropped), merged and sorted. */
export function rippleTickTimes(e: VideoEdits): number[] {
  const at = e.annotations
    .filter((a) => a.type === 'ripple' && sourceToEdited(e, a.start_ms) !== null)
    .map((a) => a.start_ms)
    .sort((a, b) => a - b)
  const out: number[] = []
  for (const t of at)
    if (!out.length || t - out[out.length - 1] >= RIPPLE_TICK_MERGE_MS) out.push(t)
  return out
}

type AudioCtor = typeof AudioContext
let ctx: AudioContext | null = null

/** Plays one tick at `volume` (0–1, the video's own volume). Never throws:
 *  a browser without Web Audio, or one that refuses to start it, stays quiet. */
export function playRippleTick(volume: number): void {
  if (!(volume > 0) || typeof window === 'undefined') return
  try {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext
    if (!AC) return
    ctx ??= new AC()
    if (ctx.state === 'suspended') void ctx.resume().catch(() => null)
    const t = ctx.currentTime
    for (const [freq, amp, decay] of RIPPLE_TICK_TONES) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(amp * Math.min(1, volume), t)
      gain.gain.setTargetAtTime(0, t, 1 / decay)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t)
      osc.stop(t + RIPPLE_TICK_SECONDS + 0.02)
    }
  } catch {
    /* no sound is fine */
  }
}

/** Ticks the ripples the playhead PLAYED past between two source moments:
 *  only forward steps short enough to be playback, never a seek or a jump
 *  over a cut. Returns how many ticked (one at most per call). */
export function ticksBetween(
  times: number[],
  prevMs: number,
  nowMs: number,
  maxStepMs: number
): number {
  if (!(nowMs > prevMs) || nowMs - prevMs > maxStepMs) return 0
  return times.some((t) => t > prevMs && t <= nowMs) ? 1 : 0
}
