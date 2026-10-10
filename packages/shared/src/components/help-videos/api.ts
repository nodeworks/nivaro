import type { NivaroClient } from '@nivaro/sdk'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../../context'
import { del, get, patch, post, put } from '../../lib/commands'
import { type CardBrand, cardAccent } from './cards'
import type {
  ActivitySpan,
  HelpVideoContext,
  HelpVideoDto,
  HelpVideoErrorCode,
  MusicTrack,
  OpenverseSearch,
  RecordedClick,
  RecordedMark,
  UploadedMusic,
  VersionDto,
  VideoEdits,
  Visibility,
  WalkStep
} from './types'

export const helpVideoKeys = {
  all: ['help-videos'] as const,
  one: (id: string) => ['help-videos', 'one', id] as const,
  forCtx: (ctx: Record<string, unknown>) => ['help-videos', 'for', ctx] as const,
  library: (p: Record<string, unknown>) => ['help-videos', 'library', p] as const,
  required: ['help-videos', 'required'] as const,
  pages: ['help-videos', 'pages'] as const,
  walk: (id: string) => ['help-videos', 'walk', id] as const,
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

/** "Show me on this page": the published version's labelled clicks. */
export function useHelpVideoWalk(id: string | null) {
  const client = useNivaroClient()
  return useQuery({
    queryKey: helpVideoKeys.walk(id ?? ''),
    enabled: !!id,
    staleTime: 300_000,
    queryFn: async () =>
      (
        await client.request(
          get<{ data: { version_id: string | null; steps: WalkStep[] } }>(`/help-videos/${id}/walk`)
        )
      ).data
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

/** An upload session as `/help-videos/uploads/*` returns it. */
export type UploadRow = {
  id: string
  bytes_received: number
  next_part: number
  /** `open`, `finalizing`, `finalized` (uploaded, not yet a video), `used`
   *  or `abandoned`. */
  status: string
  duration_ms: number | null
  created_at: string
  updated_at: string
  /** 'recording' from the recorder, 'upload' for a picked video file. */
  source?: 'recording' | 'upload'
  /** Picked files: the file's name and size. */
  name?: string | null
  size?: number | null
  /** Picked files while finishing: 'checking' | 'converting' | 'saving'. */
  phase?: string | null
  /** Picked files while converting: 0–100. */
  progress?: number | null
  /** Why a picked file was not kept (`abandoned`), or why saving failed (`open`). */
  error?: string | null
  error_code?: string | null
}

export type { RecordedClick }

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
        /** Viewers may download (authors always may). */
        allow_downloads?: boolean
      }
    ) => r(patch<{ data: HelpVideoDto }>(`/help-videos/${id}`, body)).then((x) => x.data),
    /** A fresh ticketed download link (relative to the API origin). 403
     *  HELP_VIDEO_DOWNLOAD_OFF when downloads are off for this viewer; `draft`
     *  is for authors. */
    downloadLink: (
      id: string,
      file: 'video' | 'captions.vtt' | 'captions.srt' = 'video',
      draft = false
    ) =>
      r(
        get<{ data: { url: string } }>(`/help-videos/${id}/download-link`, {
          file,
          ...(draft ? { draft: 1 } : {})
        })
      ).then((x) => x.data.url),
    setContexts: (id: string, contexts: HelpVideoContext[]) =>
      r(put(`/help-videos/${id}/contexts`, { contexts })),
    setRequirements: (id: string, role_ids: string[]) =>
      r(put(`/help-videos/${id}/requirements`, { role_ids })),
    archive: (id: string) => r(del(`/help-videos/${id}`)),
    /** Deletes the video, its versions, files, views and requirements for good. Administrators
     *  only (403 ADMIN_ONLY otherwise); 404 when it is already gone. */
    purge: (id: string) => r(del(`/help-videos/${id}?purge=1`)),
    draft: (id: string) =>
      r(get<{ data: VersionDto }>(`/help-videos/${id}/draft/edits`)).then((x) => x.data),
    /** 409 HELP_VIDEO_EDITS_CONFLICT (with `current_hash`) when `base_hash` is stale;
     *  422 HELP_VIDEO_EDITS_INVALID when the edits keep under a second. */
    saveDraft: (id: string, edits: VideoEdits, base_hash?: string) =>
      r(put<{ data: VersionDto }>(`/help-videos/${id}/draft/edits`, { edits, base_hash })).then(
        (x) => x.data
      ),
    publish: (id: string, watch_again: boolean, note?: string) =>
      r(
        post<{ data: HelpVideoDto }>(`/help-videos/${id}/publish`, {
          watch_again,
          ...(note?.trim() ? { note: note.trim() } : {})
        })
      ).then((x) => x.data),
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
    /** Opens an upload for a video file someone picked. The server ignores the
     *  browser's type: the first part's bytes decide the container (MP4/MOV or
     *  WebM; 422 UPLOAD_NOT_VIDEO otherwise). 503 UPLOAD_NO_FFMPEG when the
     *  server cannot read videos, 413 past 1.2 GB. */
    openFileUpload: (file: { name: string; size: number; type: string }) =>
      r(
        post<{ data: { id: string; next_part: number } }>('/help-videos/uploads', {
          mime: file.type,
          source: 'upload',
          name: file.name,
          size: file.size
        })
      ).then((x) => x.data),
    /** Closes a picked file's upload. The server checks (and if needed
     *  converts) it in the background: poll uploadStatus until `finalized`. */
    finalizeFileUpload: (id: string) =>
      r(post<{ data: unknown }>(`/help-videos/uploads/${id}/finalize`, {})),
    uploadStatus: (id: string) =>
      r(get<{ data: UploadRow }>(`/help-videos/uploads/${id}`)).then((x) => x.data),
    /**
     * Closes an upload and stores the recorder's data with it, as given.
     * - `duration_ms`: recording time without pauses (the server prefers its
     *   own probe of the file; 0 when unknown).
     * - `clicks`: `{ t_ms, x, y }` per click on the recorded tab: `t_ms` is
     *   recording time, `x`/`y` are fractions (0–1) of the captured frame;
     *   plus what was clicked (label, role, hook, page_key, path, origin —
     *   see RecordedClick). Null when clicks were not captured.
     * - `levels`: microphone loudness, one number from 0 (silence) to 1 every
     *   100 ms of recording time (10 per second), so `levels[i]` covers
     *   `i * 100` ms. Null without a microphone.
     * - `activity` (optional): `{ kind: 'typing' | 'idle', start_ms, end_ms }`
     *   spans on the recorded tab — never what was typed. Null when not captured.
     * - `script` and `marks` (optional, #1491): the steps the author wrote
     *   before recording (≤ 60 of ≤ 200 chars) and `{ t_ms, step }` per Next
     *   press, in recording time; the first draft gets a chapter per marked
     *   step (the first at 0) and keeps the script for a re-record.
     * Matches `HelpVideoVersion.clicks` / `.levels` in @nivaro/sdk.
     * 422 UPLOAD_TOO_LONG past 31 minutes, 409 UPLOAD_CLOSED when finished.
     */
    finalizeUpload: (
      id: string,
      meta: {
        duration_ms: number
        clicks: RecordedClick[] | null
        levels: number[] | null
        activity?: ActivitySpan[] | null
        script?: string[] | null
        marks?: RecordedMark[] | null
      }
    ) =>
      r(
        post<{ data: { file_id: string; duration_ms: number | null } }>(
          `/help-videos/uploads/${id}/finalize`,
          meta
        )
      ).then((x) => x.data),
    myUploads: () => r(get<{ data: UploadRow[] }>('/help-videos/uploads/mine')).then((x) => x.data),
    abandonUpload: (id: string) => r(del(`/help-videos/uploads/${id}`)),
    /** The published version's walk steps (none for a draft-only video). */
    walk: (id: string) =>
      r(
        get<{ data: { version_id: string | null; steps: WalkStep[] } }>(`/help-videos/${id}/walk`)
      ).then((x) => x.data),
    /** The music library: generated tracks, then any an administrator added. */
    musicLibrary: () => r(get<{ data: MusicTrack[] }>('/help-videos/music')).then((x) => x.data),
    /** Music files uploaded to this video, newest first. */
    videoMusic: (id: string) =>
      r(get<{ data: UploadedMusic[] }>(`/help-videos/${id}/music`)).then((x) => x.data),
    /** 409 MUSIC_IN_USE while any version of the video uses it. */
    deleteMusic: (id: string, musicId: string) => r(del(`/help-videos/${id}/music/${musicId}`)),
    /** CC0 / public-domain audio on Openverse (the server searches). 429
     *  OPENVERSE_BUSY when Openverse limits searches, 502 when unreachable. */
    searchOpenverse: (q: string, page = 1) =>
      r(
        get<{ data: OpenverseSearch }>(
          `/help-videos/music/openverse?q=${encodeURIComponent(q)}&page=${page}`
        )
      ).then((x) => x.data),
    /** Imports an Openverse track as this video's music (the same track twice
     *  is kept once). 422 OPENVERSE_LICENSE when it is no longer CC0. */
    importOpenverse: (id: string, openverseId: string) =>
      r(
        post<{ data: UploadedMusic }>(`/help-videos/${id}/music/openverse`, {
          openverse_id: openverseId
        })
      ).then((x) => x.data),
    registerPage: (key: string, label: string, app?: string) =>
      r(post('/help-videos/pages', { key, label, app })),
    authorRoles: () =>
      r(get<{ data: { help_video_author_roles?: unknown } }>('/settings')).then((x) =>
        parseRoleIdList(x.data?.help_video_author_roles)
      ),
    setAuthorRoles: (ids: string[]) => r(patch('/settings', { help_video_author_roles: ids }))
  }
}

