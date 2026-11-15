import { useEffect, useState, useSyncExternalStore } from 'react'
import { isOwnWrite } from './own-writes'

/**
 * Live updates, the person's own setting (realtime round 3, item 24) — Profile → Display:
 *
 *   normal  what the app always did: changes land in place with a short fade, new rows carry a
 *           dot, co-viewers and "Beth is writing a note" show.
 *   calm    the same data, quieter: values change without fades, flashes or marks, a list keeps
 *           its order until the person pauses (no pointer or keys for a few seconds), and no
 *           typing or "who else is here" indicators.
 *   off     no live data refresh at all: someone else's change shows after the ↻ refresh-data
 *           button (or the next time the screen loads). New-version reloads, the person's own
 *           writes, notifications, preferences and access changes still arrive.
 *
 * Stored as `preferences.live_mode` (PATCH /users/me/preferences; null = the role's default,
 * GET /api/live-preference/default, else normal). This module is the ONE read: the transport
 * tap (realtime.ts `withLiveSeenTap`), the live hooks (live.ts), the list/screen helpers and
 * the CSS (`html[data-live-mode]`) all ask it, so a surface built on them follows the setting
 * without knowing about it. `LivePreferenceHost` (mounted once per app shell) feeds it from the
 * profile query; every tab of the browser follows a change at once (localStorage `storage`
 * event), other devices on the `prefs:changed` notice user-sync already handles.
 */

export type LiveMode = 'calm' | 'normal' | 'off'
export type LiveModeSource = 'own' | 'role' | 'default'

export const LIVE_MODES: readonly LiveMode[] = ['normal', 'calm', 'off']

export const LIVE_MODE_LABELS: Record<LiveMode, string> = {
  normal: 'Normal',
  calm: 'Calm',
  off: 'Off'
}

const STORAGE_KEY = 'nvr:live-mode'
/** How long without pointer, wheel or keys counts as "paused" for a Calm list. */
export const LIVE_CALM_PAUSE_MS = 3000

/** A stored or posted value → a mode, or null when it is none of them. */
export function parseLiveMode(v: unknown): LiveMode | null {
  return v === 'calm' || v === 'normal' || v === 'off' ? v : null
}

/** The person's own choice wins, then their role's default, then normal (pure). */
export function resolveLiveMode(
  own: unknown,
  roleDefault: unknown
): { mode: LiveMode; source: LiveModeSource } {
  const o = parseLiveMode(own)
  if (o) return { mode: o, source: 'own' }
  const r = parseLiveMode(roleDefault)
  if (r) return { mode: r, source: 'role' }
  return { mode: 'normal', source: 'default' }
}

// ── Named socket events the setting quiets ────────────────────────────────

/**
 * Who-else-is-here and typing signals: quiet in Calm and Off. The person still joins the
 * record room (others keep seeing them); only what this tab SHOWS goes quiet.
 */
export const LIVE_PRESENCE_EVENTS: ReadonlySet<string> = new Set([
  'record:viewers',
  'record:signal',
  'field:editing',
  'field:changed',
  'presence:rows',
  'record:uploading',
  // rt8 #21 — "Claude (for Rob) is updating this record".
  'record:agents'
])

/**
 * Data-refresh notices: quiet in Off. Everything not listed keeps arriving in every mode —
 * prefs/access/people/read sync, notifications, locks (someone asking for yours), job and
 * import progress, force refresh and new-version notices, chat, huddles.
 */
export const LIVE_DATA_EVENTS: ReadonlySet<string> = new Set([
  'collection:update',
  'record:comment',
  'record:integrity',
  'record:automation',
  'owners:changed',
  'activity:pulse',
  'bulk:rows',
  'widget:data',
  'widget:stale',
  'ops:changed'
])

/** Should this named event be dropped before it reaches a screen? (pure for a given mode) */
export function liveEventQuiet(event: string, mode: LiveMode = getLiveMode()): boolean {
  if (mode === 'normal') return false
  if (LIVE_PRESENCE_EVENTS.has(event)) return true
  return mode === 'off' && LIVE_DATA_EVENTS.has(event)
}

/**
 * A `collection:update` reaches screens unless live updates are Off and the write was not this
 * tab's own (an own write still refreshes what it changed, e.g. a background save finishing).
 */
export function liveCollectionEventPasses(
  ev:
    | { collection?: unknown; item?: unknown; items?: unknown; changed_fields?: unknown }
    | null
    | undefined,
  mode: LiveMode = getLiveMode()
): boolean {
  if (mode !== 'off') return true
  if (!ev || typeof ev.collection !== 'string') return false
  const collection = ev.collection
  const fields = Array.isArray(ev.changed_fields) ? (ev.changed_fields as string[]) : null
  // A coalesced burst lists its ids: it passes when one of them is this tab's own write.
  const ids = Array.isArray(ev.items) ? (ev.items as Array<string | number>) : [ev.item]
  return ids.some(
    (id) => id != null && id !== '*' && isOwnWrite(collection, id as string | number, fields)
  )
}

// ── The store ─────────────────────────────────────────────────────────────

interface Snapshot {
  mode: LiveMode
  source: LiveModeSource
}

