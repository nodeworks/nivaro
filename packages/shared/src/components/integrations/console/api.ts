import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient
} from '@tanstack/react-query'
import { useNivaroClient } from '../../../context'
import { del, get, patch, post } from '../../../lib/commands'
import { IMPORT_HEALTH_KEY } from '../../imports/ImportStalenessControl'
import type {
  ActionResult,
  AlertMode,
  AlertSubscription,
  EventProvider,
  EventStatus,
  IntegrationEvent,
  PartnerCallDetail,
  PartnerCard,
  PartnerDetailData,
  PartnersSummary,
  RowView,
  SignalSettingsEntry,
  SignalsSnapshot,
  SubmissionAttempt,
  SubmissionDetail
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
      void qc.invalidateQueries({ queryKey: ['erp-submission-attempts'] })
    }
  })
}

/** One push in full — the Firefight drill-down's data (admin-only route). */
export function useSubmissionDetail(id: number | null) {
  const client = useNivaroClient()
  return useQuery({
    // Under 'erp-submissions' so every existing retry invalidation refreshes it.
    queryKey: ['erp-submissions', 'detail', id],
    enabled: id != null,
    queryFn: () =>
      client.request<{ data: SubmissionDetail }>(get(`/erp-submissions/${id}`)).then((r) => r.data),
    staleTime: 15_000
  })
}

/** Every attempt of one submission, newest first — the key the External
 *  requests dialog and the partner detail already share. */
export function useSubmissionAttempts(id: number | null) {
  const client = useNivaroClient()
  return useQuery({
    queryKey: ['erp-submission-attempts', id],
    enabled: id != null,
    queryFn: () =>
      client
        .request<{ data: { attempts: SubmissionAttempt[]; total: number; unrecorded: number } }>(
          get(`/erp-submissions/${id}/attempts`)
        )
        .then((r) => r.data),
    staleTime: 15_000
  })
}

/** Re-send one stored push (the same route the record's External requests
 *  dialog uses) — for a drill shown outside a Firefight row. */
export function useRetrySubmission() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => client.request(post(`/erp-submissions/${id}/retry`)),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['integration-signals'] })
      void qc.invalidateQueries({ queryKey: ['erp-submissions'] })
      void qc.invalidateQueries({ queryKey: ['erp-submission-attempts'] })
    }
  })
}

export interface SnoozeInput {
  signal: string
  row_key?: string
  group_key?: string
  until?: string | null
  until_change?: boolean
  /** A Dismiss — hides this ONE row until its occurrence changes. Row-scoped
   *  only; never combine with group_key. */
  until_occurrence?: boolean
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

/** "Dismiss selected" — one Dismiss per selected row in a single request. */
export function useDismissRows() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (b: { signal: string; row_keys: string[] }) =>
      client
        .request<{ data: { dismissed: number; skipped: string[] } }>(
          post('/integration-signals/dismiss', b)
        )
        .then((r) => r.data),
    onSettled: () => qc.invalidateQueries({ queryKey: ['integration-signals'] })
  })
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

/** One call's full request/response — fetched only on expand (a row list
 *  never carries bodies), and only for a call-log-backed row: `enabled`
 *  should gate on `source === 'log'`, since an outbound-only row has nothing
 *  under this id in the table this route reads. */
export function useCallDetail(apiId: number, callId: number | null) {
  const client = useNivaroClient()
  return useQuery({
    queryKey: ['integration-partner-call', apiId, callId],
    enabled: callId != null,
    queryFn: () =>
      client
        .request<{ data: PartnerCallDetail }>(get(`/integration-partners/${apiId}/calls/${callId}`))
        .then((r) => r.data),
    staleTime: 15_000
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

// ── Alerts tab: subscriptions + threshold settings ─────────────────────────

export const SIGNAL_SETTINGS_KEY = ['integration-signal-settings'] as const
export const ALERT_SUBSCRIPTIONS_KEY = ['integration-signal-subscriptions'] as const

export function useSignalSettings() {
  const client = useNivaroClient()
  return useQuery({
    queryKey: SIGNAL_SETTINGS_KEY,
    queryFn: () =>
      client
        .request<{ data: SignalSettingsEntry[] }>(get('/integration-signals/settings'))
        .then((r) => r.data)
  })
}

/** Save one signal's settings — a threshold set to null goes back to its default. */
export function useSaveSignalSettings() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (b: { signal: string; values: Record<string, number | string | boolean | null> }) =>
      client.request(
        patch(`/integration-signals/settings/${encodeURIComponent(b.signal)}`, b.values)
      ),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: SIGNAL_SETTINGS_KEY })
      void qc.invalidateQueries({ queryKey: ['integration-signals'] })
      // The stale-import signal's default cadence is the Inbound table's too.
      void qc.invalidateQueries({ queryKey: IMPORT_HEALTH_KEY })
    }
  })
}

/**
 * "Would currently flag N" for proposed thresholds — evaluates the one
 * signal server-side with the draft values (nothing is written). `values`
 * null = don't ask (editor closed or the draft is invalid).
 */
export function useSignalPreview(signal: string, values: Record<string, number> | null) {
  const client = useNivaroClient()
  return useQuery({
    queryKey: ['integration-signal-preview', signal, values],
    queryFn: () =>
      client
        .request<{ data: { count: number | null; error: string | null } }>(
          get(`/integration-signals/settings/${encodeURIComponent(signal)}/preview`, values ?? {})
        )
        .then((r) => r.data),
    enabled: values != null,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false
  })
}

export function useAlertSubscriptions() {
  const client = useNivaroClient()
  return useQuery({
    queryKey: ALERT_SUBSCRIPTIONS_KEY,
    queryFn: () =>
      client
        .request<{ data: AlertSubscription[] }>(get('/integration-signals/subscriptions'))
        .then((r) => r.data)
  })
}

/** Turn one (signal, mode) alert on or off — on = POST, off = DELETE by id. */
export function useToggleSubscription() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (b: { signal: string; mode: AlertMode; on: boolean; id?: number }) => {
      if (b.on) {
        await client.request(
          post('/integration-signals/subscriptions', { signal: b.signal, mode: b.mode })
        )
      } else if (b.id != null) {
        await client.request(del(`/integration-signals/subscriptions/${b.id}`))
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ALERT_SUBSCRIPTIONS_KEY })
  })
}
