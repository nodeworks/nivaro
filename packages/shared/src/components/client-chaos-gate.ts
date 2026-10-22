import { useQuery } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'
import { useApiFetchConfig } from '../context'
import {
  type ClientChaosState,
  canUseClientChaos,
  getClientChaos,
  pretendDownVersion,
  stopClientChaos,
  subscribeClientChaos
} from '../lib/client-chaos'

/**
 * The chaos gate as the browser sees it (#2840): `GET /api/chaos/status` says whether chaos is
 * allowed on this instance at all (refused in cloud mode and on production by default). A server
 * without the route (404) or an unreachable answer = chaos off, and every chaos surface hides.
 */
export interface ClientChaosGate {
  /** Still asking. */
  loading: boolean
  /** The server has chaos (the route answered). False hides every chaos surface. */
  present: boolean
  /** This person may use browser chaos here right now. */
  allowed: boolean
  /** Why not, when the server refused (shown in the toolbar). */
  reason: string | null
}

export type ClientChaosUser = { is_admin?: boolean | null; masquerade?: boolean | null } | null

interface StatusBody {
  data?: { allowed?: boolean; reason?: string | null }
}

export const CLIENT_CHAOS_STATUS_KEY = ['client-chaos', 'status'] as const

export function useClientChaosGate(user: ClientChaosUser | undefined): ClientChaosGate {
  const eligible = canUseClientChaos(user)
  const { apiBase, authHeaders, credentials } = useApiFetchConfig()
  const q = useQuery({
    queryKey: [...CLIENT_CHAOS_STATUS_KEY, apiBase],
    enabled: eligible,
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<{ present: boolean; allowed: boolean; reason: string | null }> => {
      try {
        const res = await fetch(`${apiBase}/chaos/status`, {
          headers: authHeaders,
          credentials,
          cache: 'no-store'
        })
        if (res.status === 404) return { present: false, allowed: false, reason: null }
        const body = (await res.json().catch(() => null)) as StatusBody | null
        if (!res.ok) {
          return {
            present: true,
            allowed: false,
            reason: (body as { error?: string } | null)?.error ?? `The server said ${res.status}.`
          }
        }
        return {
          present: true,
          allowed: body?.data?.allowed === true,
          reason: body?.data?.reason ?? null
        }
      } catch {
        return { present: false, allowed: false, reason: null }
      }
    }
  })
  const gate: ClientChaosGate = !eligible
    ? { loading: false, present: false, allowed: false, reason: null }
    : q.data
      ? { loading: false, ...q.data }
      : { loading: q.isLoading, present: false, allowed: false, reason: null }

  // A window restored after a reload, in a tab whose gate now says no (chaos switched off, the
  // person no longer an admin): it ends here rather than running on unseen.
  const refused = !gate.loading && !gate.allowed && (q.isFetched || !eligible)
  useEffect(() => {
    if (refused && getClientChaos()) stopClientChaos()
  }, [refused])
  return gate
}

/** This tab's chaos window, live. */
export function useClientChaos(): ClientChaosState | null {
  return useSyncExternalStore(subscribeClientChaos, getClientChaos, () => null)
}

/** Re-renders whenever any surface changes what it pretends is down. */
export function usePretendDownVersion(): number {
  return useSyncExternalStore(subscribeClientChaos, pretendDownVersion, () => 0)
}
