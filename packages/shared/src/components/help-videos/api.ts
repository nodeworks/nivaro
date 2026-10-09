import type { NivaroClient } from '@nivaro/sdk'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
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
  pages: ['help-videos', 'pages'] as const,
  /** The editor's draft load. Outside the `all` prefix on purpose: GET
   *  /draft/edits creates a missing draft, so a broad invalidation must
   *  never refetch it. `n` bumps on Reload. */
  draftEdits: (id: string, n: number) => ['help-video-draft', id, n] as const
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

type LibraryPage = {
  data: HelpVideoDto[]
  total: number
  categories: string[]
  can_author: boolean
}

/** The next page to ask for (1-based), or undefined once everything is loaded. */
export function nextLibraryPage(pages: Array<Pick<LibraryPage, 'data' | 'total'>>) {
  const last = pages[pages.length - 1]
  if (!last?.data.length) return undefined
  const loaded = pages.reduce((n, p) => n + p.data.length, 0)
  return loaded < last.total ? pages.length + 1 : undefined
}

/** The library, a page at a time. A new search, category or status is a new
 *  key, so it starts again from page 1. */
export function useHelpVideoLibrary(params: {
  search?: string
  category?: string
  status?: string
}) {
  const client = useNivaroClient()
  return useInfiniteQuery({
    queryKey: helpVideoKeys.library(params),
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      client.request(get<LibraryPage>('/help-videos', { ...params, page: pageParam })),
    getNextPageParam: (_last, all) => nextLibraryPage(all),
    placeholderData: (prev) => prev,
    select: (d): LibraryPage => ({
      data: d.pages.flatMap((p) => p.data),
      total: d.pages[d.pages.length - 1]?.total ?? 0,
      categories: d.pages[0]?.categories ?? [],
      can_author: d.pages[0]?.can_author ?? false
    })
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

/** One click on the recorded tab: recording time and frame fractions (0–1). */
export type RecordedClick = { t_ms: number; x: number; y: number }

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
    /**
     * Closes an upload and stores the recorder's data with it, as given.
     * - `duration_ms`: recording time without pauses (the server prefers its
     *   own probe of the file; 0 when unknown).
     * - `clicks`: `{ t_ms, x, y }` per click on the recorded tab: `t_ms` is
     *   recording time, `x`/`y` are fractions (0–1) of the captured frame.
     *   Null when clicks were not captured.
     * - `levels`: microphone loudness, one number from 0 (silence) to 1 every
     *   100 ms of recording time (10 per second), so `levels[i]` covers
     *   `i * 100` ms. Null without a microphone.
     * Matches `HelpVideoVersion.clicks` / `.levels` in @nivaro/sdk.
     * 422 UPLOAD_TOO_LONG past 31 minutes, 409 UPLOAD_CLOSED when finished.
     */
    finalizeUpload: (
      id: string,
      meta: { duration_ms: number; clicks: RecordedClick[] | null; levels: number[] | null }
    ) =>
      r(
        post<{ data: { file_id: string; duration_ms: number | null } }>(
          `/help-videos/uploads/${id}/finalize`,
          meta
        )
      ).then((x) => x.data),
    myUploads: () =>
      r(
        get<{
          data: Array<{
            id: string
            bytes_received: number
            next_part: number
            /** `open`, or `finalized`: uploaded but never saved as a video. */
            status: string
            duration_ms: number | null
            created_at: string
            updated_at: string
          }>
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
