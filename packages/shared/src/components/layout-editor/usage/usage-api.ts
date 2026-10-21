import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'

// Usage numbers the layout editor shows (#2588, #2597, #2598, #2605). All
// admin-only reads: the editor is an admin surface in every host.

export const usageKeys = {
  fill: (collection: string) => ['layout-editor', 'usage', 'fill', collection] as const,
  today: (layoutId: number) => ['layout-editor', 'usage', 'today', layoutId] as const,
  friction: (layoutId: number) => ['layout-editor', 'usage', 'friction', layoutId] as const,
  coChanges: (collection: string) => ['layout-editor', 'usage', 'co-changes', collection] as const
}

export interface FillRates {
  total: number
  /** field → percent of records with a value (0-100, one decimal). */
  pct: Map<string, number>
}

/** How full each column is across the collection (the Table Editor's Field usage numbers). */
export function useFieldFillRates(collection: string, enabled = true) {
  const client = useNivaroClient()
  return useQuery<FillRates>({
    queryKey: usageKeys.fill(collection),
    queryFn: async () => {
      const r = await client.request<{
        data?: { total?: number; fields?: Array<{ field: string; pct: number }> }
      }>(get(`/data-model/${encodeURIComponent(collection)}/field-usage`))
      const body = r?.data
      return {
        total: Number(body?.total ?? 0),
        pct: new Map((body?.fields ?? []).map((f) => [f.field, Number(f.pct)]))
      }
    },
    enabled: enabled && !!collection,
    staleTime: 5 * 60_000,
    retry: false
  })
}

/** "Filled on 3%" — whole percent, "under 1%" for a sliver, null for an empty collection. */
export function fillText(pct: number | undefined, total: number): string | null {
  if (pct == null || !Number.isFinite(pct) || total <= 0) return null
  if (pct > 0 && pct < 1) return 'filled on under 1%'
  return `filled on ${Math.round(pct)}%`
}

export interface UsageToday {
  ready: boolean
  opens: number
  people: number
  records: number
}

export function useLayoutUsageToday(layoutId: number | null, enabled = true) {
  const client = useNivaroClient()
  return useQuery<UsageToday | null>({
    queryKey: usageKeys.today(layoutId ?? 0),
    queryFn: () =>
      client
        .request<{ data?: UsageToday }>(get(`/layout-usage/${layoutId}/today`))
        .then((r) => r?.data ?? null),
    enabled: enabled && layoutId != null,
    staleTime: 60_000,
    retry: false
  })
}

/** ", used by 4 people on 12 records today" — null when nothing is known or nobody used it. */
export function usageTodayText(u: UsageToday | null | undefined): string | null {
  if (!u?.ready) return null
  if (u.people === 0 && u.records === 0) return 'not used yet today'
  const people = `${u.people.toLocaleString()} ${u.people === 1 ? 'person' : 'people'}`
  if (u.records === 0) return `used by ${people} today`
  const records = `${u.records.toLocaleString()} ${u.records === 1 ? 'record' : 'records'}`
  return `used by ${people} on ${records} today`
}

export interface FrictionStep {
  key: string
  avg_ms: number
  sessions: number
  abandons: number
}

export interface LayoutFriction {
  ready: boolean
  days: number
  opens: number
  saves: number
  abandons: number
  steps: FrictionStep[]
  changed_after_save: {
    scope: 'layout' | 'collection'
    revisions: number
    fields: Array<{ field: string; changes: number }>
  }
}

export function useLayoutFriction(layoutId: number, enabled = true) {
  const client = useNivaroClient()
  return useQuery<LayoutFriction | null>({
    queryKey: usageKeys.friction(layoutId),
    queryFn: () =>
      client
        .request<{ data?: LayoutFriction }>(get(`/layout-usage/${layoutId}/friction`))
        .then((r) => r?.data ?? null),
    enabled,
    staleTime: 5 * 60_000,
    retry: false
  })
}

export interface CoChangePair {
  a: string
  b: string
  together: number
  jaccard: number
}

export function useCoChanges(collection: string, enabled = true) {
  const client = useNivaroClient()
  return useQuery<{ revisions: number; pairs: CoChangePair[] } | null>({
    queryKey: usageKeys.coChanges(collection),
    queryFn: () =>
      client
        .request<{ data?: { revisions: number; pairs: CoChangePair[] } }>(
          get(`/layout-usage/co-changes/${encodeURIComponent(collection)}`)
        )
        .then((r) => r?.data ?? null),
    enabled,
    staleTime: 10 * 60_000,
    retry: false
  })
}

/** "1 min 20 s", "45 s", "under 1 s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return 'under 1 s'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m < 60) return rest ? `${m} min ${rest} s` : `${m} min`
  const h = Math.floor(m / 60)
  return `${h} h ${m % 60} min`
}

const FILL_KEY = 'nvr:layout-editor:show-fill'

/** Canvas fill-rate hints (the Usage lens): off unless this person turned them on (in this browser). */
export function useShowFillRates(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return window.localStorage.getItem(FILL_KEY) === '1'
    } catch {
      return false
    }
  })
  const set = useCallback((v: boolean) => {
    setOn(v)
    try {
      window.localStorage.setItem(FILL_KEY, v ? '1' : '0')
    } catch {
      // Not remembered; holds for this visit.
    }
  }, [])
  return useMemo(() => [on, set], [on, set])
}
