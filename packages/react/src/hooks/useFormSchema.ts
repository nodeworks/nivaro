import type { NivaroClient } from '@nivaro/sdk'
import { useEffect, useRef, useState } from 'react'
import { get } from '../lib/commands'
import type { FormSchema } from '../types'
import {
  type AssignmentEntry,
  buildSchema,
  type CMSCollectionResponse,
  type CMSGroupRow,
  toBool,
  UNGROUPED_POS_SENTINEL
} from './schemaBuilder'

// Re-export for the public index — normalizeFieldType moved to schemaBuilder.ts
export { normalizeFieldType } from './schemaBuilder'

// ─── Active-layout API shape ───────────────────────────────────────────────

type ActiveLayoutData = {
  layout?: {
    tab_mode?: string | null
    ai_enabled?: boolean | number | null
    summary_enabled?: boolean | number | null
    validate_before_next?: boolean | number | null
  }
  groups: CMSGroupRow[]
  assignments: Array<{
    field: string
    group_key: string | null
    sort: number
    label_override?: string | null
    is_visible?: boolean | number | null
    default_expanded?: boolean | number | null
  }>
  ungrouped_sort?: number | null
}

const SLOT_KEYS = new Set(['__pipeline__', '__comments__', '__tasks__'])

function applyLayoutMeta(schema: FormSchema, lm: ActiveLayoutData['layout']): void {
  schema.tabMode = lm?.tab_mode === 'steps' ? 'steps' : lm?.tab_mode === 'tabs' ? 'tabs' : null
  schema.aiEnabled = toBool(lm?.ai_enabled)
  schema.summaryEnabled = toBool(lm?.summary_enabled)
  schema.validateBeforeNext = toBool(lm?.validate_before_next)
}

function extractSlotAssignments(
  assignments: ActiveLayoutData['assignments']
): FormSchema['slotAssignments'] {
  return assignments
    .filter((a) => SLOT_KEYS.has(a.field))
    .map((a) => ({
      slot: a.field,
      groupKey: a.group_key ?? null,
      sort: a.sort,
      labelOverride: a.label_override ?? null,
      isVisible: a.is_visible == null ? true : toBool(a.is_visible),
      defaultExpanded: toBool(a.default_expanded)
    }))
}

// ─── Module-level cache ──────────────────────────────────────────────────────
// Keyed by clientUrl::collection::includeHidden::layoutId so different
// collection/layout combinations stay separate. Clients pointing to the same
// URL share cached entries (intended for singleton/shared client patterns).
// Call clearFormSchemaCache() after a schema mutation to bust stale entries.

const schemaCache = new Map<string, FormSchema>()

function cacheKey(
  clientUrl: string,
  collection: string,
  includeHidden: boolean,
  layoutId?: number,
  layoutSlug?: string
): string {
  if (layoutSlug)
    return `${clientUrl}::${collection}::${includeHidden ? 'h' : ''}::slug=${layoutSlug}`
  return `${clientUrl}::${collection}::${includeHidden ? 'h' : ''}::${layoutId ?? 'active'}`
}

