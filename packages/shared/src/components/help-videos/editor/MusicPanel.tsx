import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Music, Play, Square, Trash2, Upload } from 'lucide-react'
import { memo, useEffect, useId, useRef, useState } from 'react'
import { useApiFetchConfig, useNivaroClient } from '../../../context'
import { Button } from '../../ui/button'
import { Switch } from '../../ui/switch'
import { helpVideoApi, helpVideoError, uploadMusicFile } from '../api'
import { EDIT_LIMITS, setMusic } from '../edits'
import { musicTrackPath, previewMusic } from '../musicMix'
import type { MusicBed, MusicTrack, UploadedMusic, VideoEdits } from '../types'

const keys = {
  library: ['help-video-music', 'library'] as const,
  mine: (id: string) => ['help-video-music', 'video', id] as const
}

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
  const stopRef = useRef<(() => void) | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => () => stopRef.current?.(), [])

  const listen = (key: string, m: Pick<MusicBed, 'source' | 'track'>) => {
    stopRef.current?.()
    stopRef.current = null
    if (playing === key) {
      setPlaying(null)
      return
    }
    setPlaying(key)
    stopRef.current = previewMusic(
      `${cfg.apiBase}${musicTrackPath(videoId, m)}`,
      { headers: cfg.authHeaders, credentials: cfg.credentials },
      Math.max(0.3, music?.volume ?? EDIT_LIMITS.musicDefaultVolume),
      () => setPlaying((p) => (p === key ? null : p))
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
                    name={t.title}
                    onClick={() => listen(`lib:${t.key}`, { source: 'library', track: t.key })}
                  />
                </li>
              ))}
            </ul>
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
                    <span className='min-w-0 flex-1 truncate text-[12.5px] text-foreground'>
                      {m.name}
                    </span>
                    {m.duration_ms > 0 && (
                      <span className='shrink-0 text-[11.5px] tabular-nums text-muted-foreground'>
                        {clock(m.duration_ms)}
                      </span>
                    )}
                  </button>
                  <ListenButton
                    playing={playing === `up:${m.id}`}
                    name={m.name}
                    onClick={() => listen(`up:${m.id}`, { source: 'upload', track: m.id })}
                  />
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
  name,
  onClick
}: {
  playing: boolean
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
      title={playing ? 'Stop' : 'Listen'}
      onClick={onClick}
      data-hv-music-listen
    >
      {playing ? (
        <Square className='!size-3.5' aria-hidden />
      ) : (
        <Play className='!size-3.5' aria-hidden />
      )}
    </Button>
  )
}
