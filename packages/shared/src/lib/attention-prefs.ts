import { useQuery } from '@tanstack/react-query'
import { useOptionalNivaroClient } from '../context'
import { get } from './commands'

/**
 * Profile → Display: how this tab tells the person something needs them.
 *
 *   tab_count      'on' (default) | 'off' — the waiting-on-you count in the tab title and icon
 *   live_announce  'full' (default) | 'brief' | 'off' — screen-reader notices of live changes
 */
export interface AttentionPrefs {
  tabCount: boolean
  announce: 'full' | 'brief' | 'off'
}

/** Read the two keys off a preference object (pure — exported for tests). */
export function attentionPrefsOf(
  prefs: Record<string, unknown> | null | undefined
): AttentionPrefs {
  const p = prefs ?? {}
  const a = p.live_announce
  return {
    tabCount: p.tab_count !== 'off',
    announce: a === 'brief' || a === 'off' ? a : 'full'
  }
}

/**
 * The signed-in person's attention preferences, on the same query key and shape the
 * profile page uses (so a change there shows here). Defaults while loading or without
 * a client, so a host without the profile route keeps the default behaviour.
 */
export function useAttentionPrefs(): AttentionPrefs {
  const client = useOptionalNivaroClient()
  const { data } = useQuery({
    queryKey: ['nvr-profile-prefs'],
    queryFn: () =>
      client!
        .request<{ data: { preferences?: Record<string, unknown> | null } }>(get('/users/me'))
        .then((r) => (r.data?.preferences ?? {}) as Record<string, unknown>),
    enabled: !!client,
    staleTime: 60_000,
    retry: false
  })
  return attentionPrefsOf(data)
}
