import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useOptionalNivaroClient } from '../context'
import { get } from '../lib/commands'
import { useLiveEvent } from '../lib/live'
import { parseLiveMode, resolveLiveMode, setLiveMode } from '../lib/live-preference'

/**
 * Feeds the person's live-updates setting (lib/live-preference.ts) into this tab. Mount ONCE per
 * app shell, inside the NivaroProvider and QueryClientProvider. Reads the same profile query the
 * Display card writes (`nvr-profile-prefs`, refreshed on `prefs:changed` by user-sync), plus the
 * role's default from GET /live-preference/default. Until both answered, the tab keeps the mode
 * it last ran in (stored per browser), so an Off tab never flickers live on a page load.
 */
export function LivePreferenceHost() {
  const client = useOptionalNivaroClient()
  const qc = useQueryClient()
  const prefs = useQuery({
    queryKey: ['nvr-profile-prefs'],
    queryFn: () =>
      client!
        .request<{ data: { preferences?: Record<string, unknown> | null } }>(get('/users/me'))
        .then((r) => (r.data?.preferences ?? {}) as Record<string, unknown>),
    enabled: !!client,
    staleTime: 60_000,
    retry: false
  })
  const role = useQuery({
    queryKey: ['live-preference-default'],
    queryFn: () =>
      client!
        .request<{ data: { mode?: string | null } }>(get('/live-preference/default'))
        .then((r) => parseLiveMode(r.data?.mode))
        .catch(() => null),
    enabled: !!client,
    staleTime: 5 * 60_000,
    retry: false
  })
  // An administrator changed a role default: the server tells the role's people this way.
  useLiveEvent('prefs:changed', (p) => {
    const keys = Array.isArray(p?.keys) ? (p.keys as string[]) : null
    if (!keys || keys.includes('live_mode'))
      void qc.invalidateQueries({ queryKey: ['live-preference-default'] })
  })
  const own = prefs.data?.live_mode
  const ready = prefs.isSuccess && (role.isSuccess || role.isError)
  const roleMode = role.data ?? null
  useEffect(() => {
    if (!ready) return
    const r = resolveLiveMode(own, roleMode)
    setLiveMode(r.mode, r.source)
  }, [ready, own, roleMode])
  return null
}
