import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import type { ColumnFact } from './width-fit'

// The layout inspector's reads (/layout-inspect, admin-only): column types and
// sizes, stored value lengths, fields on the collection's other forms,
// placements that point at nothing and missing translations.

export const inspectKeys = {
  columns: (c: string) => ['layout-editor', 'inspect', 'columns', c] as const,
  lengths: (c: string, f: string) => ['layout-editor', 'inspect', 'lengths', c, f] as const,
  formFields: (c: string) => ['layout-editor', 'inspect', 'form-fields', c] as const,
  orphans: (c: string) => ['layout-editor', 'inspect', 'orphans', c] as const,
  translations: (c: string) => ['layout-editor', 'inspect', 'translations', c] as const
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** The collection's columns by name (case as stored). */
export function useColumnFacts(collection: string | null | undefined) {
  const client = useNivaroClient()
  return useQuery<Record<string, ColumnFact>>({
    queryKey: inspectKeys.columns(collection ?? ''),
    queryFn: () =>
      client
        .request<{ data: unknown }>(get(`/layout-inspect/${collection}/columns`))
        .then((r) => (isObj(r.data) ? (r.data as Record<string, ColumnFact>) : {})),
    enabled: !!collection,
    staleTime: 5 * 60_000,
    retry: false
  })
}

/** The column for `field`, matched without regard to case. */
export function columnOf(
  facts: Record<string, ColumnFact> | undefined,
  field: string
): ColumnFact | null {
  if (!facts) return null
  if (facts[field]) return facts[field]
  const k = Object.keys(facts).find((c) => c.toLowerCase() === field.toLowerCase())
  return k ? facts[k] : null
}

export interface LengthStats {
  field: string
  sampled: number
  filled: number
  p50: number
  p95: number
  max: number
  capped: boolean
}

/** Stored value lengths — only once asked (`run`), then kept for the session. */
export function useValueLengths(collection: string, field: string, run: boolean) {
  const client = useNivaroClient()
  return useQuery<LengthStats | null>({
    queryKey: inspectKeys.lengths(collection, field),
    queryFn: () =>
      client
        .request<{ data: unknown }>(get(`/layout-inspect/${collection}/value-lengths`, { field }))
        .then((r) => (isObj(r.data) ? (r.data as unknown as LengthStats) : null)),
    enabled: run && !!collection && !!field,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false
  })
}

export interface FormFields {
  layout_id: number
  name: string
  layout_type: string
  fields: string[]
}

export function useFormFields(collection: string) {
  const client = useNivaroClient()
  return useQuery<FormFields[]>({
    queryKey: inspectKeys.formFields(collection),
    queryFn: () =>
      client
        .request<{ data: unknown }>(get(`/layout-inspect/${collection}/form-fields`))
        .then((r) => (Array.isArray(r.data) ? (r.data as FormFields[]) : [])),
    enabled: !!collection,
    staleTime: 60_000,
    retry: false
  })
}

export interface OrphanLayout {
  layout_id: number
  name: string
  layout_type: string
  placements: Array<{
    field: string
    group_key: string | null
    reason: 'column_dropped' | 'widget_deleted' | 'grid_missing' | 'section_missing'
  }>
}

export function useOrphans(collection: string) {
  const client = useNivaroClient()
  return useQuery<OrphanLayout[]>({
    queryKey: inspectKeys.orphans(collection),
    queryFn: () =>
      client
        .request<{ data: unknown }>(get(`/layout-inspect/${collection}/orphans`))
        .then((r) => (Array.isArray(r.data) ? (r.data as OrphanLayout[]) : [])),
    enabled: !!collection,
    staleTime: 60_000,
    retry: false
  })
}

export interface TranslationSummary {
  base: string
  locales: string[]
  groups_supported: boolean
  layouts: Array<{
    layout_id: number
    name: string
    layout_type: string
    missing: number
    total: number
  }>
}

export function useTranslationSummary(collection: string) {
  const client = useNivaroClient()
  return useQuery<TranslationSummary | null>({
    queryKey: inspectKeys.translations(collection),
    queryFn: () =>
      client
        .request<{ data: unknown }>(get(`/layout-inspect/${collection}/translations`))
        .then((r) =>
          isObj(r.data) && Array.isArray((r.data as { locales?: unknown }).locales)
            ? (r.data as unknown as TranslationSummary)
            : null
        ),
    enabled: !!collection,
    staleTime: 60_000,
    retry: false
  })
}
