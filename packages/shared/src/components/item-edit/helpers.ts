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

// ─── Cascade filter builder ────────────────────────────────────────────────────
// ONE compiler for "which options may this picker offer given its parents":
// FieldRow (every form picker) and the quick picker both call it, so a step
// in the quick picker can never offer a record the field's own picker would
// refuse. Value resolution stays with the caller (scalars from the draft,
// M2M parents from staging ± committed junction rows); this only turns
// resolved parent values into the items filter.

export interface CascadeFilterInput {
  rules: CascadeRule[]
  /** Resolved parent value: scalar, an id array for M2M parents, or null. */
  parentValue: (parentField: string) => unknown
  /** The parent's OWN option_filter (already token-resolved), inherited when
   *  the parent is empty — or undefined. */
  parentOptionFilter?: (parentField: string) => Record<string, unknown> | undefined
  /** Parents to ignore entirely (a value this field's own pick derived). */
  skipParent?: (parentField: string) => boolean
}

export interface CascadeFilterResult {
  filter: Record<string, unknown> | undefined
  /** Parents that narrowed the filter, in rule order. */
  satisfiedParents: string[]
  /** Parents with no value, in rule order. */
  unsatisfiedParents: string[]
  /** Required parents (show_all_if_no_parent false) with no value. */
  missingRequiredParents: string[]
}

export function buildCascadeFilter(input: CascadeFilterInput): CascadeFilterResult {
  let filter: Record<string, unknown> | undefined
  const satisfiedParents: string[] = []
  const unsatisfiedParents: string[] = []
  const missingRequiredParents: string[] = []
  const place = (rule: CascadeRule, clause: Record<string, unknown>) => {
    if (!filter) filter = {}
    if (rule.filter_is_m2m) {
      filter[rule.filter_column] = { _some: clause }
    } else if (rule.filter_column.includes('.')) {
      // Dotted path: fold right into nested relation filter; wrap the first
      // hop in _some when it traverses a to-many alias (filter_via_many).
      const segs = rule.filter_column.split('.')
      let nested: Record<string, unknown> = clause
      for (let i = segs.length - 1; i >= 1; i--) nested = { [segs[i]]: nested }
      filter[segs[0]] = rule.filter_via_many ? { _some: nested } : nested
    } else {
      filter[rule.filter_column] = clause
    }
  }
  for (const rule of input.rules) {
    if (input.skipParent?.(rule.parent_field)) continue
    const parentVal = input.parentValue(rule.parent_field)
    const present =
      parentVal != null && parentVal !== '' && !(Array.isArray(parentVal) && parentVal.length === 0)
    if (present) {
      // value_map: parent value → derived filter value(s); arrays become _in
      let filterVal: unknown = parentVal
      if (rule.value_map && typeof rule.value_map === 'object') {
        const vm = rule.value_map
        const mapOne = (v: unknown) => vm[String(v)] ?? rule.value_map_default ?? v
        filterVal = Array.isArray(parentVal)
          ? [
              ...new Set(
                (parentVal as unknown[]).flatMap((v) => {
                  const m = mapOne(v)
                  return Array.isArray(m) ? m : [m]
                })
              )
            ]
          : mapOne(parentVal)
      }
      const clause = Array.isArray(filterVal) ? { _in: filterVal } : { _eq: filterVal }
      place(rule, rule.filter_is_m2m ? { id: clause } : clause)
      satisfiedParents.push(String(rule.parent_field))
    } else {
      unsatisfiedParents.push(String(rule.parent_field))
      if (rule.show_all_if_no_parent === false)
        missingRequiredParents.push(String(rule.parent_field))
      // Parent unset but the parent's OWN picker curates its options
      // (option_filter): inherit that filter through the cascade relation, so
      // this picker never offers records the parent could not hold.
      // value_map rules are value arithmetic, not relational — skipped.
      const inherited = rule.value_map ? undefined : input.parentOptionFilter?.(rule.parent_field)
      if (inherited) place(rule, inherited)
    }
  }
  return { filter, satisfiedParents, unsatisfiedParents, missingRequiredParents }
}

