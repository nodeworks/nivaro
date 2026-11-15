/**
 * Desktop (OS) notifications for watched records (rt6 #4). Opt-in per person (watch list
 * settings `desktop`); the browser's permission is asked ONLY from that switch, never on load.
 *
 * One notification per change burst, only while the page is out of sight (hidden tab or another
 * window in front), and never for the person's own change: the dock asks the server which pins
 * someone ELSE changed (`/watch-list?summary=1` → `others`, newest other-person event per pin)
 * and only those count. Several open tabs make one notification: the first tab to claim the
 * burst in localStorage shows it, and every notification shares one tag, so a second one would
 * replace the first rather than stack.
 */

export const DESKTOP_TAG = 'nivaro-watch-list'
/** An "others" change older than this is not news (a burst read late, a stale answer). */
export const DESKTOP_FRESH_MS = 2 * 60_000
const CLAIM_KEY = 'nvr:watch-desktop:claim'
const CLAIM_MS = 8_000

export type DesktopPermission = 'granted' | 'denied' | 'default' | 'unsupported'

export function desktopPermission(): DesktopPermission {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined')
    return 'unsupported'
  return window.Notification.permission as DesktopPermission
}

/** Ask the browser (from a click on the setting only). */
export async function requestDesktopPermission(): Promise<DesktopPermission> {
  if (desktopPermission() === 'unsupported') return 'unsupported'
  try {
    return (await window.Notification.requestPermission()) as DesktopPermission
  } catch {
    return desktopPermission()
  }
}

/** The page is out of sight: a notification is worth showing. */
export function pageOutOfSight(): boolean {
  if (typeof document === 'undefined') return false
  return document.visibilityState === 'hidden' || !document.hasFocus()
}

/**
 * Which pins to tell about: changed in this burst, changed by someone else recently, and newer
 * than what this tab already told. Pure.
 */
export function keysToNotify(
  burst: string[],
  others: Record<string, string>,
  told: ReadonlyMap<string, string>,
  now: number
): string[] {
  const out: string[] = []
  for (const k of new Set(burst)) {
    const at = others[k]
    if (!at) continue
    const t = new Date(at).getTime()
    if (!Number.isFinite(t) || now - t > DESKTOP_FRESH_MS) continue
    const before = told.get(k)
    if (before && before >= at) continue
    out.push(k)
  }
  return out
}

/** Title + body for the burst. Pure. */
export function desktopText(
  keys: string[],
  titles: Record<string, string>
): { title: string; body: string } {
  if (keys.length === 1) {
    const name = titles[keys[0]]
    return {
      title: 'Watch list',
      body: name ? `${name} changed` : 'A record you watch changed'
    }
  }
  const named = keys.map((k) => titles[k]).filter(Boolean)
  return {
    title: 'Watch list',
    body:
      named.length > 0
        ? `${keys.length} records you watch changed: ${named.slice(0, 2).join(', ')}${
            keys.length > 2 ? '…' : ''
          }`
        : `${keys.length} records you watch changed`
  }
}

/** First tab to claim this burst shows it. True = this tab may show. */
export function claimBurst(keys: string[], now: number = Date.now()): boolean {
  const sig = [...keys].sort().join('|')
  try {
    const raw = window.localStorage.getItem(CLAIM_KEY)
    if (raw) {
      const prev = JSON.parse(raw) as { sig?: string; at?: number }
      if (prev.sig === sig && typeof prev.at === 'number' && now - prev.at < CLAIM_MS) return false
    }
    window.localStorage.setItem(CLAIM_KEY, JSON.stringify({ sig, at: now }))
  } catch {
    /* no storage: the shared tag still folds duplicates */
  }
  return true
}

/** Show it; a click brings the app forward. Never throws. */
export function showDesktop(text: { title: string; body: string }, onClick?: () => void): void {
  if (desktopPermission() !== 'granted') return
  try {
    const n = new window.Notification(text.title, {
      body: text.body,
      tag: DESKTOP_TAG,
      silent: false
    })
    n.onclick = () => {
      try {
        window.focus()
      } catch {
        /* the browser decides */
      }
      onClick?.()
      n.close()
    }
  } catch {
    /* some browsers only allow it from a service worker: then nothing is shown */
  }
}
