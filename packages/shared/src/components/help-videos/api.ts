import type { NivaroClient } from '@nivaro/sdk'
import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../../context'
import { del, get, patch, post, put } from '../../lib/commands'
import type {
  HelpVideoContext,
  HelpVideoDto,
  HelpVideoErrorCode,
  VersionDto,
  VideoEdits,
  Visibility
} from './types'

export const helpVideoKeys = {
  all: ['help-videos'] as const,
  one: (id: string) => ['help-videos', 'one', id] as const,
  forCtx: (ctx: Record<string, unknown>) => ['help-videos', 'for', ctx] as const,
  library: (p: Record<string, unknown>) => ['help-videos', 'library', p] as const,
  required: ['help-videos', 'required'] as const,
  pages: ['help-videos', 'pages'] as const
}

/** One video as this person may see it (fresh media tickets every call). */
export async function fetchHelpVideo(client: NivaroClient, id: string): Promise<HelpVideoDto> {
  return (await client.request(get<{ data: HelpVideoDto }>(`/help-videos/${id}`))).data
}

export function useHelpVideo(id: string | null) {
  const client = useNivaroClient()
  return useQuery({
    queryKey: helpVideoKeys.one(id ?? ''),
    enabled: !!id,
    queryFn: () => fetchHelpVideo(client, id as string),
    // Poll while a render runs so the status chip and the stream switch over by themselves.
    refetchInterval: (q) => {
      const s = q.state.data?.published?.render_status
      return s === 'queued' || s === 'rendering' ? 4000 : false
    }
  })
}

export function useHelpVideosFor(
  ctx: { collection?: string; item?: string | number; state?: string; page?: string },
  enabled = true
) {
  const client = useNivaroClient()
  return useQuery({
    queryKey: helpVideoKeys.forCtx(ctx),
    enabled: enabled && !!(ctx.collection || ctx.page),
    staleTime: 60_000,
    queryFn: () =>
      client.request(
        get<{ data: HelpVideoDto[]; can_author: boolean; state: string | null }>(
          '/help-videos/for',
          ctx as Record<string, unknown>
        )
      )
  })
}

export function useHelpVideoLibrary(params: {
  search?: string
  category?: string
  status?: string
  page?: number
}) {
  const client = useNivaroClient()
  return useQuery({
    queryKey: helpVideoKeys.library(params),
    queryFn: () =>
      client.request(
        get<{ data: HelpVideoDto[]; total: number; categories: string[]; can_author: boolean }>(
          '/help-videos',
          params
        )
      ),
    placeholderData: (prev) => prev
  })
}

export function useRequiredVideos() {
  const client = useNivaroClient()
  return useQuery({
    queryKey: helpVideoKeys.required,
    staleTime: 60_000,
    queryFn: async () =>
      (await client.request(get<{ data: HelpVideoDto[] }>('/help-videos/required/mine'))).data
  })
}

export function useHelpVideoPages() {
  const client = useNivaroClient()
  return useQuery({
    queryKey: helpVideoKeys.pages,
    staleTime: 300_000,
    queryFn: async () =>
      (
        await client.request(
          get<{ data: Array<{ key: string; label: string; app: string | null }> }>(
            '/help-videos/pages'
          )
        )
      ).data
  })
}

