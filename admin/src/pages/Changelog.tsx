import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Package, PlayCircle, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn, formatDate } from '@/lib/utils'

/**
 * What shipped, release by release.
 *
 * Sourced from the tags themselves (changelog.json, generated at build time),
 * so it cannot drift from what was actually released — and the running build is
 * marked, which is the question people usually arrive with: "is the fix I was
 * promised in the thing I am looking at?"
 */

interface Entry {
  section: string
  scope: string | null
  text: string
  hash: string | null
}
interface Release {
  version: string
  tag: string
  date: string
  count: number
  sections: Array<{ label: string; entries: Entry[] }>
}

interface ReleaseVideo {
  version: string
  video: {
    id: string
    title: string
    duration_ms: number | null
    start_ms: number
    path: string
    poster_url: string | null
  }
}

function clock(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** The release's video card, and for administrators the control to attach one. */
function ReleaseVideoRow({
  version,
  video,
  isAdmin
}: {
  version: string
  video: ReleaseVideo['video'] | undefined
  isAdmin: boolean
}) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [videoId, setVideoId] = useState(video?.id ?? '')
  const [at, setAt] = useState(video ? String(Math.floor(video.start_ms / 1000) || '') : '')
  const { data: videos = [] } = useQuery({
    queryKey: ['help-videos', 'published-pick'],
    enabled: isAdmin && editing,
    queryFn: () =>
      api
        .get<{ data: Array<{ id: string; title: string; duration_ms: number | null }> }>(
          '/help-videos',
          { params: { status: 'published', page: 1 } }
        )
        .then((r) => r.data.data ?? [])
  })
  const refresh = () => qc.invalidateQueries({ queryKey: ['help-videos', 'releases'] })
  const save = useMutation({
    mutationFn: () =>
      videoId
        ? api.put(`/help-videos/releases/${encodeURIComponent(version)}`, {
            video_id: videoId,
            t_ms: Number(at) > 0 ? Math.round(Number(at) * 1000) : null
          })
        : api.delete(`/help-videos/releases/${encodeURIComponent(version)}`),
    onSuccess: () => {
      setEditing(false)
      void refresh()
    }
  })
  return (
    <div className='border-b border-slate-100 px-4 py-2.5' data-changelog-video={version}>
      {video && !editing && (
        <Link
          to={video.path}
          className='flex max-w-[460px] items-stretch gap-3 overflow-hidden rounded-lg border border-slate-200 bg-white text-left hover:bg-slate-50'
          aria-label={`Watch: ${video.title}`}
          data-changelog-video-card={video.id}
        >
          <span className='relative block w-[132px] shrink-0 bg-slate-100'>
            {video.poster_url && (
              <img src={video.poster_url} alt='' className='h-full w-full object-cover' />
            )}
            <span className='absolute inset-0 grid place-content-center'>
              <PlayCircle className='h-7 w-7 text-white drop-shadow' aria-hidden />
            </span>
          </span>
          <span className='flex min-w-0 flex-1 flex-col justify-center py-1.5 pr-3'>
            <span className='truncate text-[12.5px] font-medium text-slate-800'>{video.title}</span>
            <span className='text-[11px] text-slate-500'>
              {[
                'Video',
                clock(video.duration_ms),
                video.start_ms > 0 ? `starts at ${clock(video.start_ms)}` : null
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
        </Link>
      )}
      {isAdmin && !editing && (
        <button
          type='button'
          onClick={() => setEditing(true)}
          className='mt-1.5 text-[11.5px] text-slate-500 underline decoration-dotted underline-offset-2 hover:text-slate-700'
          data-changelog-video-edit={version}
        >
          {video ? 'Change the video' : 'Attach a video'}
        </button>
      )}
      {isAdmin && editing && (
        <div className='flex flex-wrap items-center gap-2 text-[12px]'>
          <select
            value={videoId}
            onChange={(e) => setVideoId(e.target.value)}
            className='h-7 max-w-[320px] rounded-md border border-slate-200 bg-white px-1.5 text-[12px]'
            aria-label={`Video for ${version}`}
            data-changelog-video-pick={version}
          >
            <option value=''>No video</option>
            {(
              [
                ...(video && !videos.some((v) => v.id === video.id)
                  ? [{ id: video.id, title: video.title, duration_ms: video.duration_ms }]
                  : []),
                ...videos
              ] as Array<{ id: string; title: string; duration_ms: number | null }>
            ).map((v) => (
              <option key={v.id} value={v.id}>
                {v.title || 'Untitled video'}
                {v.duration_ms != null ? ` (${clock(v.duration_ms)})` : ''}
              </option>
            ))}
          </select>
          {videoId && (
            <label className='flex items-center gap-1 text-slate-500'>
              Start at
              <input
                type='number'
                min={0}
                value={at}
                onChange={(e) => setAt(e.target.value)}
                className='h-7 w-16 rounded-md border border-slate-200 bg-white px-1.5'
                aria-label='Start at (seconds)'
              />
              s
            </label>
          )}
          <button
            type='button'
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className='h-7 rounded-md bg-nvr-cyan px-2.5 text-[12px] font-medium text-white disabled:opacity-50'
            data-changelog-video-save={version}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          <button
            type='button'
            onClick={() => setEditing(false)}
            className='h-7 rounded-md border border-slate-200 px-2.5 text-[12px]'
          >
            Cancel
          </button>
          {save.isError && (
            <span role='alert' className='text-rose-700'>
              {(save.error as { response?: { data?: { error?: string } } })?.response?.data
                ?.error ?? 'It could not be saved.'}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

const SECTION_TONE: Record<string, string> = {
  Added: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  Fixed: 'bg-sky-50 text-sky-700 border-sky-200',
  Performance: 'bg-violet-50 text-violet-700 border-violet-200',
  Changed: 'bg-amber-50 text-amber-700 border-amber-200',
  Documentation: 'bg-slate-50 text-slate-600 border-slate-200',
  Other: 'bg-slate-50 text-slate-600 border-slate-200'
}

/** Numeric semver compare; anything unparseable sorts as 0. */
function cmpVersion(a: string, b: string): number {
  const pa = a
    .replace(/^v/, '')
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0)
  const pb = b
    .replace(/^v/, '')
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export default function Changelog() {
  // "What changed in this release" (#62): the API-update banner links here
  // with ?since=<the version this tab loaded against>&to=<served>, and the
  // releases in that window lead the page under their own band.
  const [params] = useSearchParams()
  const since = params.get('since')
  const to = params.get('to')
  const { data, isLoading } = useQuery({
    queryKey: ['changelog'],
    queryFn: () =>
      api
        .get<{ data: { releases: Release[]; running?: string; generated_at?: string | null } }>(
          '/changelog'
        )
        .then((r) => r.data.data),
    staleTime: 10 * 60_000
  })

  const releases = data?.releases ?? []
  const running = data?.running
  // A video per release (#1528b): everyone sees the ones they may watch;
  // administrators attach or clear them here.
  const { user } = useAuth()
  const isAdmin = !!user?.is_admin
  const { data: releaseVideos = [] } = useQuery({
    queryKey: ['help-videos', 'releases'],
    queryFn: () =>
      api
        .get<{ data: ReleaseVideo[] }>('/help-videos/releases')
        .then((r) => r.data.data ?? [])
        .catch(() => [] as ReleaseVideo[]),
    staleTime: 60_000
  })
  const videoByVersion = new Map(releaseVideos.map((r) => [r.version, r.video]))
  const inWindow = (v: string) =>
    !!since && cmpVersion(v, since) > 0 && (!to || cmpVersion(v, to) <= 0)
  const fresh = since ? releases.filter((r) => inWindow(r.version)) : []
  const freshCount = fresh.reduce((a, r) => a + (r.count ?? 0), 0)

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4'>
        <h1 className='text-[15px] font-semibold text-slate-900'>Changelog</h1>
        <p className='mt-0.5 text-[12px] text-slate-500'>
          Every released version, newest first, taken from the release tags.
          {running && (
            <>
              {' '}
              This instance is running <span className='font-medium text-slate-700'>{running}</span>
              .
            </>
          )}
        </p>
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 px-6 py-5'>
        {isLoading && <p className='text-[12px] text-slate-400'>Loading…</p>}

        {!isLoading && releases.length === 0 && (
          <p className='rounded-lg border border-dashed border-slate-200 bg-white px-4 py-8 text-center text-[12px] text-slate-400'>
            No releases recorded. changelog.json is generated at build time — run{' '}
            <span className='font-mono'>node scripts/build-changelog.mjs</span>.
          </p>
        )}

        <div className='mx-auto max-w-3xl space-y-4'>
          {since && (
            <div
              className='flex flex-wrap items-center gap-2 rounded-xl border border-nvr-cyan/40 bg-nvr-cyan/10 px-4 py-3 text-[12.5px] text-slate-800 dark:text-slate-100'
              data-changelog-since={since}
            >
              <Sparkles className='h-4 w-4 text-nvr-cyan' />
              <span className='font-semibold'>What changed since {since}</span>
              {to && <span className='text-slate-500 dark:text-slate-400'>→ {to}</span>}
              <span className='ml-auto text-[11.5px] text-slate-500 dark:text-slate-400'>
                {fresh.length === 0
                  ? 'No release notes recorded for that window yet'
                  : `${fresh.length} release${fresh.length === 1 ? '' : 's'} · ${freshCount} change${freshCount === 1 ? '' : 's'}`}
              </span>
            </div>
          )}
          {releases.map((r) => {
            const isRunning = running === r.version
            const isFresh = inWindow(r.version)
            return (
              <section
                key={r.tag}
                className={cn(
                  'overflow-hidden rounded-xl border bg-white',
                  isRunning ? 'border-nvr-cyan/50 ring-1 ring-nvr-cyan/20' : 'border-slate-200',
                  isFresh && 'border-nvr-cyan/40 bg-nvr-cyan/[0.04]'
                )}
                data-changelog-fresh={isFresh ? '1' : undefined}
              >
                <div className='flex items-center gap-2 border-b border-slate-100 px-4 py-2.5'>
                  <Package className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                  <span className='text-[13px] font-semibold text-slate-900'>{r.version}</span>
                  {isRunning && (
                    <span className='inline-flex items-center gap-1 rounded-full border border-nvr-cyan/40 bg-nvr-cyan/10 px-2 py-0.5 text-[10px] font-medium text-nvr-navy'>
                      <CheckCircle2 className='h-3 w-3' />
                      Running here
                    </span>
                  )}
                  {isFresh && !isRunning && (
                    <span className='inline-flex items-center gap-1 rounded-full border border-nvr-cyan/40 bg-nvr-cyan/10 px-2 py-0.5 text-[10px] font-medium text-nvr-navy'>
                      New since you loaded
                    </span>
                  )}
                  <span className='ml-auto text-[11px] text-slate-400'>
                    {r.date ? formatDate(r.date) : ''} · {r.count} change
                    {r.count === 1 ? '' : 's'}
                  </span>
                </div>
                {(videoByVersion.has(r.version) || isAdmin) && (
                  <ReleaseVideoRow
                    version={r.version}
                    video={videoByVersion.get(r.version)}
                    isAdmin={isAdmin}
                  />
                )}

                <div className='space-y-3 px-4 py-3'>
                  {r.sections.length === 0 && (
                    <p className='text-[12px] italic text-slate-400'>
                      No changes recorded beyond the release itself.
                    </p>
                  )}
                  {r.sections.map((s) => (
                    <div key={s.label}>
                      <span
                        className={cn(
                          'inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium',
                          SECTION_TONE[s.label] ?? SECTION_TONE.Other
                        )}
                      >
                        {s.label}
                      </span>
                      <ul className='mt-1.5 space-y-1'>
                        {s.entries.map((e, i) => (
                          <li
                            key={`${e.hash ?? i}`}
                            className='flex gap-2 text-[12.5px] leading-snug'
                          >
                            <span className='mt-[7px] h-1 w-1 shrink-0 rounded-full bg-slate-300' />
                            <span className='text-slate-700'>
                              {e.scope && (
                                <span className='font-mono text-[11px] text-slate-400'>
                                  {e.scope}{' '}
                                </span>
                              )}
                              {e.text}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}
