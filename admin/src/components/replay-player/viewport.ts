/**
 * The recorded viewport the player fits to: the LARGEST one in the recording.
 *
 * A recording's viewport changes when the person resizes their browser window,
 * moves it to another screen or changes its zoom. rrweb then emits a Meta event
 * or a ViewportResize incremental (source 4) and resizes the replay iframe. The
 * player used to fit whatever size was current, so a window that went from
 * 1920×911 to 1280×551 made the frame jump to 1.5× the scale and the page
 * looked zoomed in (staging, 2026-10-28, a person moving between an external
 * monitor and a laptop screen four minutes in).
 *
 * Fitting the largest viewport keeps one scale for the whole recording: a
 * smaller window shows as a smaller page inside the same frame, at the same
 * size, as it was on the person's screen.
 */

export interface ViewportSize {
  width: number
  height: number
}

/** rrweb event type 4 = Meta; type 3 source 4 = ViewportResize. */
function sizeOf(e: unknown): ViewportSize | null {
  const ev = e as { type?: unknown; data?: Record<string, unknown> | null } | null
  if (!ev?.data) return null
  const isMeta = ev.type === 4
  const isResize = ev.type === 3 && Number(ev.data.source) === 4
  if (!isMeta && !isResize) return null
  const width = Number(ev.data.width)
  const height = Number(ev.data.height)
  if (!(width > 0) || !(height > 0)) return null
  return { width, height }
}

/**
 * The largest width and height any Meta / ViewportResize event carries,
 * grown from `prev` (live follow adds events as they stream in). Null when
 * none says.
 */
export function viewportBounds(
  events: unknown[],
  prev: ViewportSize | null = null
): ViewportSize | null {
  let out = prev ? { ...prev } : null
  for (const e of events) {
    const s = sizeOf(e)
    if (!s) continue
    if (!out) out = { ...s }
    else {
      if (s.width > out.width) out.width = s.width
      if (s.height > out.height) out.height = s.height
    }
  }
  return out
}

/** Whether `next` is a different box from `prev` (the player re-fits only then). */
export function boundsChanged(prev: ViewportSize | null, next: ViewportSize | null): boolean {
  return prev?.width !== next?.width || prev?.height !== next?.height
}

/**
 * The scale that fits `box` into `budgetW` × `budgetH`, up as well as down.
 */
export function fitScale(box: ViewportSize, budgetW: number, budgetH: number): number {
  return Math.min(budgetW / box.width, budgetH / box.height)
}

/** A recording made by a native app: shown inside a phone or tablet frame. */
export type ReplayDevice = 'phone' | 'tablet'

/**
 * Which device frame a recording plays in, or null for a browser one. A native
 * app's recorder (the EFP phone app) sends a Meta href on its own scheme
 * (`efp-mobile://app/...`), never http(s); its shorter side says phone or tablet.
 */
export function replayDevice(events: unknown[]): ReplayDevice | null {
  for (const e of events) {
    const ev = e as { type?: unknown; data?: Record<string, unknown> | null } | null
    if (ev?.type !== 4 || !ev.data) continue
    const href = String(ev.data.href ?? '')
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase()
    if (!scheme || ['http', 'https', 'file', 'about', 'blob', 'data'].includes(scheme)) return null
    const s = sizeOf(ev)
    return s && Math.min(s.width, s.height) >= 600 ? 'tablet' : 'phone'
  }
  return null
}

/** Bezel around a device frame, in screen px (it does not scale with the recording). */
export const DEVICE_BEZEL_PX: Record<ReplayDevice, number> = { phone: 10, tablet: 14 }

/** Screen corner radius as a share of the rendered screen width (iPhone ~55 pt on 393). */
export const DEVICE_CORNER: Record<ReplayDevice, number> = { phone: 0.14, tablet: 0.045 }
