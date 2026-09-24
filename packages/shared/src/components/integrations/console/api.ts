import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient
} from '@tanstack/react-query'
import { useNivaroClient } from '../../../context'
import { del, get, post } from '../../../lib/commands'
import type {
  ActionResult,
  EventProvider,
  EventStatus,
  IntegrationEvent,
  PartnerCard,
  PartnerDetailData,
  PartnersSummary,
  RowView,
  SignalsSnapshot
} from './types'

export function useSignals(tab?: string) {
  const client = useNivaroClient()
  return useQuery({
    queryKey: ['integration-signals', tab ?? 'all'],
    queryFn: () =>
      client
        .request<{ data: SignalsSnapshot }>(
          get(`/integration-signals${tab ? `?tab=${encodeURIComponent(tab)}` : ''}`)
        )
        .then((r) => r.data),
    refetchInterval: 60_000
  })
}

export function useRefreshSignals() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => client.request(post('/integration-signals/refresh')),
    onSettled: () => qc.invalidateQueries({ queryKey: ['integration-signals'] })
  })
}

export function useSignalAction() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (b: { signal: string; row_keys: string[]; action: RowView['actions'][number] }) =>
      client
        .request<{ data: ActionResult[] }>(post('/integration-signals/actions', b))
        .then((r) => r.data),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['integration-signals'] })
      void qc.invalidateQueries({ queryKey: ['erp-submissions'] })
    }
  })
}

export interface SnoozeInput {
  signal: string
  row_key?: string
  group_key?: string
  until?: string | null
  until_change?: boolean
  note?: string
}

export function useSnooze() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return {
    add: useMutation({
      mutationFn: (b: SnoozeInput) => client.request(post('/integration-signals/snoozes', b)),
      onSettled: () => qc.invalidateQueries({ queryKey: ['integration-signals'] })
    }),
    remove: useMutation({
      mutationFn: (id: number) => client.request(del(`/integration-signals/snoozes/${id}`)),
      onSettled: () => qc.invalidateQueries({ queryKey: ['integration-signals'] })
    })
  }
}

export function usePartners() {
  const client = useNivaroClient()
  return useQuery({
    queryKey: ['integration-partners'],
    queryFn: () =>
      client
        .request<{ data: { summary: PartnersSummary; partners: PartnerCard[] } }>(
          get('/integration-partners')
        )
        .then((r) => r.data),
    refetchInterval: 60_000
  })
}

export function usePartner(id: number | null) {
  const client = useNivaroClient()
  return useQuery({
    queryKey: ['integration-partner', id],
    enabled: id != null,
    queryFn: () =>
      client
        .request<{ data: PartnerDetailData }>(get(`/integration-partners/${id}`))
        .then((r) => r.data)
  })
}

/** Entries per page of the events feed. */
export const EVENTS_PAGE = 50

/**
 * The integration events feed, newest first, paged backwards with a `before`
 * cursor (the oldest entry already shown). A page shorter than EVENTS_PAGE is
 * the end of what the sources keep.
 */
export function useIntegrationEvents(filters: { provider: string; status: EventStatus | '' }) {
  const client = useNivaroClient()
  return useInfiniteQuery({
    queryKey: ['integration-events', filters.provider, filters.status],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(EVENTS_PAGE) })
      if (filters.provider) params.set('provider', filters.provider)
      if (filters.status) params.set('status', filters.status)
      if (pageParam) params.set('before', pageParam)
      return client
        .request<{ data: { providers: EventProvider[]; entries: IntegrationEvent[] } }>(
          get(`/integration-events?${params.toString()}`)
        )
        .then((r) => r.data)
    },
    getNextPageParam: (last) =>
      last.entries.length < EVENTS_PAGE ? null : last.entries[last.entries.length - 1].created_at,
    // A filter change keeps the old list on screen (dimmed) instead of
    // collapsing to skeletons.
    placeholderData: keepPreviousData,
    refetchInterval: 60_000
  })
}

export function useReplayEvent() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (e: IntegrationEvent) =>
      client
        .request<{ data: { replayed: boolean; detail?: string } }>(
          post(`/integration-events/${encodeURIComponent(e.provider)}/replay`, {
            entry_id: String(e.id)
          })
        )
        .then((r) => r.data),
    onSettled: () => qc.invalidateQueries({ queryKey: ['integration-events'] })
  })
}

/** One query key with the Import Console's staleness control — edits in either refresh both. */
export { useImportHealth } from '../../imports/ImportStalenessControl'
