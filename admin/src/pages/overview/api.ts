import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import type { StoredLayout } from './layout'
import type { SinceDigestInput } from './text'

/**
 * The Overview's reads and writes (routes in api/src/routes/overview.ts). Every key is
 * namespaced under 'overview' except My Work, which shares the My Work page's cache (same shape).
 */

export type FigureKey = 'records_changed' | 'people_active' | 'failed_jobs' | 'open_issues'

export interface OverviewFigure {
  key: FigureKey
  value: number
  previous: number | null
  compare: 'yesterday' | 'previous_24h'
  capped?: boolean
}

export interface OverviewStats {
  figures: OverviewFigure[]
  hourly: number[]
  day_start: string
  scope: 'all' | 'readable'
  computed_at: string
}

export interface OverviewPrefs {
  layout: StoredLayout | null
  role_default: StoredLayout | null
  pinned_actions: Array<{ path: string; label: string }>
  dismissed_actions: string[]
  pinned_widgets: string[]
  last_visit_at: string | null
  prev_visit_at: string | null
}

export interface SinceDigest extends SinceDigestInput {
  my_records: Array<{ collection: string; item: string; changes: number; last_at: string }>
  people: Array<{ id: string; name: string }>
}

export const overviewKeys = {
  prefs: ['overview', 'prefs'] as const,
  stats: (dayStart: string) => ['overview', 'stats', dayStart] as const,
  since: ['overview', 'since'] as const,
  usage: ['overview', 'usage'] as const,
  pinnedWidgets: ['overview', 'pinned-widgets'] as const,
  recent: ['overview', 'recent-records'] as const,
  activity: (scope: string) => ['overview', 'activity', scope] as const,
  roleDefaults: ['overview', 'role-defaults'] as const
}

/** The viewer's local midnight, as an instant (the server compares "today" from it). */
export function localDayStart(now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
}

export function useOverviewPrefs() {
  return useQuery({
    queryKey: overviewKeys.prefs,
    queryFn: () => api.get<{ data: OverviewPrefs }>('/overview/prefs').then((r) => r.data.data),
    staleTime: 60_000
  })
}

type PrefsPatch = Partial<
  Pick<OverviewPrefs, 'layout' | 'pinned_actions' | 'dismissed_actions' | 'pinned_widgets'>
>

/** Optimistic: the page shows the change at once; a refused write puts the old value back. */
export function useUpdateOverviewPrefs() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: PrefsPatch) =>
      api.put<{ data: OverviewPrefs }>('/overview/prefs', patch).then((r) => r.data.data),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: overviewKeys.prefs })
      const before = qc.getQueryData<OverviewPrefs>(overviewKeys.prefs)
      if (before) qc.setQueryData(overviewKeys.prefs, { ...before, ...patch })
      return { before }
    },
    onError: (_e, _p, ctx) => {
      if (ctx?.before) qc.setQueryData(overviewKeys.prefs, ctx.before)
      toast.error('Could not save that change to your Overview. Try again.')
    },
    onSuccess: (data, patch) => {
      const now = qc.getQueryData<OverviewPrefs>(overviewKeys.prefs)
      qc.setQueryData(overviewKeys.prefs, { ...(now ?? data), ...data })
      if ('pinned_widgets' in patch)
        void qc.invalidateQueries({ queryKey: overviewKeys.pinnedWidgets })
    }
  })
}

/** For a dashboard widget's pin: is it on Overview, and flip it. */
export function usePinToOverview() {
  const prefs = useOverviewPrefs()
  const update = useUpdateOverviewPrefs()
  const ids = prefs.data?.pinned_widgets ?? []
  return {
    ready: !!prefs.data,
    isPinned: (widgetId: string) => ids.includes(String(widgetId)),
    toggle: (widgetId: string) => {
      const id = String(widgetId)
      const pinned = ids.includes(id)
      if (!pinned && ids.length >= 8) {
        toast.error('Overview holds 8 pinned widgets. Unpin one first.')
        return
      }
      update.mutate(
        { pinned_widgets: pinned ? ids.filter((x) => x !== id) : [...ids, id] },
        {
          onSuccess: () =>
            toast.success(pinned ? 'Removed from your Overview' : 'Pinned to your Overview')
        }
      )
    }
  }
}

export function useOverviewStats(dayStart: string, refetchInterval: number | false) {
  return useQuery({
    queryKey: overviewKeys.stats(dayStart),
    queryFn: () =>
      api
        .get<{ data: OverviewStats }>('/overview/stats', { params: { day_start: dayStart } })
        .then((r) => r.data.data),
    staleTime: 20_000,
    refetchInterval,
    placeholderData: (prev) => prev
  })
}

/** Roll the visit watermark once per page open, THEN read the digest against the old baseline. */
export function useSinceDigest() {
  const visit = useQuery({
    queryKey: ['overview', 'visit'],
    queryFn: () =>
      api
        .post<{ data: { prev_visit_at: string | null } }>('/overview/visit')
        .then((r) => r.data.data)
        .catch(() => ({ prev_visit_at: null })),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 60_000,
    retry: false
  })
  const digest = useQuery({
    queryKey: overviewKeys.since,
    queryFn: () =>
      api.get<{ data: SinceDigest | null }>('/overview/since').then((r) => r.data.data),
    enabled: visit.isSuccess && !!visit.data?.prev_visit_at,
    staleTime: 60_000
  })
  return {
    isLoading: visit.isLoading || (digest.isLoading && digest.fetchStatus !== 'idle'),
    firstVisit: visit.isSuccess && !visit.data?.prev_visit_at,
    data: digest.data ?? null,
    error: digest.error
  }
}

export interface MyWorkTask {
  id: number
  title: string | null
  due_date: string | null
  status: string
  priority: string | null
  collection: string | null
  item: string | null
  item_label?: string | null
}

export interface MyWorkData {
  tasks: MyWorkTask[]
  counts: {
    owned: number
    owned_breached: number
    owned_warning: number
    tasks: number
    team_tasks: number
    approvals: number
    notifications: number
    questions: number
  }
}

/** Shares the My Work page's cache (same key, same shape: the `data` object). */
export function useMyWork() {
  return useQuery({
    queryKey: ['my-work'],
    queryFn: () => api.get<{ data: MyWorkData }>('/my-work').then((r) => r.data.data),
    staleTime: 60_000
  })
}

/** "Things that need you": records waiting on you, your tasks, approvals, questions. */
export function needsYouCount(d: MyWorkData | undefined): number | null {
  if (!d) return null
  const c = d.counts
  return (c.owned ?? 0) + (c.tasks ?? 0) + (c.approvals ?? 0) + (c.questions ?? 0)
}
