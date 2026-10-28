import { userErrorMessage } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import type { SavedSearch, SearchCommand } from './global-search-helpers'
import { commandRequest } from './global-search-helpers'

/**
 * Admin calls of the global search beside the main GET /global-search: saved
 * searches (#13), the learned-ranking click (#6) and command runs (#19). Every
 * endpoint here may be missing on an older API — callers degrade (no saved
 * group, no Save button, no click) instead of erroring.
 */

const SAVED_KEY = ['global-search-saved']
const status = (e: unknown) => (e as { response?: { status?: number } })?.response?.status

/** Saved searches; `available` is false when the API has no such endpoint. */
export function useSavedSearches(enabled: boolean) {
  const q = useQuery({
    queryKey: SAVED_KEY,
    queryFn: () =>
      api
        .get<{ data: SavedSearch[] }>('/global-search/saved')
        .then((r) => (Array.isArray(r.data.data) ? r.data.data : [])),
    enabled,
    retry: false,
    staleTime: 60_000
  })
  return { saved: q.data ?? [], available: q.isSuccess }
}

export function useSaveSearch(onDone?: (s: SavedSearch | null) => void) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (b: { name: string; q: string; scope: string | null }) =>
      api
        .post<{ data: SavedSearch | SavedSearch[] }>('/global-search/saved', b)
        .then((r) => r.data.data),
    onSuccess: (d, b) => {
      toast.success('Search saved', { description: b.name })
      void qc.invalidateQueries({ queryKey: SAVED_KEY })
      onDone?.(Array.isArray(d) ? null : (d ?? null))
    },
    onError: (e) =>
      toast.error(
        status(e) === 404
          ? 'Saved searches are not available on this server yet'
          : userErrorMessage(e, 'The search could not be saved')
      )
  })
}

export function useDeleteSavedSearch() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/global-search/saved/${encodeURIComponent(id)}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: SAVED_KEY }),
    onError: (e) => toast.error(userErrorMessage(e, 'The saved search could not be removed'))
  })
}

/** Learned ranking (#6). Sent WITHOUT log_id: the palette logs the open on
 *  /search-analytics itself, so the click must not log it a second time. */
export function sendSearchClick(b: {
  q: string
  collection: string
  id: string | number
  position: number
}) {
  void api.post('/global-search/click', { ...b, id: String(b.id) }).catch(() => {})
}

/** Run a search command (#19) through its normal route. Resolves to the text of a
 *  refusal the route answered with 2xx (bulk-action errors), else null. */
export async function runSearchCommand(
  cmd: SearchCommand,
  note: string,
  navigate: (path: string) => void
): Promise<string | null> {
  const req = commandRequest(cmd, note)
  if (!req) throw new Error('This command cannot be run from search')
  if (req.kind === 'navigate') {
    navigate(req.path)
    return null
  }
  const res = await api.post<{
    data?: { succeeded?: number; skipped?: number; errors?: Array<{ error: string }> }
  }>(req.url, req.body)
  const d = res.data?.data
  if (d?.errors?.length) return d.errors[0].error
  if (d && !d.succeeded && d.skipped) return 'Nothing to change on this record'
  return null
}
