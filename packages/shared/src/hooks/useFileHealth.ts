import { useQuery } from '@tanstack/react-query'
import { useOptionalNivaroClient } from '../context'
import { post } from '../lib/commands'

/**
 * Dead-file-link awareness for anything rendering file chips/links.
 *
 * Batch-verifies the given file ids against the storage provider (POST
 * /files/verify — persists the verdict on the rows too) and returns a lookup:
 * `health.isMissing(id)` → true when the physical bytes are gone. Cached 5
 * minutes per id-set; degrades to "nothing missing" on any failure — a
 * broken check must never paint healthy files as dead.
 */
export function useFileHealth(ids: Array<string | null | undefined>) {
  const client = useOptionalNivaroClient()
  const clean = [...new Set(ids.filter((v): v is string => !!v))].sort()
  const { data } = useQuery<Record<string, { missing: boolean }>>({
    queryKey: ['file-health', clean.join(',')],
    queryFn: () =>
      client!
        .request<{ data: Record<string, { missing: boolean }> }>(
          post('/files/verify', { ids: clean.slice(0, 100) })
        )
        .then((r) => r.data)
        .catch(() => ({})),
    enabled: !!client && clean.length > 0,
    staleTime: 5 * 60_000
  })
  return {
    isMissing: (id: string | null | undefined): boolean => !!id && data?.[id]?.missing === true,
    /** Fresh verdict when the check has run for this id, undefined otherwise —
     *  lets callers prefer the live answer over a stale stored missing_at. */
    verdict: (id: string | null | undefined): boolean | undefined =>
      id && data && id in data ? data[id].missing : undefined
  }
}