/**
 * Uploads an audio file as this video's music (multipart: the SDK's request
 * sends JSON only). The server converts it to AAC; 422 MUSIC_NOT_AUDIO /
 * MUSIC_TOO_LONG, 413 MUSIC_TOO_LARGE (40 MB), 503 MUSIC_NO_FFMPEG.
 */
export async function uploadMusicFile(
  cfg: { apiBase: string; authHeaders?: Record<string, string>; credentials?: RequestCredentials },
  videoId: string,
  file: File
): Promise<UploadedMusic> {
  const body = new FormData()
  body.append('file', file, file.name)
  const res = await fetch(`${cfg.apiBase}/help-videos/${encodeURIComponent(videoId)}/music`, {
    method: 'POST',
    headers: cfg.authHeaders,
    credentials: cfg.credentials,
    body
  })
  const json = (await res.json().catch(() => ({}))) as {
    data?: UploadedMusic
    error?: string
    message?: string
    code?: string
  }
  if (!res.ok || !json.data) {
    // Thrown route errors carry the sentence in `message` (`error` is the
    // status text); our own answers carry it in `error`.
    const said = json.message || json.error
    throw Object.assign(new Error(said || 'The music could not be uploaded'), {
      status: res.status,
      code: json.code
    })
  }
  return json.data
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

/** The instance brand the intro/outro cards and chapter banners are drawn in
 *  (the public login branding: name, colour, logo). `origin` turns the
 *  logo's API path into a URL the player's <img> can load. Only fetched while
 *  the video has a card or banner on. */
/** Public branding as the cards see it (GET /auth/branding). */
export interface CardBranding {
  name: string | null
  color: string | null
  logo_url: string | null
  /** The cards' own logo, else the instance logo (absent on older servers). */
  card_logo_url?: string | null
}

/** The cards draw their own logo; the instance logo is only the fallback. */
export function cardBrandFrom(d: CardBranding | undefined, origin: string): CardBrand {
  const logo = d ? (d.card_logo_url ?? d.logo_url) : null
  return {
    name: d?.name?.trim() || null,
    color: cardAccent(d?.color),
    logo: logo ? `${origin}${logo}` : null
  }
}

export function useCardBrand(enabled: boolean, origin: string): CardBrand {
  const client = useNivaroClient()
  const q = useQuery({
    queryKey: ['help-video-card-brand'],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: () => client.request(get<{ data: CardBranding }>('/auth/branding'))
  })
  return cardBrandFrom(q.data?.data, origin)
}