export async function fetchSchema(
  client: NivaroClient,
  collection: string,
  includeHidden: boolean,
  layoutId?: number,
  layoutSlug?: string
): Promise<FormSchema> {
  if (layoutId != null) {
    // Explicit layout: fetch collection + layout meta + groups + assignments
    const [collectionRes, layoutRes, groupsRes, assignmentsRes] = await Promise.all([
      client.request<{ data: CMSCollectionResponse }>(get(`/collections/${collection}`)),
      client
        .request<{ data: ActiveLayoutData['layout'] }>(get(`/collection-layouts/${layoutId}`))
        .catch(() => ({ data: undefined })),
      client.request<{ data: CMSGroupRow[] }>(
        get(`/field-groups/${collection}`, { layout_id: layoutId })
      ),
      client.request<{
        data: Array<{
          field: string
          group_key: string | null
          sort: number
          label_override?: string | null
          is_visible?: boolean | number | null
          default_expanded?: boolean | number | null
        }>
      }>(get(`/collection-layouts/${layoutId}/assignments`))
    ])

    const assignmentMap = new Map<string, AssignmentEntry>()
    let ungroupedSort: number | null = null
    const allAssignments = assignmentsRes.data ?? []
    for (const a of allAssignments) {
      if (a.field === UNGROUPED_POS_SENTINEL) {
        ungroupedSort = a.sort
        continue
      }
      // Slot sentinels (__pipeline__ etc.) are surfaced via slotAssignments,
      // never as field assignments (shared parity).
      if (SLOT_KEYS.has(a.field)) continue
      assignmentMap.set(a.field, {
        group_key: a.group_key,
        sort: a.sort,
        is_visible: a.is_visible == null ? true : toBool(a.is_visible),
        label_override: a.label_override ?? null,
        default_expanded: a.default_expanded
      })
    }

    const schema = buildSchema(
      collection,
      collectionRes.data,
      groupsRes.data ?? [],
      includeHidden,
      assignmentMap
    )
    schema.ungroupedSort = ungroupedSort
    applyLayoutMeta(schema, layoutRes.data)
    schema.slotAssignments = extractSlotAssignments(allAssignments)
    return schema
  }

  // Active layout: compound endpoint returns groups + assignments together
  const [collectionRes, activeRes] = await Promise.all([
    client.request<{ data: CMSCollectionResponse }>(get(`/collections/${collection}`)),
    client
      .request<{ data: ActiveLayoutData }>(
        get(
          '/collection-layouts/active',
          layoutSlug ? { collection, slug: layoutSlug } : { collection }
        )
      )
      .catch(() => ({
        data: {
          groups: [] as CMSGroupRow[],
          assignments: [],
          ungrouped_sort: null
        } as ActiveLayoutData
      }))
  ])

  const assignmentMap = new Map<string, AssignmentEntry>()
  let ungroupedSort: number | null = activeRes.data.ungrouped_sort ?? null
  for (const a of activeRes.data.assignments ?? []) {
    if (a.field === UNGROUPED_POS_SENTINEL) {
      ungroupedSort = a.sort
      continue
    }
    if (SLOT_KEYS.has(a.field)) continue
    assignmentMap.set(a.field, {
      group_key: a.group_key,
      sort: a.sort,
      label_override: a.label_override ?? null
    })
  }

  const schema = buildSchema(
    collection,
    collectionRes.data,
    activeRes.data.groups ?? [],
    includeHidden,
    assignmentMap.size > 0 ? assignmentMap : undefined
  )
  schema.ungroupedSort = ungroupedSort
  applyLayoutMeta(schema, activeRes.data.layout)
  schema.slotAssignments = extractSlotAssignments(activeRes.data.assignments ?? [])
  return schema
}

/**
 * Fetch + cache a collection's form schema. Caches by client URL + collection +
 * includeHidden flag so re-mounts and sibling forms share one request.
 *
 * NOTE: Pass a stable `client` reference. A new object on every render resets
 * the cache key and re-fetches. Use `useMemo` or define the client outside the
 * component tree.
 */
export function useFormSchema(
  client: NivaroClient | null,
  collection: string,
  includeHidden = false,
  layoutId?: number,
  layoutSlug?: string
): { schema: FormSchema | null; loading: boolean; error: Error | null } {
  const key = client ? cacheKey(client.url, collection, includeHidden, layoutId, layoutSlug) : null
  const [schema, setSchema] = useState<FormSchema | null>(() =>
    key ? (schemaCache.get(key) ?? null) : null
  )
  const [loading, setLoading] = useState<boolean>(() => !(key && schemaCache.has(key)))
  const [error, setError] = useState<Error | null>(null)
  const reqIdRef = useRef(0)

  useEffect(() => {
    if (!client || !collection) {
      setLoading(false)
      return
    }
    const cached = schemaCache.get(key as string)
    if (cached) {
      setError(null)
      setSchema(cached)
      setLoading(false)
      return
    }

    const reqId = ++reqIdRef.current
    let active = true
    setError(null)
    setSchema(null)
    setLoading(true)

    fetchSchema(client, collection, includeHidden, layoutId, layoutSlug)
      .then((s) => {
        if (!active || reqId !== reqIdRef.current) return
        schemaCache.set(key as string, s)
        setSchema(s)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (!active || reqId !== reqIdRef.current) return
        setError(err instanceof Error ? err : new Error(String(err)))
        setLoading(false)
      })

    return () => {
      active = false
    }
  }, [client, collection, includeHidden, key, layoutId, layoutSlug])

  return { schema, loading, error }
}

/** Clear the schema cache (e.g. after a schema change). */
export function clearFormSchemaCache(collection?: string): void {
  if (!collection) {
    schemaCache.clear()
    return
  }
  for (const k of Array.from(schemaCache.keys())) {
    if (k.includes(`::${collection}::`)) schemaCache.delete(k)
  }
}
