import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useOptionalNivaroClient } from '../context'
import { get } from './commands'
import { useLiveEvent } from './live'

/**
 * Feature flags client (#651): `useFeatureFlag('new_dashboard')` — the
 * caller's effective set comes from GET /feature-flags/mine (role +
 * percentage resolved server-side), cached 60s and re-read when a flag is toggled. Unknown flags and fetch
 * failures resolve FALSE, so a flag can gate new code with zero risk to the
 * old path.
 */
export function useFeatureFlags(): { flags: Set<string>; ready: boolean } {
  const client = useOptionalNivaroClient()
  const qc = useQueryClient()
  // #1741 — a toggle is pushed (`flags:changed`): re-read at once, and again a moment later in
  // case this read landed on a server that had not yet dropped its own copy.
  useLiveEvent(
    'flags:changed',
    () => {
      void qc.invalidateQueries({ queryKey: ['feature-flags-mine'] })
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['feature-flags-mine'] }), 3000)
    },
    { debounceMs: 300, includeOwn: true, enabled: !!client }
  )
  const { data, isFetched } = useQuery({
    queryKey: ['feature-flags-mine'],
    enabled: !!client,
    staleTime: 60_000,
    queryFn: () =>
      client!
        .request<{ data: string[] }>(get('/feature-flags/mine'))
        .then((r) => r.data ?? [])
        .catch(() => [] as string[])
  })
  return { flags: new Set(data ?? []), ready: isFetched || !client }
}

export function useFeatureFlag(key: string): boolean {
  return useFeatureFlags().flags.has(key)
}
