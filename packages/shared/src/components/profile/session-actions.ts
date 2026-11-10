import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useOptionalNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import { errorText } from './types'

/**
 * The two administrator actions on another person's sessions, shared by the
 * user card (chat, the Online list, any person chip) and the people page's
 * Admin tools: reload every tab they have open, and sign them out of every
 * session on every app. Both reach every server (the reload rides their
 * socket room through the Redis adapter; a revoked session closes its sockets
 * everywhere).
 */

export interface ReloadPushed {
  sockets: number
  /** Distinct browser tabs among the sockets (one tab may hold two); older servers omit it. */
  tabs?: number
  users?: number
  nodes?: number
  partial?: boolean
  /** Sticky refresh: kept for tabs that connect later, this many hours. */
  remembered?: boolean
  remember_hours?: number
}

/** What the reload reached, in words. Only the tab count can fall short: a
 *  server without `nodes` counts only the tabs on the server that took it. */
export function reloadPushedText(r: ReloadPushed): string {
  const later = r.remembered
    ? ` Tabs that connect in the next ${r.remember_hours ?? 24} h reload too.`
    : ''
  // Tabs, not connections: a tab that briefly holds two sockets is still one tab.
  const tabs = typeof r.tabs === 'number' && r.sockets > 0 ? Math.max(1, r.tabs) : r.sockets
  return (
    (tabs > 0
      ? `Reload pushed to ${tabs} open tab${tabs === 1 ? '' : 's'}${r.partial ? ' (another server did not answer — there may be more)' : ''}.`
      : r.partial
        ? 'Reload sent — another server did not answer, so their open tabs could not be counted.'
        : r.nodes != null
          ? 'Reload sent — they have no tab open right now.'
          : 'Reload sent to every tab they have open (tabs on other servers are not counted).') +
    later
  )
}

/** How long an armed Sign out waits with an empty message box before letting go.
 *  30 s (was 10): long enough to decide what to write; a typed message holds it. */
export const SIGN_OUT_ARM_MS = 30_000

export function signedOutText(name: string, revoked: number): string {
  return revoked > 0
    ? `${name} is signed out of ${revoked} session${revoked === 1 ? '' : 's'} — every open tab goes back to sign-in.`
    : `${name} had no session open.`
}

/** POST /realtime/force-refresh for one person (admin). */
export function useReloadTheirTabs(userId: string, opts: { onDone?: () => void } = {}) {
  const client = useOptionalNivaroClient()
  return useMutation({
    mutationFn: (v: { seconds?: number; message?: string } = {}) => {
      if (!client) throw new Error('Not connected')
      return client
        .request<{ data: ReloadPushed }>(
          post('/realtime/force-refresh', {
            user_ids: [userId],
            seconds: v.seconds ?? 15,
            message: v.message ?? ''
          })
        )
        .then((r) => r.data)
    },
    onSuccess: (r) => {
      toast.success(reloadPushedText(r))
      opts.onDone?.()
    },
    onError: (e) => toast.error(errorText(e, 'Failed to push the reload'))
  })
}

/** POST /security/users/:id/sign-out (admin) — every session, every app. */
export function useSignOutEverywhere(
  userId: string,
  name: string,
  opts: { onDone?: () => void } = {}
) {
  const client = useOptionalNivaroClient()
  return useMutation({
    // `message` (optional): shown to them on their sign-in page (sign-out-note).
    mutationFn: (v: { message?: string } | void) => {
      if (!client) throw new Error('Not connected')
      const message = v && typeof v.message === 'string' ? v.message.trim() : ''
      return client
        .request<{ data: { revoked: number; message_left?: boolean } }>(
          post(`/security/users/${userId}/sign-out`, message ? { message } : {})
        )
        .then((r) => r.data)
    },
    onSuccess: (r) => {
      toast.success(
        signedOutText(name, r.revoked) +
          (r.message_left === true
            ? ' Your message waits on their sign-in page.'
            : r.message_left === false
              ? ' Your message could not be left — tell them another way.'
              : '')
      )
      opts.onDone?.()
    },
    onError: (e) => toast.error(errorText(e, 'Could not sign them out'))
  })
}
