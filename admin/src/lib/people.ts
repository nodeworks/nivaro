import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

/** Display names for user ids (the shared people-card batch route), keyed by upper-cased id. */
export function usePeople(ids: Array<string | null | undefined>) {
  const list = [...new Set(ids.filter((x): x is string => !!x))].sort()
  return useQuery({
    queryKey: ['people-cards', 'names', list] as const,
    queryFn: () =>
      api
        .post<{
          data: Array<{
            id: string
            first_name: string | null
            last_name: string | null
            email: string
          }>
        }>('/users/cards', { ids: list })
        .then((r) => {
          const out: Record<string, string> = {}
          for (const u of r.data.data ?? []) {
            const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
            out[String(u.id).toUpperCase()] = name || u.email
          }
          return out
        }),
    enabled: list.length > 0,
    staleTime: 5 * 60_000
  })
}

/** A name from `usePeople`'s answer; `given` (a stored name) wins. */
export function personName(
  names: Record<string, string> | undefined,
  id: string | null | undefined,
  given?: string | null
): string | null {
  if (given) return given
  if (!id) return null
  return names?.[id.toUpperCase()] ?? null
}
