/**
 * Notification sounds (#684) — synthesized via WebAudio so no audio asset
 * ships (and no CSP/font-style fetch can fail silently). Preference lives at
 * `preferences.notification_sound` ('off' | 'subtle' | 'chime', default off).
 *
 * Browsers block audio before the first user gesture; a failed play is
 * swallowed — a notification sound must never surface an error.
 */

import { isCleanRecording } from '../components/help-videos/recorder/cleanRecording'
import { shouldPlayHere } from './tab-sound'

export type NotificationSound = 'off' | 'subtle' | 'chime'

let ctx: AudioContext | null = null

function audioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  try {
    if (!ctx) ctx = new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    return ctx
  } catch {
    return null
  }
}

function tone(ac: AudioContext, freq: number, start: number, dur: number, peak: number): void {
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  osc.connect(gain)
  gain.connect(ac.destination)
  osc.start(start)
  osc.stop(start + dur + 0.05)
}

/**
 * Play the configured notification sound. No-op for 'off'/unknown/unavailable audio.
 * With several tabs open only the most recently used one plays (#2435) — except `preview`,
 * the sample a settings control plays for the person looking at it.
 */
export function playNotificationSound(
  kind: NotificationSound | string | null | undefined,
  opts: { preview?: boolean } = {}
): void {
  if (!kind || kind === 'off') return
  // A clean help-video recording captures this tab's audio: stay silent.
  if (isCleanRecording()) return
  if (opts.preview) {
    playNow(kind)
    return
  }
  if (!shouldPlayHere()) return
  // The urgent chime (lib/urgent-chime.ts) hears the same arrival on its own listener: wait a
  // beat so that, when it plays, this one stays quiet — one sound per arrival.
  setTimeout(() => {
    if (!urgentChimeJustPlayed()) playNow(kind)
  }, URGENT_SOUND_DEFER_MS)
}

let lastUrgentChimeAt = 0
/** How long after the urgent chime the ordinary sound stays quiet (the same arrival). */
export const URGENT_SOUND_WINDOW_MS = 1500
/** How long the ordinary sound waits for a possible urgent chime of the same arrival. */
export const URGENT_SOUND_DEFER_MS = 120

/** The urgent chime just played (lib/urgent-chime.ts). */
export function noteUrgentChime(now = Date.now()): void {
  lastUrgentChimeAt = now
}

/** Did the urgent chime just play? Then the ordinary sound for that arrival is skipped. */
export function urgentChimeJustPlayed(now = Date.now()): boolean {
  return now - lastUrgentChimeAt < URGENT_SOUND_WINDOW_MS
}

function playNow(kind: string): void {
  const ac = audioCtx()
  if (!ac) return
  try {
    const t = ac.currentTime
    if (kind === 'chime') {
      tone(ac, 660, t, 0.14, 0.06)
      tone(ac, 880, t + 0.12, 0.2, 0.06)
    } else {
      // 'subtle' — one short quiet blip
      tone(ac, 880, t, 0.09, 0.03)
    }
  } catch {
    /* never let a chirp break the app */
  }
}

/** #2385 — the sound for one category: its own choice if the person made one,
 *  otherwise the global `notification_sound`. */
export function soundForCategory(
  prefs: { notification_sound?: unknown; notification_sounds?: unknown } | null | undefined,
  category: string | null | undefined
): string {
  const per = prefs?.notification_sounds
  if (category && per && typeof per === 'object') {
    const v = (per as Record<string, unknown>)[category]
    if (v === 'off' || v === 'subtle' || v === 'chime') return v
  }
  return typeof prefs?.notification_sound === 'string' ? prefs.notification_sound : 'off'
}
