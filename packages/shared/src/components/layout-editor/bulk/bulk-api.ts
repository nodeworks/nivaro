import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useNivaroClient } from '../../../context'
import { get, post } from '../../../lib/commands'
import type { MacroStep } from './macro-record'

// One change on many layouts (#2639 / #2662 / #2663): the client side of
// api/src/routes/layout-bulk.ts. The server plans and applies every form; the
// client only says what to do.

export type BulkFlag = 'required' | 'readonly' | 'hidden'

export type BulkChange =
  | { type: 'place_after' | 'place_before'; field: string; anchor: string }
  | { type: 'set_width'; field: string; width: number }
  | { type: 'set_flag'; field: string; flag: BulkFlag; on: boolean }
  | { type: 'remove'; field: string }

export type BulkAction =
  | { kind: 'retire'; field: string }
  | { kind: 'change'; change: BulkChange }
  | { kind: 'macro'; name: string; steps: MacroStep[] }

export interface FormPreview {
  layout_id: number
  name: string
  layout_type: string
  rev: string
  status: 'change' | 'same' | 'skip'
  reason: string | null
  changes: string[]
  notes: string[]
  ops_count: number
}

export interface BulkPreview {
  label: string
  forms: FormPreview[]
  values: { populated: number | null; total: number | null; note: string | null } | null
}

export interface AppliedForm {
  layout_id: number
  name: string
  status: 'applied' | 'same' | 'skipped' | 'failed'
  reason: string | null
  version_id: number | null
  rev: string | null
}

export interface BulkResult {
  label: string
  forms: AppliedForm[]
}

export interface LayoutMacro {
  id: string
  name: string
  collection: string
  steps: MacroStep[]
  created_at: string
  source_layout_id: number | null
}

export const bulkKeys = {
  fields: (collection: string) => ['layout-editor', 'bulk-fields', collection] as const,
  macros: () => ['layout-editor', 'macros'] as const
}

const dataOf = <T>(res: unknown): T => (res as { data: T }).data

/** Fields placed on the collection's forms, with how many forms hold each. */
export function usePlacedFields(collection: string, enabled = true) {
  const client = useNivaroClient()
  return useQuery<Array<{ field: string; forms: number }>>({
    queryKey: bulkKeys.fields(collection),
    queryFn: async () =>
      dataOf(await client.request(get('/collection-layouts/bulk/fields', { collection }))) ?? [],
    enabled,
    staleTime: 15_000
  })
}

export function useMacros(enabled = true) {
  const client = useNivaroClient()
  return useQuery<LayoutMacro[]>({
    queryKey: bulkKeys.macros(),
    queryFn: async () =>
      dataOf<LayoutMacro[]>(await client.request(get('/collection-layouts/macros'))) ?? [],
    enabled,
    staleTime: 30_000
  })
}

export interface BulkBody {
  collection: string
  action: BulkAction
  labels: Record<string, string>
  layout_ids?: number[]
}

/** Preview / apply / undo, plus saving macros — all keep the macros list fresh. */
export function useBulkCalls() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const preview = useCallback(
    async (body: BulkBody) =>
      dataOf<BulkPreview>(await client.request(post('/collection-layouts/bulk/preview', body))),
    [client]
  )
  const apply = useCallback(
    async (body: BulkBody & { revs: Record<string, string> }) =>
      dataOf<BulkResult>(await client.request(post('/collection-layouts/bulk/apply', body))),
    [client]
  )
  const undo = useCallback(
    async (collection: string, forms: AppliedForm[]) =>
      dataOf<{ forms: Array<{ layout_id: number; status: string; reason: string | null }> }>(
        await client.request(
          post('/collection-layouts/bulk/undo', {
            collection,
            items: forms
              .filter((f) => f.status === 'applied' && f.version_id != null && f.rev)
              .map((f) => ({ layout_id: f.layout_id, version_id: f.version_id, rev: f.rev }))
          })
        )
      ),
    [client]
  )
  const saveMacro = useCallback(
    async (
      macro: Partial<LayoutMacro> & { name: string; collection: string; steps: MacroStep[] }
    ) => {
      const saved = dataOf<LayoutMacro>(
        await client.request(post('/collection-layouts/macros', macro))
      )
      await qc.invalidateQueries({ queryKey: bulkKeys.macros() })
      return saved
    },
    [client, qc]
  )
  const deleteMacro = useCallback(
    async (id: string) => {
      await client.request(post(`/collection-layouts/macros/${encodeURIComponent(id)}/delete`))
      await qc.invalidateQueries({ queryKey: bulkKeys.macros() })
    },
    [client, qc]
  )
  return { preview, apply, undo, saveMacro, deleteMacro }
}
