import type { HelpVideoContext } from '../types'

/**
 * Recording window at a fixed size (#1516). "Open a recording window" opens
 * the current page again in a popup of a chosen size (`window.open(sameUrl,
 * 'nvr-recording', 'popup,width=…,height=…')`) and the recording is made from
 * that window, so every video has the same frame and readable text.
 *
 * The popup is the same app with the same session. The opener leaves it a
 * handoff (title, microphone, clean mode, script …) in localStorage under a
 * one-time token and names the token in the URL (`?nvr-record=<token>`); the
 * provider in the popup takes the handoff, drops the parameter and opens the
 * recorder at once, locked to recording its own tab. While it records, the
 * popup posts its status on a BroadcastChannel; the opener shows it and, when
 * the popup finishes, opens the editor for the new draft while the popup
 * closes itself. The final result is also left in localStorage, so an opener
 * without BroadcastChannel (or one that missed the message) still finds it
 * when the popup closes.
 */

export const RECORDING_WINDOW_NAME = 'nvr-recording'
export const RECORDING_CHANNEL = 'nvr-help-video-recording'
export const RECORD_PARAM = 'nvr-record'
/** The last size chosen, per browser. */
export const WINDOW_PREF_KEY = 'nvr_hv_record_window'
/** A handoff older than this is stale (the popup never opened). */
export const HANDOFF_MAX_AGE_MS = 10 * 60_000

export type WindowPreset = { id: string; w: number; h: number; label: string; hint: string }
export const WINDOW_PRESETS: WindowPreset[] = [
  { id: '1280x800', w: 1280, h: 800, label: '1280 × 800', hint: 'Laptop' },
  { id: '1440x900', w: 1440, h: 900, label: '1440 × 900', hint: 'Desktop' },
  { id: '1920x1080', w: 1920, h: 1080, label: '1920 × 1080', hint: 'Full HD' }
]
export const DEFAULT_WINDOW_PRESET = WINDOW_PRESETS[0].id

export type Size = { w: number; h: number }

export function presetById(id: string | null | undefined): WindowPreset {
  return WINDOW_PRESETS.find((p) => p.id === id) ?? WINDOW_PRESETS[0]
}

export function readWindowPref(): string {
  try {
    return presetById(window.localStorage.getItem(WINDOW_PREF_KEY)).id
  } catch {
    return DEFAULT_WINDOW_PRESET
  }
}

export function writeWindowPref(id: string): void {
  try {
    window.localStorage.setItem(WINDOW_PREF_KEY, presetById(id).id)
  } catch {
    /* private window or blocked storage: the choice lasts this session only */
  }
}

export const sizeLabel = (s: Size) => `${s.w} × ${s.h}`

/** The third argument of window.open for a popup of this inner size. */
export function popupFeatures(size: Size): string {
  return `popup,width=${size.w},height=${size.h}`
}

/** The page again, with the handoff token in its query. */
export function recordingUrl(href: string, token: string): string {
  const u = new URL(href)
  u.searchParams.set(RECORD_PARAM, token)
  return u.toString()
}

export function tokenFromSearch(search: string): string | null {
  const t = new URLSearchParams(search).get(RECORD_PARAM)
  return t && /^[a-z0-9-]{8,64}$/i.test(t) ? t : null
}

/** The page's URL without the handoff token (what a reload should load). */
export function withoutRecordParam(href: string): string {
  const u = new URL(href)
  u.searchParams.delete(RECORD_PARAM)
  return u.toString()
}