let snapshot: Snapshot = { mode: readStored() ?? 'normal', source: 'default' }
const listeners = new Set<() => void>()
let storageHooked = false

function readStored(): LiveMode | null {
  try {
    return typeof localStorage === 'undefined'
      ? null
      : parseLiveMode(localStorage.getItem(STORAGE_KEY))
  } catch {
    return null
  }
}

function paint(mode: LiveMode): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (mode === 'normal') root.removeAttribute('data-live-mode')
  else root.setAttribute('data-live-mode', mode)
}

function hookStorage(): void {
  if (storageHooked || typeof window === 'undefined') return
  storageHooked = true
  // Another tab of this browser saved or loaded a different mode: follow it at once.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return
    const m = parseLiveMode(e.newValue)
    if (m && m !== snapshot.mode) apply({ mode: m, source: snapshot.source }, false)
  })
}

function apply(next: Snapshot, persist: boolean): void {
  const changed = next.mode !== snapshot.mode || next.source !== snapshot.source
  snapshot = next
  paint(next.mode)
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, next.mode)
    } catch {
      /* private window — this tab still follows it */
    }
  }
  if (changed) for (const l of listeners) l()
}

paint(snapshot.mode)

/** The mode this tab runs in now. */
export function getLiveMode(): LiveMode {
  return snapshot.mode
}

/** Set the mode (the host does this from the profile; tests and tools may too). */
export function setLiveMode(mode: LiveMode, source: LiveModeSource = 'own'): void {
  hookStorage()
  apply({ mode, source }, true)
}

export function subscribeLiveMode(cb: () => void): () => void {
  hookStorage()
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export interface LivePreference {
  mode: LiveMode
  source: LiveModeSource
  normal: boolean
  calm: boolean
  off: boolean
  /** Calm or Off: no fades, flashes, marks or presence indicators. */
  quiet: boolean
}

export function livePreferenceOf(s: Snapshot): LivePreference {
  return {
    mode: s.mode,
    source: s.source,
    normal: s.mode === 'normal',
    calm: s.mode === 'calm',
    off: s.mode === 'off',
    quiet: s.mode !== 'normal'
  }
}

/** The person's live-updates setting; re-renders when it changes (any tab). */
export function useLivePreference(): LivePreference {
  const s = useSyncExternalStore(
    subscribeLiveMode,
    () => snapshot,
    () => snapshot
  )
  return livePreferenceOf(s)
}

function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    )
  } catch {
    return false
  }
}

/**
 * May a live change animate (fade, flash, roll a number, slide a row in)? Only in Normal and
 * without reduced motion. Every live animation asks this one question.
 */
export function liveMotionAllowed(): boolean {
  return snapshot.mode === 'normal' && !prefersReducedMotion()
}

// ── "Paused" for Calm lists ───────────────────────────────────────────────

let lastInput = 0
let inputHooked = false
function hookInput(): void {
  if (inputHooked || typeof document === 'undefined') return
  inputHooked = true
  const note = () => {
    lastInput = Date.now()
  }
  for (const e of ['pointermove', 'pointerdown', 'wheel', 'keydown', 'touchstart'])
    document.addEventListener(e, note, { capture: true, passive: true })
}

/** Has the person been still (no pointer, wheel or keys) for `ms`? Pure given the clock. */
export function livePausedAt(now: number, last: number, ms = LIVE_CALM_PAUSE_MS): boolean {
  return now - last >= ms
}

/**
 * Calm lists hold their order until the person pauses. True while they are moving or typing
 * (and for `ms` after); false in Normal/Off or when `enabled` is false. Re-renders at most twice
 * per burst of activity (start, then pause), never per pointer move.
 */
export function useLiveBusy(enabled: boolean, ms = LIVE_CALM_PAUSE_MS): boolean {
  const { calm } = useLivePreference()
  const on = enabled && calm
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!on || typeof document === 'undefined') {
      setBusy(false)
      return
    }
    hookInput()
    let timer: ReturnType<typeof setTimeout> | null = null
    let isBusy = false
    const settle = () => {
      timer = null
      const left = ms - (Date.now() - lastInput)
      if (left > 0) {
        timer = setTimeout(settle, left)
        return
      }
      isBusy = false
      setBusy(false)
    }
    const onInput = () => {
      if (!isBusy) {
        isBusy = true
        setBusy(true)
      }
      if (!timer) timer = setTimeout(settle, ms)
    }
    const evs = ['pointermove', 'pointerdown', 'wheel', 'keydown', 'touchstart']
    for (const e of evs) document.addEventListener(e, onInput, { capture: true, passive: true })
    if (!livePausedAt(Date.now(), lastInput, ms)) onInput()
    return () => {
      for (const e of evs) document.removeEventListener(e, onInput, { capture: true })
      if (timer) clearTimeout(timer)
    }
  }, [on, ms])
  return on && busy
}

/** Tests only: back to Normal with nothing stored. */
export function __resetLivePreferenceForTests(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* none */
  }
  snapshot = { mode: 'normal', source: 'default' }
  paint('normal')
  for (const l of listeners) l()
}