// ─── Quick picker step seeding ─────────────────────────────────────────────────
// Default walk order for a layout's quick picker, derived from the cascade
// graph: parents before children, required parents (show_all_if_no_parent
// false) strictly before the fields that need them, ties broken toward the
// field with fewer rules. Cycles (every EFP rule is also an upstream link)
// resolve the same way — the graph is a preference, not a DAG. Workflows:
// funding_years → divisions → regions → project_type → project → project_sub_types.

export function seedQuickPickerSteps(
  fieldConfig: Array<{
    field: string
    dependency_config?: unknown
    hidden?: boolean
    required?: boolean
  }>,
  relations: Array<{
    many_collection: string
    many_field: string | null
    one_collection: string | null
    one_field: string | null
    junction_field: string | null
  }>,
  collection: string
): string[] {
  const isRelation = (f: string) =>
    relations.some(
      (r) =>
        (r.many_collection === collection && r.many_field === f && !r.junction_field) ||
        (r.one_collection === collection && r.one_field === f)
    )
  const rulesOf = new Map<string, CascadeRule[]>()
  for (const fc of fieldConfig) {
    if (fc.hidden) continue
    const rules = getCascadeFilters(fc.dependency_config as Record<string, unknown> | string | null)
    if (rules.length && isRelation(fc.field)) rulesOf.set(fc.field, rules)
  }
  // Every parent of a cascaded field joins the walk too (funding_years, divisions).
  const members = new Set<string>(rulesOf.keys())
  for (const rules of rulesOf.values())
    for (const r of rules) if (isRelation(r.parent_field)) members.add(r.parent_field)
  // A step earns its place by NARROWING a later one: drop members nothing
  // cascades from (billing / shipping location, default sub type), then
  // members whose only children were those leaves (CAR project type). If that
  // empties the set, the graph has no spine — keep everyone.
  const childrenOf = (f: string, pool: Set<string>) =>
    [...pool].filter((c) => c !== f && (rulesOf.get(c) ?? []).some((r) => r.parent_field === f))
  // …except a REQUIRED leaf whose options genuinely depend on its parents
  // (a strict rule, not show_all_if_no_parent): that is the chain's
  // destination — inventory_request.project narrows to nothing further but
  // is the whole point of the walk.
  const requiredOf = new Set(fieldConfig.filter((f) => f.required).map((f) => f.field))
  const isDestination = (f: string) =>
    requiredOf.has(f) && (rulesOf.get(f) ?? []).some((r) => r.show_all_if_no_parent !== true)
  const leaves = new Set(
    [...members].filter((f) => childrenOf(f, members).length === 0 && !isDestination(f))
  )
  const afterLeaves = new Set([...members].filter((f) => !leaves.has(f)))
  const pruned = new Set(
    [...afterLeaves].filter((f) => childrenOf(f, afterLeaves).length > 0 || rulesOf.has(f))
  )
  const kept = [...afterLeaves].filter((f) => {
    if (!pruned.has(f)) return false
    // a parent whose children were ALL leaves narrows nothing that remains
    const kids = childrenOf(f, members)
    return kids.length === 0 || kids.some((k) => afterLeaves.has(k))
  })
  if (kept.length > 0) {
    members.clear()
    for (const f of kept) members.add(f)
  }
  const picked: string[] = []
  const remaining = new Set(members)
  while (remaining.size) {
    let best: string | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const f of [...remaining].sort()) {
      const rules = (rulesOf.get(f) ?? []).filter((r) => members.has(r.parent_field))
      const requiredUnpicked = rules.filter(
        (r) => r.show_all_if_no_parent === false && !picked.includes(r.parent_field)
      ).length
      if (requiredUnpicked > 0) continue
      const unpickedParents = new Set(
        rules.map((r) => r.parent_field).filter((p) => !picked.includes(p) && p !== f)
      ).size
      const score = unpickedParents * 100 + rules.length
      if (score < bestScore) {
        bestScore = score
        best = f
      }
    }
    // Only cyclic required parents left — take the one with the fewest rules.
    if (best == null)
      best = [...remaining].sort(
        (a, b) => (rulesOf.get(a)?.length ?? 0) - (rulesOf.get(b)?.length ?? 0)
      )[0]
    picked.push(best)
    remaining.delete(best)
  }
  return picked
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
