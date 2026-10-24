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
  return (
    (r.sockets > 0
      ? `Reload pushed to ${r.sockets} open tab${r.sockets === 1 ? '' : 's'}${r.partial ? ' (another server did not answer — there may be more)' : ''}.`
      : r.partial
        ? 'Reload sent — another server did not answer, so their open tabs could not be counted.'
        : r.nodes != null
          ? 'Reload sent — they have no tab open right now.'
          : 'Reload sent to every tab they have open (tabs on other servers are not counted).') +
    later
  )
}

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
    mutationFn: () => {
      if (!client) throw new Error('Not connected')
      return client
        .request<{ data: { revoked: number } }>(post(`/security/users/${userId}/sign-out`))
        .then((r) => r.data)
    },
    onSuccess: (r) => {
      toast.success(signedOutText(name, r.revoked))
      opts.onDone?.()
    },
    onError: (e) => toast.error(errorText(e, 'Could not sign them out'))
  })
}
