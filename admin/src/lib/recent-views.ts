import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useLocation } from 'react-router'
import { api } from '@/lib/api'

/**
 * #3226 — the records this person opened most recently, from the same store
 * the home page's "Recently viewed" rail reads (`GET /record-views/recent`,
 * the per-user view watermarks), with `changed` = someone else changed it
 * since they last looked (judged by the API from what they can read).
 */
export interface RecentView {
  collection: string
  item_id: string
  label: string
  state: { key: string; label: string; color: string | null } | null
  last_viewed_at: string
  changed?: boolean
  changed_at?: string | null
}

export const RECENT_VIEWS_KEY = 'recent-views-changed'

export function useRecentViews(limit: number, enabled = true) {
  return useQuery({
    queryKey: [RECENT_VIEWS_KEY, limit],
    queryFn: () =>
      api
        .get<{ data: RecentView[] }>('/record-views/recent', { params: { limit, changed: 1 } })
        .then((r) => (Array.isArray(r.data.data) ? r.data.data : []))
        .catch(() => [] as RecentView[]),
    enabled,
    staleTime: 30_000
  })
}

/**
 * Opening a record moves it to the top (the record page's /touch call writes
 * the watermark): refresh the recent lists shortly after landing on one.
 */
export function useRefreshRecentOnRecordOpen() {
  const qc = useQueryClient()
  const { pathname } = useLocation()
  useEffect(() => {
    if (!/^\/collections\/[^/]+\/(?!new$)[^/]+$/.test(pathname)) return
    const t = setTimeout(() => {
      void qc.invalidateQueries({ queryKey: [RECENT_VIEWS_KEY] })
    }, 2500)
    return () => clearTimeout(t)
  }, [pathname, qc])
}

export const recordHref = (r: Pick<RecentView, 'collection' | 'item_id'>) =>
  `/collections/${encodeURIComponent(r.collection)}/${encodeURIComponent(r.item_id)}`
