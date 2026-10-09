import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ExternalLink,
  Loader2,
  Music,
  Play,
  Plus,
  Search,
  Square,
  Trash2,
  Upload
} from 'lucide-react'
import { memo, useEffect, useId, useRef, useState } from 'react'
import { useApiFetchConfig, useNivaroClient } from '../../../context'
import { Button } from '../../ui/button'
import { Switch } from '../../ui/switch'
import { helpVideoApi, helpVideoError, uploadMusicFile } from '../api'
import { EDIT_LIMITS, setMusic } from '../edits'
import { musicTrackPath, previewMusic } from '../musicMix'
import type {
  MusicBed,
  MusicOrigin,
  MusicTrack,
  OpenverseTrack,
  UploadedMusic,
  VideoEdits
} from '../types'

const keys = {
  library: ['help-video-music', 'library'] as const,
  mine: (id: string) => ['help-video-music', 'video', id] as const,
  openverse: (q: string, page: number) => ['help-video-music', 'openverse', q, page] as const
}

/** Openverse's names for the sites it searches, as people know them. */
const SOURCE_NAMES: Record<string, string> = {
  freesound: 'Freesound',
  jamendo: 'Jamendo',
  wikimedia_audio: 'Wikimedia Commons',
  ccmixter: 'ccMixter'
}
const sourceName = (s: string | null) =>
  s ? (SOURCE_NAMES[s] ?? s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())) : null
const licenseName = (l: MusicOrigin['license']) => (l === 'pdm' ? 'Public domain' : 'CC0')

const clock = (ms: number) =>
  `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`

const row =
  'flex min-h-9 items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors duration-150 motion-reduce:transition-none'
const rowOn = 'border-nvr-cyan/60 bg-nvr-cyan/10'
const rowOff = 'border-border bg-background hover:bg-muted'

/**
 * Background music (#1547): a track from the library or a file of the
 * author's own, looped under the whole video, lowered while someone speaks.
 * Stores nothing while it is off. Each piece's share is set in the
 * Inspector (select a piece on the timeline).
 */
