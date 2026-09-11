import { type RefObject, useEffect, useRef, useState } from 'react'
import { useNivaroClient, useParentDraft } from '../../context'
import { get } from '../../lib/commands'
import type { NestedOps } from './types'

// ─── Display template ──────────────────────────────────────────────────────────

export function applyDisplayTemplate(
  template: string | null | undefined,
  item: Record<string, unknown>
): string {
  if (!template)
    return String(
      item.name ?? item.title ?? item.label ?? item.type ?? item.description ?? item.id ?? ''
    )
  return template.replace(/\{\{([^}]+)\}\}/g, (_, k: string) => {
    const parts = k.trim().split('.')
    let val: unknown = item
    for (const part of parts) {
      if (val == null || typeof val !== 'object') {
        val = null
        break
      }
      val = (val as Record<string, unknown>)[part]
    }
    return String(val ?? '')
  })
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
  /** Column on the picker's target collection — may be a dotted relation path
   *  ('regions.region'); the first hop is wrapped in _some when filter_via_many. */
  filter_column: string
  filter_is_m2m?: boolean
  /** Dotted filter_column's first hop is a to-many alias (O2M/M2M) — wrap in _some. */
  filter_via_many?: boolean
  /** Derive the filter value(s) from the parent's value instead of using it
   *  directly: {parentValue: filterValue | filterValue[]}. Missing keys fall
   *  back to value_map_default, then the raw parent value. Arrays become _in.
   *  (EFP parent-unit hierarchy: DAAS→PPOD ids, PPOD→CPOD id, …) */
  value_map?: Record<string, unknown>
  value_map_default?: unknown
  clear_on_parent_change?: boolean
  clear_on_unavailable?: boolean
  /** Reverse the cascade on PICK: choosing this field resolves filter_column
   *  on the picked record and fills parent_field from it (a Region pick fills
   *  its Zone). Scalar parents fill only when exactly one value resolves;
   *  alias parents stage every resolved link (additive). */
  upstream?: boolean
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
  missingRequiredParents,
  onClear
}: {
  cascadeRules: CascadeRule[]
  cascadeFilter?: Record<string, unknown>
  currentValue?: unknown
  relatedCollection?: string
  /** Parent fields with show_all_if_no_parent=false that are EMPTY right now. */
  missingRequiredParents?: string[]
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

  // This check deliberately bypasses react-query (it clears a field as a side
  // effect rather than rendering data), which also means nothing dedupes it —
  // and `cascadeFilter` is a fresh object on every parent render, so the effect
  // re-fired continuously. One item form issued the SAME availability request
  // nine times concurrently, per cascading field. The ref records the exact
  // question already asked, so an unchanged (collection, value, filter) never
  // repeats no matter how often the effect re-runs.
  const lastCheckRef = useRef<string | null>(null)
  // Auto-clear ONLY when the user changed one of this cascade's PARENT fields
  // this session (ParentDraftContext.dirtyFields). A record LOADED with a
  // stale saved value keeps it — silently clearing there wiped a value the
  // user never touched (dirtying the form; a Save would persist null) and hid
  // the picker's amber "not an available option" flag. A filter-key heuristic
  // is not enough: M2M parents settle asynchronously after mount, so the
  // load-time filter itself changes without any user interaction.
  const parentDraft = useParentDraft()
  const dirtyFields = parentDraft?.dirtyFields
  // A required parent the USER emptied this session: the child's picker is
  // disabled ("Select Project first") and its value can no longer be
  // re-picked, yet it kept narrowing everything downstream (Project cleared →
  // Sub Type stayed → Project Type offered only CMTS). Clear it like any
  // other value that fell out of its cascade; a record that merely LOADED
  // with the parent empty keeps its value (dirtyFields gate, as above).
  const missingKey = (missingRequiredParents ?? []).join(',')
  const lastMissingClearRef = useRef<string | null>(null)
  useEffect(() => {
    if (currentValue == null || currentValue === '') return
    const emptiedByUser = (missingRequiredParents ?? []).filter(
      (p) =>
        dirtyFields?.has(p) &&
        cascadeRules.some((r) => r.parent_field === p && r.clear_on_unavailable)
    )
    if (emptiedByUser.length === 0) return
    const key = `${String(currentValue)}|${emptiedByUser.join(',')}`
    if (lastMissingClearRef.current === key) return
    lastMissingClearRef.current = key
    onClearRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingKey, currentValue, dirtyFields, cascadeRules])
  useEffect(() => {
    if (!cascadeFilter || Object.keys(cascadeFilter).length === 0) return
    if (!cascadeRules.some((r) => r.clear_on_unavailable)) return
    if (currentValue == null || !relatedCollection) return
    const parentTouched = cascadeRules.some(
      (r) => r.clear_on_unavailable && dirtyFields?.has(r.parent_field)
    )
    if (!parentTouched) return
    const checkKey = `${relatedCollection}|${String(currentValue)}|${cascadeFilterStr}`
    if (lastCheckRef.current === checkKey) return
    lastCheckRef.current = checkKey
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
      .catch(() => {
        // A failed check must not stick: let the next render retry rather than
        // leaving a value permanently unverified.
        if (lastCheckRef.current === checkKey) lastCheckRef.current = null
      })
  }, [
    cascadeFilter,
    cascadeFilterStr,
    cascadeRules,
    client,
    currentValue,
    relatedCollection,
    dirtyFields
  ])

  return null
}

