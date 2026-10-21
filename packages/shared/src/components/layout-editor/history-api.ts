import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import type { LayoutBundle, LayoutOp } from '../../lib/layout-ops'
import type { LastChange } from './design-context'
import { layoutDraftKeys, parseBundle } from './useLayoutDraft'

// Layout history beyond undo: named versions (#2610), a version as a bundle for
// "Show on canvas" (#2591), who last changed each section (#2611) and scheduled
// changes (#2590). Routes: api/src/routes/layout-history.ts.

export const historyKeys = {
  // Under the versions key: every save (which refreshes versions) refreshes these too.
  sectionChanges: (layoutId: number) =>
    [...layoutDraftKeys.versions(layoutId), 'section-changes'] as const,
  schedules: (collection: string) => ['layout-editor', 'schedules', collection] as const
}

export interface ScheduleRow {
  id: number
  layout_id: number
  layout_name: string | null
  collection: string
  note: string | null
  run_at: string
  status: 'pending' | 'running' | 'applied' | 'failed' | 'cancelled'
  error: string | null
  op_count: number
  created_by: string | null
  created_by_name: string | null
  created_at: string | null
  updated_by_name: string | null
  applied_at: string | null
}

/** A version's snapshot as the editor's bundle. */
export async function fetchVersionBundle(
  client: ReturnType<typeof useNivaroClient>,
  layoutId: number,
  versionId: number
): Promise<LayoutBundle> {
  const res = await client.request<{ data?: { bundle?: unknown } }>(
    get(`/collection-layouts/${layoutId}/versions/${versionId}/bundle`)
  )
  const bundle = parseBundle(res?.data?.bundle)
  if (!bundle) throw new Error('That version could not be read')
  return bundle
}

/** { [section key]: who + when } — only fetched while the editor shows it. */
export function useSectionChanges(layoutId: number, enabled: boolean) {
  const client = useNivaroClient()
  return useQuery<Record<string, LastChange>>({
    queryKey: historyKeys.sectionChanges(layoutId),
    queryFn: () =>
      client
        .request<{ data?: Record<string, LastChange> }>(
          get(`/collection-layouts/${layoutId}/section-changes`)
        )
        .then((r) => r?.data ?? {}),
    enabled,
    staleTime: 60_000
  })
}

export function useLayoutSchedules(collection: string, enabled = true) {
  const client = useNivaroClient()
  return useQuery<ScheduleRow[]>({
    queryKey: historyKeys.schedules(collection),
    queryFn: () =>
      client
        .request<{ data?: ScheduleRow[] }>(get('/collection-layouts/schedules', { collection }))
        .then((r) => r?.data ?? []),
    enabled,
    staleTime: 30_000
  })
}

export function useScheduleActions(collection: string) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: historyKeys.schedules(collection) })
  const create = useMutation({
    mutationFn: (v: {
      layoutId: number
      ops: LayoutOp[]
      base_rev: string
      run_at: string
      note?: string
    }) =>
      client.request<{ data: ScheduleRow }>(
        post(`/collection-layouts/${v.layoutId}/schedules`, {
          ops: v.ops,
          base_rev: v.base_rev,
          run_at: v.run_at,
          note: v.note || undefined
        })
      ),
    onSuccess: refresh
  })
  const cancel = useMutation({
    mutationFn: (id: number) => client.request(del(`/collection-layouts/schedules/${id}`)),
    onSettled: refresh
  })
  const reschedule = useMutation({
    mutationFn: (v: { id: number; run_at: string }) =>
      client.request(patch(`/collection-layouts/schedules/${v.id}`, { run_at: v.run_at })),
    onSettled: refresh
  })
  return { create, cancel, reschedule }
}

export function useVersionNaming(layoutId: number) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: layoutDraftKeys.versions(layoutId) })
  const nameVersion = useMutation({
    mutationFn: (v: { versionId: number; name: string | null }) =>
      client.request(
        patch(`/collection-layouts/${layoutId}/versions/${v.versionId}`, { name: v.name })
      ),
    onSuccess: refresh
  })
  const nameCurrent = useMutation({
    mutationFn: (name: string) =>
      client.request(post(`/collection-layouts/${layoutId}/versions/name`, { name })),
    onSuccess: refresh
  })
  return { nameVersion, nameCurrent }
}

/** `datetime-local` value (local time) ↔ ISO. */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export function fromLocalInput(v: string): string | null {
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
