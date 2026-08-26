/**
 * Notification sounds (#684) — synthesized via WebAudio so no audio asset
 * ships (and no CSP/font-style fetch can fail silently). Preference lives at
 * `preferences.notification_sound` ('off' | 'subtle' | 'chime', default off).
 *
 * Browsers block audio before the first user gesture; a failed play is
 * swallowed — a notification sound must never surface an error.
 */

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

/** Play the configured notification sound. No-op for 'off'/unknown/unavailable audio. */
export function playNotificationSound(kind: NotificationSound | string | null | undefined): void {
  if (!kind || kind === 'off') return
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
