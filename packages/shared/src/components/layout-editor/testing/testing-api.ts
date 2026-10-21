import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useNivaroClient } from '../../../context'
import { useRelationOptions } from '../../../hooks/useRelationOptions'
import { post } from '../../../lib/commands'
import type { LayoutBundle } from '../../../lib/layout-ops'
import type { ActiveLayoutData } from '../../item-edit/types'
import { useDisplayTemplate } from '../overview/overview-api'
import type { RoleAccessInput } from '../preview/preview-model'
import type { FormFieldRow, FormRef, PinnedRecord, WalkAccess } from './testing-model'

// The server half of the editor's checks: POST /collection-layouts/:id/test-records
// and /walkthrough-access (both reads, admin-only), and the draft's per-placement
// field rows (POST /field-config/:c/project — the canvas asks the same).

/** The layout settings that decide which form a record opens on, from the draft. */
export function draftResolution(layout: LayoutBundle['layout'] | null | undefined) {
  if (!layout) return null
  const l = layout as Record<string, unknown>
  return {
    record_conditions: l.record_conditions ?? null,
    conditions: l.conditions ?? null,
    is_active: !!l.is_active,
    sort: l.sort ?? 0,
    layout_type: l.layout_type ?? null
  }
}

export interface CheckPick extends FormRef {
  why: string | null
}

export interface CheckResult {
  item: string
  role_id: string | null
  found: boolean
  role: { id: string; name: string; admin_access: boolean } | null
  role_missing?: boolean
  /** The form it opens on with the stored layouts / with the draft's settings. */
  saved?: CheckPick | null
  draft?: CheckPick | null
  values?: Record<string, unknown>
  access?: RoleAccessInput | null
}

export async function checkTestRecords(
  client: ReturnType<typeof useNivaroClient>,
  layoutId: number,
  body: { records: PinnedRecord[]; draft: unknown; fields: string[] }
): Promise<CheckResult[]> {
  const res = await client.request<{ data?: { results?: CheckResult[] } }>(
    post(`/collection-layouts/${layoutId}/test-records`, body)
  )
  return res?.data?.results ?? []
}

export function useWalkAccess(
  layoutId: number,
  roleId: string | null,
  draft: ReturnType<typeof draftResolution>,
  enabled: boolean
) {
  const client = useNivaroClient()
  return useQuery<WalkAccess>({
    queryKey: ['layout-editor', 'walkthrough-access', layoutId, roleId ?? '', draft],
    queryFn: () =>
      client
        .request<{ data: WalkAccess }>(
          post(`/collection-layouts/${layoutId}/walkthrough-access`, { role_id: roleId, draft })
        )
        .then((r) => r.data),
    enabled,
    staleTime: 30_000
  })
}

/**
 * The draft's placements formatted as the form formats them (required,
 * read-only and hidden after each placement's overrides). Same request and
 * cache key as the canvas's design-mode field config.
 */
export function useFormRows(collection: string, layout: ActiveLayoutData | null, enabled: boolean) {
  const client = useNivaroClient()
  const assignments = layout?.assignments ?? null
  return useQuery<FormFieldRow[]>({
    queryKey: ['layout-editor', 'field-config', collection, assignments],
    queryFn: () =>
      client
        .request<{ data: FormFieldRow[] }>(
          post(`/field-config/${collection}/project`, { assignments })
        )
        .then((r) => r.data ?? []),
    enabled: enabled && assignments != null,
    staleTime: 60_000,
    placeholderData: (prev) => prev
  })
}

/** Display labels for pinned records (the collection's display template). */
export function usePinnedLabels(collection: string, pins: PinnedRecord[], enabled: boolean) {
  const client = useNivaroClient()
  // Keyed by the ids, not the array: callers read pins fresh every render.
  const key = [...new Set(pins.map((p) => p.item))].sort().join('\u0000')
  const ids = useMemo(() => (key ? key.split('\u0000') : []), [key])
  const filter = useMemo(() => ({ id: { _in: ids } }), [ids])
  const { data: template } = useDisplayTemplate(collection, enabled && ids.length > 0)
  const { options } = useRelationOptions(enabled ? client : null, collection, {
    limit: Math.max(ids.length, 1),
    displayTemplate: template ?? null,
    filter,
    enabled: enabled && ids.length > 0 && template !== undefined
  })
  return useMemo(() => {
    const m = new Map<string, string>()
    for (const o of options) m.set(String(o.id), o.label)
    return m
  }, [options])
}
