import { useRef } from 'react'
import { huddleHolds } from '../components/chat/huddle/huddle-hold'
import { isCleanRecording } from '../components/help-videos/recorder/cleanRecording'
import { isDndActive } from './dnd'
import { isFocusModeOn } from './focus-mode'
import { useLiveEvent } from './live'
import { getLiveMode, type LiveMode } from './live-preference'
import { noteUrgentChime } from './notification-sound'
import { shouldPlayHere } from './tab-sound'

/**
 * The urgent-items chime (realtime round 9, item 14) — opt-in, off by default.
 *
 * Profile → Notifications → "Play a sound for urgent items" (`preferences.urgent_sound`). When
 * a notification the server marks `urgent` (api services/notification-urgent.ts: a critical
 * row, an SLA breach waiting on you, an urgent task, a record whose collection's urgent flag is
 * on) reaches this person, ONE tab plays a short two-note chime, synthesized with Web Audio (no
 * asset). It never plays:
 *   - while Live updates are Off, or with do not disturb, focus mode, a huddle holding
 *     notifications, inside the person's quiet hours (`quiet` from the server), or during a clean
 *     help-video recording;
 *   - before the person has used the page (the browser's autoplay rule: no audio is even
 *     prepared until a click or key has happened in this tab).
 * When the chime plays, the ordinary per-category notification sound for that same arrival is
 * skipped (lib/notification-sound.ts asks `urgentChimeJustPlayed`), so it is never two sounds.
 */

export interface UrgentArrival {
  urgent?: unknown
  quiet?: unknown
}

export interface UrgentChimeContext {
  enabled: boolean
  liveMode: LiveMode
  dnd: boolean
  focus: boolean
  huddle: boolean
  recording: boolean
  /** The page has had a click or key (autoplay rules). */
  activated: boolean
}

/** Pure: does this arrival chime here? */
export function shouldChime(n: UrgentArrival | null | undefined, ctx: UrgentChimeContext): boolean {
  if (!ctx.enabled || n?.urgent !== true || n.quiet === true) return false
  if (ctx.liveMode === 'off') return false
  if (ctx.dnd || ctx.focus || ctx.huddle || ctx.recording) return false
  return ctx.activated
}

/** The setting as stored (true only — anything else is off). */
export function urgentSoundOn(prefs: Record<string, unknown> | null | undefined): boolean {
  return prefs?.urgent_sound === true
}

function pageActivated(): boolean {
  try {
    const ua = (navigator as Navigator & { userActivation?: { hasBeenActive?: boolean } })
      .userActivation
    // Browsers without the API: assume the usual case (a page someone is using).
    return ua?.hasBeenActive ?? true
  } catch {
    return false
  }
}

let ctx: AudioContext | null = null

/**
 * Two soft notes a fifth apart (E5 → B5) with a little air, ~0.5 s — distinct from the
 * ordinary 'chime' (a rising third) without being an alarm. Triangle for warmth, gentle peak.
 */
export function playUrgentChime(opts: { preview?: boolean } = {}): boolean {
  if (typeof window === 'undefined') return false
  if (!opts.preview && (!shouldPlayHere() || !pageActivated())) return false
  try {
    if (!ctx) ctx = new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    const ac = ctx
    const t = ac.currentTime
    const note = (freq: number, start: number, dur: number, peak: number) => {
      const osc = ac.createOscillator()
      const gain = ac.createGain()
      osc.type = 'triangle'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur)
      osc.connect(gain)
      gain.connect(ac.destination)
      osc.start(start)
      osc.stop(start + dur + 0.05)
    }
    note(659.25, t, 0.22, 0.07)
    note(987.77, t + 0.13, 0.36, 0.06)
    noteUrgentChime()
    return true
  } catch {
    return false
  }
}

/**
 * Listen for urgent arrivals and chime when the person asked for it. Mounted once per app shell
 * (LivePreferenceHost does it), with the person's preferences.
 */
export function useUrgentChime(prefs: Record<string, unknown> | null | undefined): void {
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const enabled = urgentSoundOn(prefs)
  useLiveEvent(
    'notification:new',
    (n: UrgentArrival) => {
      const p = prefsRef.current
      const play = shouldChime(n, {
        enabled: urgentSoundOn(p),
        liveMode: getLiveMode(),
        dnd: isDndActive(p ?? null),
        focus: isFocusModeOn(),
        huddle: huddleHolds(p ?? null),
        recording: isCleanRecording(),
        activated: true
      })
      if (play) playUrgentChime()
    },
    { enabled, includeOwn: true }
  )
}
