import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useNivaroClient } from '../../../context'
import { get, patch } from '../../../lib/commands'
import { previewKeys } from '../preview/preview-api'
import type { MatrixRole } from './role-matrix'
import type { RequirementChange } from './state-matrix'

export const matrixKeys = {
  roles: () => ['layout-editor', 'matrix-roles'] as const
}

/** Every role, with whether it is an administrator role (exempt from section rules). */
export function useMatrixRoles(enabled = true) {
  const client = useNivaroClient()
  return useQuery<MatrixRole[]>({
    queryKey: matrixKeys.roles(),
    queryFn: () =>
      client
        .request<{ data: Array<{ id: unknown; name: unknown; admin_access?: unknown }> }>(
          get('/roles')
        )
        .then((r) =>
          (Array.isArray(r?.data) ? r.data : []).map((x) => ({
            id: String(x.id),
            name: String(x.name ?? x.id),
            admin_access: !!x.admin_access
          }))
        ),
    enabled,
    staleTime: 5 * 60_000
  })
}

/**
 * Save requirement edits to the pipeline (PATCH /pipelines/transitions/:id,
 * admin), then refresh what reads the pipelines. `undo` puts back `before`.
 */
export function useSaveRequirements(collection: string) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useCallback(
    async (changes: RequirementChange[], side: 'after' | 'before' = 'after') => {
      try {
        for (const c of changes)
          await client.request(
            patch(`/pipelines/transitions/${encodeURIComponent(c.transitionId)}`, {
              requirements: c[side]
            })
          )
      } finally {
        void qc.invalidateQueries({ queryKey: previewKeys.pipelines(collection) })
        void qc.invalidateQueries({ queryKey: ['pipeline-detail-lock'] })
      }
    },
    [client, qc, collection]
  )
}
