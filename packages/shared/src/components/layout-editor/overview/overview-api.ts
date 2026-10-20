import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import type { DescribeField } from './describe-conditions'
import type { ExplainResponse, OverviewReference, OverviewResponse } from './types'

export const overviewKeys = {
  overview: (collection: string) => ['layout-editor', 'overview', collection] as const,
  fields: (collection: string) => ['layout-editor', 'fields', collection] as const,
  meta: (collection: string) => ['layout-editor', 'collection-meta', collection] as const,
  roles: () => ['layout-editor', 'roles'] as const
}

/** Routes answer `{ data: … }`; accept a bare body too so a shape slip cannot blank the page. */
function unwrap<T>(res: unknown, has: string): T | null {
  if (!res || typeof res !== 'object') return null
  if (has in (res as object)) return res as T
  const data = (res as { data?: unknown }).data
  return data && typeof data === 'object' ? (data as T) : null
}

export function useLayoutOverview(collection: string) {
  const client = useNivaroClient()
  return useQuery<OverviewResponse>({
    queryKey: overviewKeys.overview(collection),
    queryFn: async () => {
      const res = await client.request<unknown>(get('/collection-layouts/overview', { collection }))
      const body = unwrap<OverviewResponse>(res, 'rows')
      return { rows: body?.rows ?? [], warning: body?.warning ?? null }
    },
    staleTime: 15_000
  })
}

export async function fetchExplain(
  client: ReturnType<typeof useNivaroClient>,
  params: { collection: string; item: string | number; role_id?: string | null }
): Promise<ExplainResponse> {
  const res = await client.request<unknown>(
    get('/collection-layouts/explain', {
      collection: params.collection,
      item: params.item,
      ...(params.role_id ? { role_id: params.role_id } : {})
    })
  )
  const body = unwrap<ExplainResponse>(res, 'checked')
  return {
    layout_id: body?.layout_id ?? null,
    reason: body?.reason ?? null,
    checked: body?.checked ?? []
  }
}

/** The collection's fields — labels and choices for the rule sentences. */
export function useOverviewFields(collection: string) {
  const client = useNivaroClient()
  return useQuery<DescribeField[]>({
    queryKey: overviewKeys.fields(collection),
    queryFn: () =>
      client
        .request<{ data: DescribeField[] }>(get(`/field-config/${collection}`))
        .then((r) => r.data ?? []),
    staleTime: 60_000
  })
}

export function useDisplayTemplate(collection: string, enabled: boolean) {
  const client = useNivaroClient()
  return useQuery<string | null>({
    queryKey: overviewKeys.meta(collection),
    queryFn: () =>
      client
        .request<{ data: { display_template?: string | null } | null }>(
          get(`/collections/${collection}`)
        )
        .then((r) => r.data?.display_template ?? null)
        .catch(() => null),
    enabled,
    staleTime: 5 * 60_000
  })
}

export function useRoleNames(enabled: boolean) {
  const client = useNivaroClient()
  return useQuery<Array<{ id: string; name: string }>>({
    queryKey: overviewKeys.roles(),
    queryFn: () =>
      client
        .request<{ data: Array<{ id: string; name: string }> }>(get('/roles'))
        .then((r) => (r.data ?? []).map((x) => ({ id: String(x.id), name: String(x.name) }))),
    enabled,
    staleTime: 5 * 60_000
  })
}

/** Refresh everything a layout write can change for this collection. */
export function useInvalidateLayouts(collection: string) {
  const qc = useQueryClient()
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: overviewKeys.overview(collection) })
    void qc.invalidateQueries({ queryKey: ['collection-layouts', collection] })
    void qc.invalidateQueries({ queryKey: ['active-layout', collection] })
  }, [qc, collection])
}

export interface ApiFailure {
  status: number | null
  message: string
  references: OverviewReference[]
}

/**
 * The SDK puts the status on `err.status` and the parsed body on `err.response`;
 * the admin's axios-backed client nests them under `response.status` / `response.data`.
 */
export function apiFailure(err: unknown, fallback: string): ApiFailure {
  const e = err as {
    status?: number
    message?: string
    response?: { status?: number; data?: unknown } & Record<string, unknown>
  }
  const status = e?.status ?? e?.response?.status ?? null
  const body = (e?.response?.data ?? e?.response) as
    | { error?: unknown; message?: unknown; references?: unknown }
    | undefined
  const message =
    (typeof body?.error === 'string' && body.error) ||
    (typeof body?.message === 'string' && body.message) ||
    fallback
  const references = Array.isArray(body?.references)
    ? (body.references as OverviewReference[]).filter((r) => r && typeof r.label === 'string')
    : []
  return { status, message, references }
}
