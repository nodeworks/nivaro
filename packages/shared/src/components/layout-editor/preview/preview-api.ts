import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import type { PipelineTransition, RoleAccessInput } from './preview-model'

export const previewKeys = {
  fieldAccess: (c: string) => ['layout-editor', 'field-access', c] as const,
  pipelines: (c: string) => ['layout-editor', 'preview-pipelines', c] as const
}

/** Every role's field permissions on the collection (admin; #2580 overlay). */
export function useFieldAccess(collection: string, enabled: boolean) {
  const client = useNivaroClient()
  return useQuery<RoleAccessInput[]>({
    queryKey: previewKeys.fieldAccess(collection),
    queryFn: () =>
      client
        .request<{ data: { roles?: RoleAccessInput[] } }>(
          get('/collection-layouts/field-access', { collection })
        )
        .then((r) => r?.data?.roles ?? []),
    enabled,
    staleTime: 60_000
  })
}

export interface PreviewState {
  id: string
  key: string
  label: string
  color?: string | null
}

export interface PreviewPipeline {
  id: string
  name: string
  states: PreviewState[]
  transitions: PipelineTransition[]
}

/** The pipelines bound to the collection, with their states and moves (#2599). */
export function useCollectionPipelines(collection: string, enabled: boolean) {
  const client = useNivaroClient()
  return useQuery<PreviewPipeline[]>({
    queryKey: previewKeys.pipelines(collection),
    queryFn: async () => {
      const list = await client.request<{
        data: Array<{ id: unknown; name: unknown; collections?: unknown }>
      }>(get('/pipelines'))
      const bound = (Array.isArray(list?.data) ? list.data : []).filter(
        (p) => Array.isArray(p.collections) && p.collections.includes(collection)
      )
      return Promise.all(
        bound.map((p) =>
          client
            .request<{
              data: { states?: Array<Record<string, unknown>>; transitions?: PipelineTransition[] }
            }>(get(`/pipelines/${encodeURIComponent(String(p.id))}`))
            .then((r) => ({
              id: String(p.id),
              name: String(p.name),
              states: (r?.data?.states ?? []).map((s) => ({
                id: String(s.id),
                key: String(s.key),
                label: String(s.label ?? s.key),
                color: (s.color as string | null | undefined) ?? null
              })),
              transitions: r?.data?.transitions ?? []
            }))
        )
      )
    },
    enabled,
    staleTime: 5 * 60_000
  })
}