export const MusicPanel = memo(function MusicPanel({
  headless,
  videoId,
  edits,
  uploaded,
  hasLevels,
  onChange,
  onNote
}: {
  headless?: boolean
  videoId: string
  edits: VideoEdits
  /** The source is an uploaded video file (no microphone levels). */
  uploaded?: boolean
  /** The recording has microphone levels the preview can duck on. */
  hasLevels: boolean
  onChange: (e: VideoEdits, key?: string) => void
  onNote: (n: string | null) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const cfg = useApiFetchConfig()
  const headingId = useId()
  const ids = { on: useId(), vol: useId(), duck: useId() }
  const music = edits.music
  const library = useQuery({
    queryKey: keys.library,
    queryFn: () => helpVideoApi(client).musicLibrary(),
    staleTime: 5 * 60_000
  })
  const mine = useQuery({
    queryKey: keys.mine(videoId),
    queryFn: () => helpVideoApi(client).videoMusic(videoId),
    enabled: !!music
  })
  const [busy, setBusy] = useState<string | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  /** A Listen still waiting for its sound (a slow host takes a while). */
  const [loading, setLoading] = useState<string | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => () => stopRef.current?.(), [])

  // Free music (Openverse): a search the author runs, results imported on Use.
  const [findOpen, setFindOpen] = useState(false)
  const [draftQ, setDraftQ] = useState('')
  const [search, setSearch] = useState<{ q: string; page: number } | null>(null)
  const found = useQuery({
    queryKey: keys.openverse(search?.q ?? '', search?.page ?? 1),
    queryFn: () => helpVideoApi(client).searchOpenverse(search?.q ?? '', search?.page ?? 1),
    enabled: !!search?.q,
    staleTime: 10 * 60_000,
    retry: false
  })
  const foundError = found.error ? helpVideoError(found.error) : null

  const listen = (key: string, m: Pick<MusicBed, 'source' | 'track'> | { openverse: string }) => {
    stopRef.current?.()
    stopRef.current = null
    if (playing === key) {
      setPlaying(null)
      setLoading(null)
      return
    }
    setPlaying(key)
    setLoading(key)
    const path =
      'openverse' in m
        ? `/help-videos/music/openverse/${encodeURIComponent(m.openverse)}/preview`
        : musicTrackPath(videoId, m)
    stopRef.current = previewMusic(
      `${cfg.apiBase}${path}`,
      { headers: cfg.authHeaders, credentials: cfg.credentials },
      Math.max(0.3, music?.volume ?? EDIT_LIMITS.musicDefaultVolume),
      () => {
        setPlaying((p) => (p === key ? null : p))
        setLoading((p) => (p === key ? null : p))
      },
      10,
      () => setLoading((p) => (p === key ? null : p))
    )
  }

  const choose = (m: Pick<MusicBed, 'source' | 'track' | 'name'>) =>
    onChange(setMusic(edits, m), 'music:track')

  const turnOn = (on: boolean) => {
    if (!on) {
      stopRef.current?.()
      onChange(setMusic(edits, null))
      return
    }
    const first = library.data?.[0]
    if (!first) {
      onNote('The music library could not be loaded. Try again in a moment')
      return
    }
    onChange(setMusic(edits, { source: 'library', track: first.key, name: first.title }))
  }

  const upload = async (file: File) => {
    setBusy('upload')
    onNote(null)
    try {
      const m = await uploadMusicFile(cfg, videoId, file)
      await qc.invalidateQueries({ queryKey: keys.mine(videoId) })
      choose({ source: 'upload', track: m.id, name: m.name })
    } catch (err) {
      onNote((err as Error).message || 'The music could not be uploaded')
    } finally {
      setBusy(null)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const addFound = async (t: OpenverseTrack) => {
    setBusy(`ov:${t.id}`)
    onNote(null)
    try {
      const m = await helpVideoApi(client).importOpenverse(videoId, t.id)
      await qc.invalidateQueries({ queryKey: keys.mine(videoId) })
      choose({ source: 'upload', track: m.id, name: m.name })
    } catch (err) {
      const e = helpVideoError(err)
      onNote(
        e?.code === 'OPENVERSE_LICENSE'
          ? 'That track is no longer public domain, so it cannot be used'
          : e?.code === 'MUSIC_TOO_LARGE'
            ? 'That track is over 40 MB'
            : e?.code === 'MUSIC_TOO_LONG'
              ? 'That track is over 20 minutes'
              : 'That track could not be added. Try another one'
      )
    } finally {
      setBusy(null)
    }
  }

  const remove = async (m: UploadedMusic) => {
    setBusy(m.id)
    try {
      await helpVideoApi(client).deleteMusic(videoId, m.id)
      await qc.invalidateQueries({ queryKey: keys.mine(videoId) })
    } catch (err) {
      const e = helpVideoError(err)
      onNote(
        e?.code === 'MUSIC_IN_USE'
          ? 'An earlier version of this video still uses that file, so it stays'
          : 'The file could not be removed'
      )
    } finally {
      setBusy(null)
    }
  }

  const selected = (source: MusicBed['source'], track: string) =>
    music?.source === source && music.track === track.toLowerCase()

  return (
    <section className='space-y-3' aria-labelledby={headingId} data-hv-music>
      <div>
        <h3
          id={headingId}
          className={headless ? 'sr-only' : 'text-[13px] font-semibold text-foreground'}
        >
          Background music
        </h3>
        <p className='mt-1 text-[12px] leading-snug text-muted-foreground'>
          Plays under the whole video, cards included, and gets quieter while someone speaks.
        </p>
      </div>
      <div className='flex items-start justify-between gap-3'>
        <label htmlFor={ids.on} className='text-[12.5px] font-medium text-foreground'>
          Music
        </label>
        <Switch
          id={ids.on}
          checked={!!music}
          onCheckedChange={turnOn}
          className='mt-0.5 h-5 w-9 shrink-0 [&>span]:h-4 [&>span]:w-4 [&>span]:data-[state=checked]:translate-x-4'
          data-hv-music-toggle=''
        />
      </div>
      {music && (
        <div className='space-y-3 border-l border-border pl-3' data-hv-music-settings>
          <div className='space-y-1.5'>
            <p className='text-[12px] font-medium text-foreground'>Library</p>
            {library.isLoading && (
              <p className='text-[12px] text-muted-foreground'>Loading tracks…</p>
            )}
            <ul className='space-y-1'>
              {(library.data ?? []).map((t: MusicTrack) => (
                <li key={t.key} className='flex items-center gap-1'>
                  <button
                    type='button'
                    aria-pressed={selected('library', t.key)}
                    onClick={() => choose({ source: 'library', track: t.key, name: t.title })}
                    className={`${row} min-w-0 flex-1 ${selected('library', t.key) ? rowOn : rowOff}`}
                    data-hv-music-track={t.key}
                  >
                    <Music className='!size-3.5 shrink-0 text-muted-foreground' aria-hidden />
                    <span className='min-w-0'>
                      <span className='block truncate text-[12.5px] font-medium text-foreground'>
                        {t.title}
                      </span>
                      {t.description && (
                        <span className='block truncate text-[11.5px] text-muted-foreground'>
                          {t.description}
                        </span>
                      )}
                    </span>
                  </button>
                  <ListenButton
                    playing={playing === `lib:${t.key}`}
                    loading={loading === `lib:${t.key}`}
                    name={t.title}
                    onClick={() => listen(`lib:${t.key}`, { source: 'library', track: t.key })}
                  />
                </li>
              ))}
            </ul>
          </div>

          <div className='space-y-1.5' data-hv-music-find>
            {!findOpen ? (
              <Button
                size='sm'
                variant='outline'
                className='h-8 text-[12.5px]'
                onClick={() => setFindOpen(true)}
                data-hv-music-find-open
              >
                <Search className='!size-3.5' aria-hidden />
                Find free music
              </Button>
            ) : (
              <>
                <p className='text-[12px] font-medium text-foreground'>Free music</p>
                <form
                  className='flex gap-1'
                  onSubmit={(e) => {
                    e.preventDefault()
                    const q = draftQ.trim()
                    if (q) setSearch({ q, page: 1 })
                  }}
                >
                  <input
                    type='search'
                    value={draftQ}
                    onChange={(e) => setDraftQ(e.target.value)}
                    placeholder='Calm piano, upbeat, ambient…'
                    aria-label='Search free music'
                    maxLength={100}
                    // biome-ignore lint/a11y/noAutofocus: opened on purpose by the author
                    autoFocus
                    className='h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-[12.5px] text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
                    data-hv-music-find-input
                  />
                  <Button
                    type='submit'
                    size='sm'
                    variant='outline'
                    className='h-8 shrink-0 px-2.5 text-[12.5px]'
                    disabled={!draftQ.trim() || found.isFetching}
                    data-hv-music-find-go
                  >
                    {found.isFetching ? (
                      <Loader2
                        className='!size-3.5 animate-spin motion-reduce:animate-none'
                        aria-hidden
                      />
                    ) : (
                      'Search'
                    )}
                  </Button>
                </form>
                <p className='text-[11.5px] leading-snug text-muted-foreground'>
                  Public-domain sounds and music from{' '}
                  <a
                    href='https://openverse.org/'
                    target='_blank'
                    rel='noopener noreferrer'
                    className='underline underline-offset-2 hover:text-foreground'
                  >
                    Openverse
                  </a>
                  . Free to use, no credit needed.
                </p>
                {found.data && !found.data.enabled && (
                  <p className='text-[12px] text-muted-foreground'>
                    Free music search is switched off on this site.
                  </p>
                )}
                {foundError && (
                  <p className='text-[12px] text-muted-foreground' role='status'>
                    {foundError.code === 'OPENVERSE_BUSY'
                      ? 'Openverse is limiting searches right now. Try again in a minute.'
                      : 'Openverse could not be reached. Try again in a moment.'}
                  </p>
                )}
                {found.data?.enabled && search && !found.isFetching && (
                  <p className='sr-only' role='status'>
                    {found.data.results.length
                      ? `${found.data.results.length} results`
                      : 'No results'}
                  </p>
                )}
                {found.data?.enabled && found.data.results.length === 0 && !found.isFetching && (
                  <p className='text-[12px] text-muted-foreground'>
                    Nothing found for “{search?.q}”. Try fewer or broader words.
                  </p>
                )}
                <ul className='space-y-1' data-hv-music-find-results>
                  {(found.data?.results ?? []).map((t) => (
                    <li
                      key={t.id}
                      className='flex items-center gap-1'
                      data-hv-music-find-result={t.id}
                    >
                      <div className={`${row} min-w-0 flex-1 border-border bg-background`}>
                        <span className='min-w-0 flex-1'>
                          <span className='block truncate text-[12.5px] font-medium text-foreground'>
                            {t.title}
                          </span>
                          <span className='block truncate text-[11.5px] text-muted-foreground'>
                            {[
                              licenseName(t.license),
                              t.creator && `by ${t.creator}`,
                              sourceName(t.provider)
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </span>
                        {!!t.duration_ms && (
                          <span className='shrink-0 text-[11.5px] tabular-nums text-muted-foreground'>
                            {clock(t.duration_ms)}
                          </span>
                        )}
                      </div>
                      <ListenButton
                        playing={playing === `ov:${t.id}`}
                        loading={loading === `ov:${t.id}`}
                        name={t.title}
                        onClick={() => listen(`ov:${t.id}`, { openverse: t.id })}
                      />
                      <Button
                        size='sm'
                        variant='ghost'
                        className='h-8 w-8 shrink-0 px-0 text-muted-foreground'
                        aria-label={`Use ${t.title}`}
                        title='Use this track'
                        disabled={!!busy}
                        onClick={() => void addFound(t)}
                        data-hv-music-find-use={t.id}
                      >
                        {busy === `ov:${t.id}` ? (
                          <Loader2
                            className='!size-3.5 animate-spin motion-reduce:animate-none'
                            aria-hidden
                          />
                        ) : (
                          <Plus className='!size-3.5' aria-hidden />
                        )}
                      </Button>
                    </li>
                  ))}
                </ul>
                {search && found.data?.enabled && (found.data.page_count ?? 0) > 1 && (
                  <div className='flex items-center justify-between gap-2'>
                    <Button
                      size='sm'
                      variant='ghost'
                      className='h-7 px-2 text-[12px]'
                      disabled={search.page <= 1 || found.isFetching}
                      onClick={() => setSearch({ ...search, page: search.page - 1 })}
                    >
                      Previous
                    </Button>
                    <span className='text-[11.5px] tabular-nums text-muted-foreground'>
                      Page {search.page} of {found.data.page_count}
                    </span>
                    <Button
                      size='sm'
                      variant='ghost'
                      className='h-7 px-2 text-[12px]'
                      disabled={search.page >= (found.data.page_count ?? 1) || found.isFetching}
                      onClick={() => setSearch({ ...search, page: search.page + 1 })}
                      data-hv-music-find-next
                    >
                      Next
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>

          <div className='space-y-1.5'>
            <p className='text-[12px] font-medium text-foreground'>Your files</p>
            <ul className='space-y-1'>
              {(mine.data ?? []).map((m) => (
                <li key={m.id} className='flex items-center gap-1'>
                  <button
                    type='button'
                    aria-pressed={selected('upload', m.id)}
                    onClick={() => choose({ source: 'upload', track: m.id, name: m.name })}
                    className={`${row} min-w-0 flex-1 ${selected('upload', m.id) ? rowOn : rowOff}`}
                    data-hv-music-file={m.id}
                  >
                    <span className='min-w-0 flex-1'>
                      <span className='block truncate text-[12.5px] text-foreground'>{m.name}</span>
                      {m.origin && (
                        <span
                          className='block truncate text-[11.5px] text-muted-foreground'
                          data-hv-music-origin={m.origin.id}
                        >
                          {[
                            licenseName(m.origin.license),
                            m.origin.creator && `by ${m.origin.creator}`,
                            sourceName(m.origin.source)
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      )}
                    </span>
                    {m.duration_ms > 0 && (
                      <span className='shrink-0 text-[11.5px] tabular-nums text-muted-foreground'>
                        {clock(m.duration_ms)}
                      </span>
                    )}
                  </button>
                  <ListenButton
                    playing={playing === `up:${m.id}`}
                    loading={loading === `up:${m.id}`}
                    name={m.name}
                    onClick={() => listen(`up:${m.id}`, { source: 'upload', track: m.id })}
                  />
                  {m.origin?.landing_url && (
                    <a
                      href={m.origin.landing_url}
                      target='_blank'
                      rel='noopener noreferrer'
                      className='inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground'
                      aria-label={`Where ${m.name} comes from`}
                      title='Where it comes from'
                    >
                      <ExternalLink className='!size-3.5' aria-hidden />
                    </a>
                  )}
                  {!selected('upload', m.id) && (
                    <Button
                      size='sm'
                      variant='ghost'
                      className='h-8 w-8 shrink-0 px-0 text-muted-foreground'
                      aria-label={`Remove ${m.name}`}
                      title='Remove'
                      disabled={busy === m.id}
                      onClick={() => void remove(m)}
                      data-hv-music-remove={m.id}
                    >
                      <Trash2 className='!size-3.5' aria-hidden />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <input
              ref={fileRef}
              type='file'
              accept='audio/*,.mp3,.m4a,.wav,.ogg,.flac'
              className='sr-only'
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void upload(f)
              }}
              data-hv-music-input
            />
            <Button
              size='sm'
              variant='outline'
              className='h-8 text-[12.5px]'
              disabled={busy === 'upload'}
              onClick={() => fileRef.current?.click()}
              data-hv-music-upload
            >
              {busy === 'upload' ? (
                <Loader2
                  className='!size-3.5 animate-spin motion-reduce:animate-none'
                  aria-hidden
                />
              ) : (
                <Upload className='!size-3.5' aria-hidden />
              )}
              {busy === 'upload' ? 'Preparing the file…' : 'Upload music'}
            </Button>
            <p className='text-[11.5px] leading-snug text-muted-foreground'>
              MP3, M4A, WAV, OGG or FLAC, up to 40 MB and 20 minutes. Use music you have the rights
              to.
            </p>
          </div>

          <div className='space-y-1'>
            <div className='flex items-center justify-between'>
              <label htmlFor={ids.vol} className='text-[12px] font-medium text-foreground'>
                Volume
              </label>
              <span className='text-[12px] tabular-nums text-muted-foreground'>
                {Math.round(music.volume * 100)}%
              </span>
            </div>
            <input
              id={ids.vol}
              type='range'
              min={Math.round(EDIT_LIMITS.musicMinVolume * 100)}
              max={100}
              step={5}
              value={Math.round(music.volume * 100)}
              onChange={(e) =>
                onChange(setMusic(edits, { volume: Number(e.target.value) / 100 }), 'music:volume')
              }
              className='w-full accent-nvr-cyan-dark dark:accent-nvr-cyan'
              data-hv-music-volume
            />
          </div>

          <div className='flex items-start justify-between gap-3'>
            <div className='min-w-0'>
              <label htmlFor={ids.duck} className='text-[12.5px] font-medium text-foreground'>
                Quieter while someone speaks
              </label>
              <p
                id={`${ids.duck}-hint`}
                className='text-[11.5px] leading-snug text-muted-foreground'
              >
                {uploaded || !hasLevels
                  ? 'The preview plays the music at one level; the published video lowers it under the speech.'
                  : 'The preview follows the recorded microphone; the published video follows the sound itself.'}
              </p>
            </div>
            <Switch
              id={ids.duck}
              checked={music.duck}
              onCheckedChange={(on) => onChange(setMusic(edits, { duck: on }))}
              aria-describedby={`${ids.duck}-hint`}
              className='mt-0.5 h-5 w-9 shrink-0 [&>span]:h-4 [&>span]:w-4 [&>span]:data-[state=checked]:translate-x-4'
              data-hv-music-duck=''
            />
          </div>
          <p className='text-[11.5px] leading-snug text-muted-foreground'>
            To change the music under one part, select that piece on the timeline.
          </p>
        </div>
      )}
    </section>
  )
})

function ListenButton({
  playing,
  loading,
  name,
  onClick
}: {
  playing: boolean
  loading?: boolean
  name: string
  onClick: () => void
}) {
  return (
    <Button
      size='sm'
      variant='ghost'
      className='h-8 w-8 shrink-0 px-0 text-muted-foreground'
      aria-label={playing ? `Stop ${name}` : `Listen to ${name}`}
      aria-pressed={playing}
      title={loading ? 'Loading… (select to cancel)' : playing ? 'Stop' : 'Listen'}
      aria-busy={loading || undefined}
      onClick={onClick}
      data-hv-music-listen
      data-loading={loading ? '' : undefined}
    >
      {loading ? (
        <Loader2 className='!size-3.5 animate-spin motion-reduce:animate-none' aria-hidden />
      ) : playing ? (
        <Square className='!size-3.5' aria-hidden />
      ) : (
        <Play className='!size-3.5' aria-hidden />
      )}
    </Button>
  )
}