/** Every mutation, as plain functions over the client. */
export function helpVideoApi(client: NivaroClient) {
  const r = client.request.bind(client)
  return {
    create: (body: { upload_id: string; title?: string; contexts?: HelpVideoContext[] }) =>
      r(post<{ data: HelpVideoDto }>('/help-videos', body)).then((x) => x.data),
    update: (
      id: string,
      body: {
        title?: string
        description?: string | null
        category?: string | null
        visibility?: Visibility
      }
    ) => r(patch<{ data: HelpVideoDto }>(`/help-videos/${id}`, body)).then((x) => x.data),
    setContexts: (id: string, contexts: HelpVideoContext[]) =>
      r(put(`/help-videos/${id}/contexts`, { contexts })),
    setRequirements: (id: string, role_ids: string[]) =>
      r(put(`/help-videos/${id}/requirements`, { role_ids })),
    archive: (id: string) => r(del(`/help-videos/${id}`)),
    draft: (id: string) =>
      r(get<{ data: VersionDto }>(`/help-videos/${id}/draft/edits`)).then((x) => x.data),
    /** 409 HELP_VIDEO_EDITS_CONFLICT (with `current_hash`) when `base_hash` is stale;
     *  422 HELP_VIDEO_EDITS_INVALID when the edits keep under a second. */
    saveDraft: (id: string, edits: VideoEdits, base_hash?: string) =>
      r(put<{ data: VersionDto }>(`/help-videos/${id}/draft/edits`, { edits, base_hash })).then(
        (x) => x.data
      ),
    publish: (id: string, watch_again: boolean) =>
      r(post<{ data: HelpVideoDto }>(`/help-videos/${id}/publish`, { watch_again })).then(
        (x) => x.data
      ),
    rerecord: (id: string, upload_id: string) =>
      r(post<{ data: VersionDto }>(`/help-videos/${id}/rerecord`, { upload_id })).then(
        (x) => x.data
      ),
    versions: (id: string) =>
      r(
        get<{
          data: Array<
            VersionDto & {
              is_published: boolean
              is_draft: boolean
              created_by_name: string | null
            }
          >
        }>(`/help-videos/${id}/versions`)
      ).then((x) => x.data),
    restore: (id: string, versionId: string) =>
      r(post<{ data: VersionDto }>(`/help-videos/${id}/versions/${versionId}/restore`)).then(
        (x) => x.data
      ),
    rerender: (id: string, draft = false) =>
      r(post(`/help-videos/${id}/render${draft ? '?draft=1' : ''}`)),
    progress: (
      id: string,
      body: { position_ms: number; watched_ms_delta: number; buckets: string; version_id?: string }
    ) => r(post<{ data: { completed: boolean } } | undefined>(`/help-videos/${id}/progress`, body)),
    analytics: (id: string) =>
      r(
        get<{
          data: {
            views: number
            unique_viewers: number
            completion_rate: number
            drop_off: number[]
            watched_hours: number
          }
        }>(`/help-videos/${id}/analytics`)
      ).then((x) => x.data),
    openUpload: (mime: string) =>
      r(post<{ data: { id: string; next_part: number } }>('/help-videos/uploads', { mime })).then(
        (x) => x.data
      ),
    finalizeUpload: (id: string, meta: { duration_ms: number; clicks: unknown; levels: unknown }) =>
      r(
        post<{ data: { file_id: string; duration_ms: number | null } }>(
          `/help-videos/uploads/${id}/finalize`,
          meta
        )
      ).then((x) => x.data),
    myUploads: () =>
      r(
        get<{
          data: Array<{ id: string; bytes_received: number; next_part: number; created_at: string }>
        }>('/help-videos/uploads/mine')
      ).then((x) => x.data),
    abandonUpload: (id: string) => r(del(`/help-videos/uploads/${id}`)),
    registerPage: (key: string, label: string, app?: string) =>
      r(post('/help-videos/pages', { key, label, app })),
    authorRoles: () =>
      r(get<{ data: { help_video_author_roles?: unknown } }>('/settings')).then((x) =>
        parseRoleIdList(x.data?.help_video_author_roles)
      ),
    setAuthorRoles: (ids: string[]) => r(patch('/settings', { help_video_author_roles: ids }))
  }
}

/** The `{ status, code }` of a failed help-video request (the SDK throws an
 *  Error carrying `status` and the JSON body as `response`), or null. */
export function helpVideoError(
  err: unknown
): { status: number; code: HelpVideoErrorCode | string | null; current_hash?: string } | null {
  if (!err || typeof err !== 'object') return null
  const e = err as { status?: unknown; response?: { code?: unknown; current_hash?: unknown } }
  if (typeof e.status !== 'number') return null
  return {
    status: e.status,
    code: typeof e.response?.code === 'string' ? e.response.code : null,
    ...(typeof e.response?.current_hash === 'string'
      ? { current_hash: e.response.current_hash }
      : {})
  }
}

/** `GET /settings` returns the column as stored — a JSON string (or null).
 *  Accept an array too, so a future server that parses it keeps working. */
export function parseRoleIdList(raw: unknown): string[] {
  const list = (() => {
    if (Array.isArray(raw)) return raw as unknown[]
    if (typeof raw !== 'string' || !raw.trim()) return []
    try {
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  })()
  return list.filter((v): v is string => typeof v === 'string' && v.length > 0)
}
