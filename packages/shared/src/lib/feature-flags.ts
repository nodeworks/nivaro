import { useQuery } from '@tanstack/react-query'
import { useOptionalNivaroClient } from '../context'
import { get } from './commands'

/**
 * Feature flags client (#651): `useFeatureFlag('new_dashboard')` — the
 * caller's effective set comes from GET /feature-flags/mine (role +
 * percentage resolved server-side), cached 60s. Unknown flags and fetch
 * failures resolve FALSE, so a flag can gate new code with zero risk to the
 * old path.
 */
export function useFeatureFlags(): { flags: Set<string>; ready: boolean } {
  const client = useOptionalNivaroClient()
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
