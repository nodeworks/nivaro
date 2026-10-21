import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useNivaroClient } from '../../../context'
import { get, post } from '../../../lib/commands'
import type { LayoutBundle, LayoutOp } from '../../../lib/layout-ops'
import { overviewKeys } from '../overview/overview-api'
import { layoutDraftKeys, parseBundle } from '../useLayoutDraft'

/**
 * Shapes of GET /collection-layouts/crossform and /field-search
 * (api/src/services/layout-crossform.ts). Keep the two in step.
 */

export interface LabelVariant {
  label: string
  layouts: Array<{ id: number; name: string }>
}

export interface LabelFinding {
  field: string
  field_label: string
  variants: LabelVariant[]
}

export interface DuplicatePair {
  a: { id: number; name: string }
  b: { id: number; name: string }
  similarity: number
  identical: number
  only_a: number
  only_b: number
  differing: number
  parent_id: number
  can_link: boolean
}

export type ThumbBlockKind = 'section' | 'tabs' | 'steps' | 'slot' | 'text'

export interface ThumbBlock {
  kind: ThumbBlockKind
  label: string
  count?: number
  rows: number[][]
  clipped?: number
}

export interface LayoutThumbData {
  blocks: ThumbBlock[]
  more: number
}

export interface CrossformResponse {
  thumbs: Record<string, LayoutThumbData>
  labels: LabelFinding[]
  duplicates: DuplicatePair[]
}

export interface FieldPlacementHit {
  layout_id: number
  layout_name: string
  layout_type: string
  section: string | null
  width: number
  visible: boolean
  label: string | null
  label_hidden: boolean
  inherited_from: string | null
}

export interface FieldSearchHit {
  collection: string
  field: string
  label: string
  placements: FieldPlacementHit[]
}

export interface FieldSearchResponse {
  fields: FieldSearchHit[]
  truncated: boolean
}

const EMPTY: CrossformResponse = { thumbs: {}, labels: [], duplicates: [] }

/** Under the overview's key: every layout write that refreshes the overview refreshes this. */
export const crossformKeys = {
  crossform: (collection: string) => [...overviewKeys.overview(collection), 'crossform'] as const,
  fieldSearch: (q: string, collection: string | null) =>
    ['layout-editor', 'field-search', collection ?? '*', q.toLowerCase()] as const
}

function unwrap<T>(res: unknown, has: string): T | null {
  if (!res || typeof res !== 'object') return null
  if (has in (res as object)) return res as T
  const data = (res as { data?: unknown }).data
  return data && typeof data === 'object' ? (data as T) : null
}

export function useCrossform(collection: string, enabled = true) {
  const client = useNivaroClient()
  return useQuery<CrossformResponse>({
    queryKey: crossformKeys.crossform(collection),
    queryFn: async () => {
      const res = await client.request<unknown>(
        get('/collection-layouts/crossform', { collection })
      )
      const body = unwrap<CrossformResponse>(res, 'thumbs')
      return {
        thumbs: body?.thumbs ?? EMPTY.thumbs,
        labels: body?.labels ?? EMPTY.labels,
        duplicates: body?.duplicates ?? EMPTY.duplicates
      }
    },
    enabled,
    staleTime: 30_000,
    retry: false
  })
}

export function useFieldSearch(q: string, collection: string | null = null) {
  const client = useNivaroClient()
  const query = q.trim()
  return useQuery<FieldSearchResponse>({
    queryKey: crossformKeys.fieldSearch(query, collection),
    queryFn: async () => {
      const res = await client.request<unknown>(
        get('/collection-layouts/field-search', {
          q: query,
          ...(collection ? { collection } : {})
        })
      )
      const body = unwrap<FieldSearchResponse>(res, 'fields')
      return { fields: body?.fields ?? [], truncated: !!body?.truncated }
    },
    enabled: query.length >= 2,
    staleTime: 30_000,
    retry: false
  })
}

function isStale(err: unknown): LayoutBundle | null {
  const e = err as { status?: number; response?: { status?: number; data?: unknown } }
  const status = e?.status ?? e?.response?.status
  if (status !== 409) return null
  const body = (e?.response?.data ?? e?.response) as { bundle?: unknown } | undefined
  return parseBundle(body?.bundle ?? null)
}

/**
 * Apply ops to a layout that is not open in this editor: read its bundle, build
 * the ops from it, post them as one batch (one History entry). Someone saving
 * in between answers 409 with the fresh bundle: build again from it, once.
 * `build` returning no ops = nothing to change.
 */
export async function applyToLayout(
  client: ReturnType<typeof useNivaroClient>,
  layoutId: number,
  build: (bundle: LayoutBundle) => LayoutOp[],
  note: string
): Promise<LayoutBundle | null> {
  let bundle = parseBundle(
    await client.request<unknown>(get(`/collection-layouts/${layoutId}/bundle`))
  )
  if (!bundle) throw new Error('The layout could not be read')
  for (let attempt = 0; attempt < 2; attempt++) {
    const ops = build(bundle)
    if (!ops.length) return null
    try {
      return parseBundle(
        await client.request<unknown>(
          post(`/collection-layouts/${layoutId}/ops`, { ops, base_rev: bundle.rev, note })
        )
      )
    } catch (err) {
      const fresh = isStale(err)
      if (!fresh || attempt > 0) throw err
      bundle = fresh
    }
  }
  return null
}

/** After writes to other layouts: the overview, the across-forms read and their bundles. */
export function useInvalidateAfterCrossWrite(collection: string) {
  const qc = useQueryClient()
  return useCallback(
    (layoutIds: number[]) => {
      for (const id of layoutIds)
        void qc.invalidateQueries({ queryKey: layoutDraftKeys.bundle(id) })
      void qc.invalidateQueries({ queryKey: overviewKeys.overview(collection) })
      void qc.invalidateQueries({ queryKey: ['collection-layouts', collection] })
      void qc.invalidateQueries({ queryKey: ['active-layout', collection] })
    },
    [qc, collection]
  )
}
