import { useEffect, useRef } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'

// ─── Display template ──────────────────────────────────────────────────────────

export function applyDisplayTemplate(
  template: string | null | undefined,
  item: Record<string, unknown>
): string {
  if (!template)
    return String(
      item.name ?? item.title ?? item.label ?? item.type ?? item.description ?? item.id ?? ''
    )
  return template.replace(/\{\{([^}]+)\}\}/g, (_, k: string) => String(item[k.trim()] ?? ''))
}

// ─── JSON parsing ──────────────────────────────────────────────────────────────

export function parseJson<T>(v: unknown): T | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'object') return v as T
  if (typeof v !== 'string') return null
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

// ─── Cascade filter helpers ────────────────────────────────────────────────────

export type CascadeRule = {
  parent_field: string
  filter_column: string
  filter_is_m2m?: boolean
  clear_on_parent_change?: boolean
  clear_on_unavailable?: boolean
  show_all_if_no_parent?: boolean // default true; when false, field is disabled until parent is set
}

export function getCascadeFilters(
  depConfig: Record<string, unknown> | string | null
): CascadeRule[] {
  const parsed = parseJson<{ cascade_filters?: CascadeRule[] }>(depConfig)
  return Array.isArray(parsed?.cascade_filters) ? parsed.cascade_filters : []
}

// ─── CascadeEffectController ───────────────────────────────────────────────────

export function CascadeEffectController({
  cascadeRules,
  cascadeFilter,
  currentValue,
  relatedCollection,
  onClear
}: {
  cascadeRules: CascadeRule[]
  cascadeFilter?: Record<string, unknown>
  currentValue?: unknown
  relatedCollection?: string
  onClear: () => void
}) {
  const client = useNivaroClient()
  const cascadeFilterStr = JSON.stringify(cascadeFilter)
  const prevFilterRef = useRef<string | undefined>(undefined)
  const onClearRef = useRef(onClear)
  onClearRef.current = onClear

  useEffect(() => {
    const prev = prevFilterRef.current
    prevFilterRef.current = cascadeFilterStr
    if (prev === undefined) return
    if (prev === cascadeFilterStr) return
    if (cascadeRules.some((r) => r.clear_on_parent_change)) onClearRef.current()
  }, [cascadeFilterStr, cascadeRules])

  useEffect(() => {
    if (!cascadeFilter || Object.keys(cascadeFilter).length === 0) return
    if (!cascadeRules.some((r) => r.clear_on_unavailable)) return
    if (currentValue == null || !relatedCollection) return
    client
      .request<{ data: unknown[] }>(
        get(`/items/${relatedCollection}`, {
          filter: JSON.stringify({ ...cascadeFilter, id: { _eq: currentValue } }),
          limit: 1,
          fields: 'id'
        })
      )
      .then((r) => {
        if ((r.data ?? []).length === 0) onClearRef.current()
      })
      .catch(() => {})
  }, [cascadeFilter, cascadeRules, client, currentValue, relatedCollection])

  return null
}

// ─── Column span ───────────────────────────────────────────────────────────────

export const COL_SPAN_CLASS: Record<number, string> = {
  3: 'col-span-12 sm:col-span-3',
  4: 'col-span-12 sm:col-span-4',
  6: 'col-span-12 sm:col-span-6',
  12: 'col-span-12'
}

export function getColSpanClass(options: Record<string, unknown> | string | null): string {
  const parsed = parseJson<{ col_span?: number }>(options)
  return COL_SPAN_CLASS[parsed?.col_span ?? 0] ?? 'col-span-12'
}

// ─── Date/time helpers ─────────────────────────────────────────────────────────

export function toLocalDatetime(value: unknown): string {
  if (!value) return ''
  try {
    return new Date(String(value)).toISOString().slice(0, 16)
  } catch {
    return ''
  }
}

// ─── Constants ─────────────────────────────────────────────────────────────────

export const SYSTEM_FIELDS = new Set([
  'id',
  'date_created',
  'date_updated',
  'user_created',
  'user_updated'
])

export const SENTINEL_FIELDS = new Set(['__pipeline__', '__comments__', '__tasks__'])
