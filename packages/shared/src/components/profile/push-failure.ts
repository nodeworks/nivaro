/**
 * Why "Turn on" for browser notifications failed, in words a person can act on
 * (2026-10-26). Every refusal used to end in one catch-all sentence, so an
 * incognito window, a blocked prompt, a missing service worker and a server
 * without a push key all read "Could not turn on browser notifications."
 */

/** Where in the turn-on sequence it stopped. */
export type PushStage =
  | 'unsupported'
  | 'insecure'
  | 'permission'
  | 'register'
  | 'ready'
  | 'key'
  | 'subscribe'
  | 'save'

export interface PushFailure {
  /** What happened and what to do about it. */
  text: string
  /** The browser's or server's own words, for whoever helps them (may be empty). */
  detail: string
}

function errName(err: unknown): string {
  return err && typeof err === 'object' && 'name' in err ? String((err as Error).name) : ''
}

function errStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  const e = err as { status?: unknown; response?: { status?: unknown } }
  const s = Number(e.status ?? e.response?.status)
  return Number.isFinite(s) && s > 0 ? s : null
}

export function describeError(err: unknown): string {
  if (err == null) return ''
  if (typeof err === 'string') return err
  const name = errName(err)
  const msg =
    err instanceof Error || typeof err === 'object' ? String((err as Error).message ?? '') : ''
  const status = errStatus(err)
  return [status ? `HTTP ${status}` : '', name && name !== 'Error' ? name : '', msg]
    .filter(Boolean)
    .join(': ')
    .slice(0, 300)
}

export function pushFailure(
  stage: PushStage,
  err?: unknown,
  ctx: { permission?: NotificationPermission | null } = {}
): PushFailure {
  const detail = describeError(err)
  const name = errName(err)
  switch (stage) {
    case 'insecure':
      return {
        text: 'Browser notifications only work over a secure (https) connection. Open the app at its https address and try again.',
        detail
      }
    case 'unsupported':
      return {
        text: 'This browser window cannot receive push notifications. Private and incognito windows usually cannot — open the app in a normal window of Chrome, Edge, Firefox or Safari.',
        detail
      }
    case 'permission':
      return ctx.permission === 'denied'
        ? {
            text: 'Notifications are blocked for this site. Allow them in your browser’s site settings (the icon left of the address), then try again. Incognito windows block them always — use a normal window.',
            detail
          }
        : {
            text: 'The permission prompt was closed without allowing notifications. Press Turn on again and choose Allow.',
            detail
          }
    case 'register':
      return {
        text: 'The app could not install its notification helper (service worker). Reload the page and try again; if it keeps failing, tell your administrator.',
        detail
      }
    case 'ready':
      return {
        text: 'The notification helper (service worker) did not start. Reload the page and try again.',
        detail
      }
    case 'key':
      return {
        text:
          errStatus(err) === 401 || errStatus(err) === 403
            ? 'Your sign-in could not fetch the push key. Sign in again, then try again.'
            : 'The server is not set up to send browser notifications (it gave no push key). Tell your administrator.',
        detail
      }
    case 'subscribe':
      // Chrome raises AbortError "Registration failed - permission denied" in an
      // Incognito window (and when the site's notification permission is
      // overridden), even after the prompt said Allow.
      if (name === 'NotAllowedError' || /permission denied/i.test(detail))
        return {
          text: 'The browser refused the push subscription. This happens in Incognito / private windows and when notifications are blocked for this site — open the app in a normal window, allow notifications for this site, and try again.',
          detail
        }
      if (name === 'AbortError')
        return {
          text: 'The browser’s push service is not available. Private windows do not have one; in Brave turn on “Use Google services for push messaging” (Settings → Privacy and security), then try again.',
          detail
        }
      if (name === 'NotSupportedError')
        return {
          text: 'This browser does not support push notifications for this site.',
          detail
        }
      return {
        text: 'The browser could not create a push subscription. Try again; if it keeps failing, tell your administrator what it said below.',
        detail
      }
    case 'save':
      return {
        text: 'This browser subscribed, but the server could not save it. Try again in a moment.',
        detail
      }
  }
}
