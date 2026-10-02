/**
 * Investigation group "nav" reads: the Related rail, search, and the wire shapes the load panel
 * renders. Admin only, like every /traffic-map route.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { inspectErrorOf } from '../../inspect/api'
import type { InspectRef } from '../../registry/inspectables'
import { looksLikeCredential } from './logic'

export interface RelatedGroup {
  key: string
  label: string
  refs: InspectRef[]
  more?: number
}

export interface RelatedData {
  groups: RelatedGroup[]
  notes: string[]
  load: { id: string; page: string; calls: number } | null
  at: number
  window: number
}

export interface SearchResult {
  ref: InspectRef
  label: string
  hint: string
}

export interface SearchData {
  q: string | null
  type: string
  refused?: string
  results: SearchResult[]
  hint?: string
}

export interface WaterfallRow {
  rid: string | null
  route: string
  start: number
  ms: number
  status: number
  offset_ms: number
}

export interface LoadDetail {
  load: string
  screen: string
  app: string | null
  page: string
  caller: string
  caller_label: string
  user: string | null
  user_name: string | null
  started_at: number
  ended_at: number
  calls: number
  dropped: number
  waterfall: {
    rows: WaterfallRow[]
    total_ms: number
    slowest: WaterfallRow | null
    duplicates: Array<{ route: string; n: number }>
    errors: number
  }
  rum: {
    route: string
    app: string | null
    samples: number
    lcp_p75: number | null
    fcp_p75: number | null
    ttfb_p75: number | null
    nav_p75: number | null
  } | null
  node: string
  instance: string
}

function noRetryOnClientError(count: number, err: unknown): boolean {
  const s = inspectErrorOf(err).status
  if (s === 400 || s === 404 || s === 403) return false
  return count < 2
}

/** The Related rail for a level (one request shared by every footer that reads it). */
export function useRelated(ref: InspectRef | null, anchor: number | null, windowSec: number) {
  const at = ref?.at ?? anchor ?? null
  return useQuery<RelatedData>({
    queryKey: ['tm-inspect-related', ref?.kind, ref?.id, at, windowSec],
    queryFn: async () => {
      const params: Record<string, number> = { window: Math.round(windowSec) }
      if (at != null && Number.isFinite(at)) params.at = Math.round(at)
      const res = await api.get(
        `/traffic-map/inspect/related/${encodeURIComponent(ref?.kind ?? '')}/${encodeURIComponent(ref?.id ?? '')}`,
        { params }
      )
      return (res?.data as { data: RelatedData }).data
    },
    enabled: !!ref?.kind && !!ref.id,
    staleTime: 30_000,
    retry: noRetryOnClientError
  })
}

/** Search the investigation kinds. A credential-shaped entry is never sent. */
export function useInspectSearch(q: string) {
  const term = q.trim()
  return useQuery<SearchData>({
    queryKey: ['tm-inspect-search', term],
    queryFn: async () => {
      const res = await api.get('/traffic-map/inspect/search', { params: { q: term } })
      return (res?.data as { data: SearchData }).data
    },
    enabled: term.length > 0 && !looksLikeCredential(term),
    staleTime: 15_000,
    retry: noRetryOnClientError
  })
}