// ─── Column span ───────────────────────────────────────────────────────────────

export const COL_SPAN_CLASS: Record<number, string> = {
  3: 'col-span-12',
  4: 'col-span-12',
  6: 'col-span-12',
  12: 'col-span-12'
}

export function useContainerWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(9999)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    const ro = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}

export function resolveColSpan(
  options: Record<string, unknown> | string | null,
  containerWidth: number
): number {
  const parsed = parseJson<{ col_span?: number }>(options)
  const cfg = parsed?.col_span ?? 0
  const configured = [3, 4, 6, 12].includes(cfg) ? cfg : 12
  if (containerWidth < 480) return 12
  if (containerWidth < 800) return configured <= 6 ? 6 : 12
  return configured
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

export const SENTINEL_FIELDS = new Set([
  '__pipeline__',
  '__comments__',
  '__tasks__',
  '__addendums__',
  '__referenced_by__',
  '__related_records__',
  '__owners__',
  '__pdf__',
  '__subtitle__'
])
export const isSentinelKey = (field: string) =>
  SENTINEL_FIELDS.has(field) || (field.startsWith('__widget_') && field.endsWith('__'))

export const EMPTY_NESTED_OPS: NestedOps = { created: [], updated: [], deleted: [] }

/**
 * Rich text as plain words. Handles BOTH storage shapes a rich-text field
 * can hold: Tiptap HTML (the current shape) and the legacy EditorJS document
 * (`{"time":…,"blocks":[…]}`) that rows converted before 2026-08-13 — or
 * never converted — still carry. Returns null when the value is neither, so
 * callers can fall back to their normal rendering.
 */
export function richTextToPlain(val: unknown): string | null {
  if (typeof val !== 'string') return null
  const s = val.trim()
  if (!s) return null
  if (s.startsWith('{') && /"blocks"\s*:/.test(s)) {
    try {
      const doc = JSON.parse(s) as {
        blocks?: Array<{ type?: string; data?: Record<string, unknown> }>
      }
      if (Array.isArray(doc.blocks)) {
        const parts: string[] = []
        for (const b of doc.blocks) {
          const d = b.data ?? {}
          if (typeof d.text === 'string') parts.push(d.text)
          else if (Array.isArray(d.items))
            parts.push(
              (d.items as unknown[])
                .map((it) =>
                  typeof it === 'string'
                    ? it
                    : String((it as Record<string, unknown>)?.content ?? '')
                )
                .filter(Boolean)
                .join(' · ')
            )
        }
        return stripTags(parts.join(' ')).trim()
      }
    } catch {
      /* not EditorJS after all */
    }
  }
  if (/<[a-z][\s\S]*>/i.test(s)) return stripTags(s).trim()
  return null
}

function stripTags(html: string): string {
  if (typeof document !== 'undefined') {
    const div = document.createElement('div')
    div.innerHTML = html
    return (div.textContent || '').replace(/\s+/g, ' ')
  }
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
}
