import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useNivaroClient } from '../../../context'
import { del, get, post, put } from '../../../lib/commands'

// Watch, owner and preview links of one form (#2655 #2656 #2666) — /api/layout-collab.

export interface PersonRef {
  id: string
  name: string
}

/** Review reminder (#2718): months unchanged before the owner is reminded. */
export interface LayoutReview {
  /** This form's own months; null = the default applies (0 = never). */
  months: number | null
  default_months: number
  effective_months: number
  last_changed_at: string | null
  next_at: string | null
}

export interface LayoutCollab {
  owner: PersonRef | null
  watching: boolean
  watchers: PersonRef[]
  /** Absent on older APIs. */
  review?: LayoutReview
}

export interface PreviewLinkRow {
  id: string
  token: string
  path: string
  expires_at: string | null
  view_count: number
  comments: number
  created_at: string | null
}

export interface PreviewCommentRow {
  id: string
  link_id: string
  field: string | null
  name: string
  text: string
  at: string
}

export const collabKeys = {
  one: (layoutId: number) => ['layout-editor', 'collab', layoutId] as const,
  owners: () => ['layout-editor', 'collab', 'owners'] as const,
  links: (layoutId: number) => ['layout-editor', 'collab', layoutId, 'links'] as const,
  comments: (layoutId: number) => ['layout-editor', 'collab', layoutId, 'comments'] as const
}

const data = <T>(r: unknown, fallback: T): T => ((r as { data?: T } | null)?.data ?? fallback) as T

export function useLayoutCollab(layoutId: number) {
  const client = useNivaroClient()
  return useQuery<LayoutCollab>({
    queryKey: collabKeys.one(layoutId),
    queryFn: async () =>
      data(await client.request<unknown>(get(`/layout-collab/${layoutId}`)), {
        owner: null,
        watching: false,
        watchers: []
      }),
    staleTime: 30_000
  })
}

/** Every form's owner, by layout id — one read for the whole overview. */
export function useLayoutOwners() {
  const client = useNivaroClient()
  return useQuery<Record<string, PersonRef>>({
    queryKey: collabKeys.owners(),
    queryFn: async () => data(await client.request<unknown>(get('/layout-collab/owners')), {}),
    staleTime: 60_000
  })
}

export function usePreviewLinks(layoutId: number, enabled: boolean) {
  const client = useNivaroClient()
  return useQuery<PreviewLinkRow[]>({
    queryKey: collabKeys.links(layoutId),
    queryFn: async () =>
      data(await client.request<unknown>(get(`/layout-collab/${layoutId}/preview-links`)), []),
    enabled,
    staleTime: 15_000
  })
}

export function usePreviewComments(layoutId: number) {
  const client = useNivaroClient()
  return useQuery<PreviewCommentRow[]>({
    queryKey: collabKeys.comments(layoutId),
    queryFn: async () =>
      data(await client.request<unknown>(get(`/layout-collab/${layoutId}/preview-comments`)), []),
    staleTime: 30_000,
    refetchOnWindowFocus: true
  })
}

export function useCollabActions(layoutId: number) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const refresh = useCallback(
    () => qc.invalidateQueries({ queryKey: ['layout-editor', 'collab'] }),
    [qc]
  )
  return {
    setWatch: async (on: boolean) => {
      await client.request(put(`/layout-collab/${layoutId}/watch`, { on }))
      await refresh()
    },
    setOwner: async (userId: string | null) => {
      await client.request(put(`/layout-collab/${layoutId}/owner`, { user_id: userId }))
      await refresh()
    },
    setReviewMonths: async (months: number | null) => {
      await client.request(put(`/layout-collab/${layoutId}/review`, { months }))
      await refresh()
    },
    createLink: async (days: number): Promise<PreviewLinkRow> => {
      const r = await client.request<unknown>(
        post(`/layout-collab/${layoutId}/preview-links`, { days })
      )
      await refresh()
      return data(r, null as unknown as PreviewLinkRow)
    },
    revokeLink: async (linkId: string) => {
      await client.request(del(`/layout-collab/preview-links/${linkId}`))
      await refresh()
    },
    resolveComment: async (commentId: string) => {
      await client.request(del(`/layout-collab/${layoutId}/preview-comments/${commentId}`))
      await refresh()
    }
  }
}

/** The link someone opens: the API path on this page's origin (every host proxies /api). */
export function previewUrl(path: string): string {
  if (typeof window === 'undefined') return path
  return new URL(path, window.location.origin).toString()
}
