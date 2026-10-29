import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { useItemEditAuth, useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { renderDisplayTemplate, USER_SYSTEM_COLS, userDisplayLabel } from '../../pipeline/relations'
import { collectionMetaKey, useCollectionBody } from '../collection-meta'
import { type ChoiceLabels, choiceLabelsFrom, type DescribeField } from './describe-conditions'
import { recordCountFilter } from './record-count'
import type { ExplainResponse, OverviewReference, OverviewResponse, OverviewRow } from './types'

export const overviewKeys = {
  overview: (collection: string) => ['layout-editor', 'overview', collection] as const,
  fields: (collection: string) => ['layout-editor', 'fields', collection] as const,
  meta: (collection: string) => collectionMetaKey(collection),
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
  params: {
    collection: string
    item: string | number
    role_id?: string | null
    /** #2715 / #3183: as on a small or tablet-width screen. */
    viewport?: 'phone' | 'tablet' | null
    /** #2714: as on this day (yyyy-mm-dd). */
    at?: string | null
  }
): Promise<ExplainResponse> {
  const res = await client.request<unknown>(
    get('/collection-layouts/explain', {
      collection: params.collection,
      item: params.item,
      ...(params.role_id ? { role_id: params.role_id } : {}),
      ...(params.viewport ? { viewport: params.viewport } : {}),
      ...(params.at ? { at: params.at } : {})
    })
  )
  const body = unwrap<ExplainResponse>(res, 'checked')
  return {
    layout_id: body?.layout_id ?? null,
    reason: body?.reason ?? null,
    checked: body?.checked ?? [],
    at: body?.at ?? null,
    viewport: body?.viewport ?? null
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
  const q = useCollectionBody(collection, {
    enabled,
    select: (b) => (typeof b?.display_template === 'string' ? b.display_template : null)
  })
  // A failed read means "no template", not "still loading".
  return q.isError ? { ...q, data: null } : q
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

/**
 * Refresh everything a layout write can change for this collection. `lazy`
 * only marks it stale: nothing refetches until someone shows it again. The
 * editor saves lazily unless a batch changed what the overview says — the
 * overview read scans several whole tables for references (~1 s).
 */
export function useInvalidateLayouts(collection: string) {
  const qc = useQueryClient()
  return useCallback(
    (opts?: { lazy?: boolean }) => {
      const refetchType = opts?.lazy ? 'none' : 'active'
      for (const queryKey of [
        overviewKeys.overview(collection),
        ['layout-editor', 'health', collection],
        ['collection-layouts', collection],
        ['active-layout', collection]
      ])
        void qc.invalidateQueries({ queryKey, refetchType })
    },
    [qc, collection]
  )
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

/**
 * "≈ N records" for a row: one limit-1 read for the total. null while unknown or
 * when not countable. The count is what the signed-in viewer can see, so the
 * key carries who asked (another identity in the same cache never reuses it).
 */
export function useApproxRecordCount(
  collection: string,
  row: OverviewRow | undefined,
  rows: OverviewRow[],
  enabled = true
) {
  const client = useNivaroClient()
  const { userId } = useItemEditAuth()
  const filter = row ? recordCountFilter(row, rows) : null
  return useQuery<number | null>({
    queryKey: ['layout-editor', 'record-count', userId, collection, filter],
    queryFn: () =>
      client
        .request<{ total?: number | null }>(
          get(`/items/${collection}`, {
            limit: 1,
            ...(filter && Object.keys(filter).length ? { filter: JSON.stringify(filter) } : {})
          })
        )
        .then((r) => (typeof r?.total === 'number' ? r.total : null)),
    enabled: enabled && !!row && filter != null,
    staleTime: 60_000,
    retry: false
  })
}

/**
 * Choice labels for the rule sentences, plus the label of every record a rule
 * names through a many-to-one field ("Type of Workflow is PUB Request", not
 * "is 2"). Until a label loads, the sentence keeps the stored value.
 */
export function useRuleChoiceLabels(
  collection: string,
  fields: DescribeField[],
  rows: OverviewRow[]
): ChoiceLabels {
  const pairs = useMemo(() => {
    const out: Array<{ field: string; value: unknown }> = []
    for (const row of rows)
      for (const rule of row.reason.rules ?? [])
        if (rule.op === 'eq' || rule.op === 'neq')
          out.push({ field: rule.field, value: rule.value })
    return out
  }, [rows])
  return useValueLabels(collection, fields, pairs)
}

/**
 * Choice labels for `fields`, plus the label of each record named by a
 * (field, value) pair whose field is a many-to-one: the record's display
 * template (a user's name for user fields). Until a label loads, the value
 * stays as stored. The layout editor's rule sentences and default ghosts use it.
 */
export function useValueLabels(
  collection: string,
  fields: DescribeField[],
  pairs: Array<{ field: string; value: unknown }>
): ChoiceLabels {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { data: relations = [] } = useCollectionBody(collection, {
    select: (b) => (Array.isArray(b?.relations) ? b.relations : [])
  })
  const base = useMemo(() => choiceLabelsFrom(fields), [fields])

  const wanted = useMemo(() => {
    const out = new Map<string, { field: string; value: string; related: string }>()
    for (const p of pairs) {
      if (p.value == null || p.value === '' || base[p.field]) continue
      if (typeof p.value === 'object') continue
      if (typeof p.value === 'string' && p.value.includes('{{')) continue
      const rel = relations.find(
        (r: {
          many_collection?: string
          many_field?: string
          one_collection?: string
          junction_field?: unknown
        }) =>
          r.many_collection === collection &&
          r.many_field === p.field &&
          r.junction_field == null &&
          !!r.one_collection
      )
      if (!rel?.one_collection) continue
      const value = String(p.value)
      out.set(`${p.field}:${value}`, { field: p.field, value, related: rel.one_collection })
    }
    return [...out.values()]
  }, [pairs, relations, base, collection])

  const results = useQueries({
    queries: wanted.map((w) => ({
      queryKey: ['layout-editor', 'rule-label', w.related, w.value],
      queryFn: async (): Promise<string | null> => {
        const isUser = USER_SYSTEM_COLS.has(w.related)
        const item = await client
          .request<{ data: Record<string, unknown> }>(
            isUser
              ? get(`/users/${w.value}`)
              : get(`/items/${w.related}/${w.value}`, { fields: '*' })
          )
          .then((r) => r.data)
        if (!item) return null
        if (isUser) return userDisplayLabel(item)
        const meta = await qc.fetchQuery({
          queryKey: overviewKeys.meta(w.related),
          queryFn: () =>
            client
              .request<{ data: { display_template?: string | null } }>(
                get(`/collections/${w.related}`)
              )
              .then((r) => r.data),
          staleTime: 5 * 60_000
        })
        return renderDisplayTemplate(meta?.display_template ?? null, item) || null
      },
      staleTime: 30 * 60_000,
      retry: false
    }))
  })

  // A string key: the results array is new every render, its labels are what matter.
  const labelKey = JSON.stringify(results.map((r) => r.data ?? null))
  return useMemo(() => {
    const labels = JSON.parse(labelKey) as Array<string | null>
    const out: ChoiceLabels = { ...base }
    wanted.forEach((w, i) => {
      const label = labels[i]
      if (label) out[w.field] = { ...(out[w.field] ?? {}), [w.value]: label }
    })
    return out
  }, [base, wanted, labelKey])
}