export function newToken(): string {
  const c = typeof crypto !== 'undefined' ? crypto : null
  if (c?.randomUUID) return c.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/** What the opener hands the popup. */
export type RecordingHandoff = {
  v: 1
  token: string
  /** Date.now() when written. */
  at: number
  size: Size
  videoId?: string
  contexts?: HelpVideoContext[]
  defaultTitle?: string
  options: {
    useMic: boolean
    micId: string
    captureClicks: boolean
    cleanScreen: boolean
    /** The script's text (#1491), one step per line. */
    script: string
  }
}

export const handoffKey = (token: string) => `nvr_hv_handoff_${token}`
export const resultKey = (token: string) => `nvr_hv_record_result_${token}`

export function writeHandoff(h: RecordingHandoff): boolean {
  try {
    window.localStorage.setItem(handoffKey(h.token), JSON.stringify(h))
    return true
  } catch {
    return false
  }
}

export function forgetHandoff(token: string): void {
  try {
    window.localStorage.removeItem(handoffKey(token))
    window.localStorage.removeItem(resultKey(token))
  } catch {
    /* nothing to forget */
  }
}

/** Reads (and removes) the handoff a token names; null when there is none,
 *  it is unreadable or it is stale. */
export function takeHandoff(token: string | null, now = Date.now()): RecordingHandoff | null {
  if (!token) return null
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(handoffKey(token))
    window.localStorage.removeItem(handoffKey(token))
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const h = JSON.parse(raw) as RecordingHandoff
    if (h?.v !== 1 || h.token !== token || typeof h.at !== 'number') return null
    if (now - h.at > HANDOFF_MAX_AGE_MS || !h.options || !h.size) return null
    return h
  } catch {
    return null
  }
}

/** True inside a recording window this module opened. */
export function isRecordingWindow(): boolean {
  return typeof window !== 'undefined' && window.name === RECORDING_WINDOW_NAME
}

/** The outer size that gives `inner` inside a window with these metrics
 *  (the chrome around the page is what the difference tells). */
export function outerSizeFor(
  inner: Size,
  win: { innerWidth: number; innerHeight: number; outerWidth: number; outerHeight: number }
): Size {
  return {
    w: inner.w + Math.max(0, win.outerWidth - win.innerWidth),
    h: inner.h + Math.max(0, win.outerHeight - win.innerHeight)
  }
}

/** Asks the browser for exactly `inner` and reports the size it ended up
 *  with (browsers may clamp to the screen or ignore the request). */
export function fitWindowTo(inner: Size): Size {
  try {
    const o = outerSizeFor(inner, window)
    window.resizeTo(o.w, o.h)
  } catch {
    /* not allowed: the actual size is reported instead */
  }
  return { w: window.innerWidth, h: window.innerHeight }
}

/** What to say when the window is not the size that was asked for. */
export function frameNote(wanted: Size, actual: Size): string | null {
  if (wanted.w === actual.w && wanted.h === actual.h) return null
  return `This window is ${sizeLabel(actual)}, not ${sizeLabel(wanted)}: the screen may have no room for it.`
}

/** What the popup tells the opener. */
export type RemoteStage = 'setup' | 'countdown' | 'recording' | 'saving' | 'uploaded' | 'error'
export type RemoteStatus = {
  stage: RemoteStage
  elapsed: number
  paused: boolean
  /** Parts still to upload. */
  pending: number
  /** The popup's actual inner size, once known. */
  size?: Size
}
export type RecordingMessage =
  | ({ token: string; type: 'status' } & RemoteStatus)
  | { token: string; type: 'done'; videoId: string }
  | { token: string; type: 'closed' }

export function openChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(RECORDING_CHANNEL)
  } catch {
    return null
  }
}

/** The popup's final word, for an opener that gets no message. */
export function writeResult(token: string, videoId: string | null): void {
  try {
    window.localStorage.setItem(resultKey(token), JSON.stringify({ videoId }))
  } catch {
    /* the opener falls back to "closed" */
  }
}

export function takeResult(token: string): { videoId: string | null } | null {
  try {
    const raw = window.localStorage.getItem(resultKey(token))
    window.localStorage.removeItem(resultKey(token))
    if (!raw) return null
    const r = JSON.parse(raw) as { videoId?: unknown }
    return { videoId: typeof r.videoId === 'string' ? r.videoId : null }
  } catch {
    return null
  }
}

export const POPUP_BLOCKED =
  'Your browser blocked the recording window. Allow pop-ups for this site and try again, or record in this tab.'
