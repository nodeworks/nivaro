import { Clapperboard, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/utils'
import { useScreenCapture } from '../help-videos/recorder/useScreenCapture'

/**
 * Screen clips in the composer (#2458): up to 60 s of screen (and microphone),
 * recorded with the help-video recorder's own browser capture
 * (useScreenCapture) and sent as an ORDINARY chat attachment — a plain
 * nivaro_files row, never a help-video upload. A poster frame is drawn from
 * the recording and uploaded beside it; the message plays the clip inline.
 *
 * The clip file's tags tie the pieces together (`chat-clip`, `poster:<id>`,
 * `duration:<ms>`), so the renderer needs no table and the file manager still
 * says what the file is.
 */

export const CLIP_MAX_MS = 60_000
export const CLIP_TAG = 'chat-clip'
export const CLIP_POSTER_TAG = 'chat-clip-poster'

export interface ClipInfo {
  poster: string | null
  durationMs: number | null
}

/** Reads the clip facts back from a file's tags (null = not a clip). */
export function clipInfo(tags: unknown, type: string | null | undefined): ClipInfo | null {
  const list = Array.isArray(tags) ? tags.map(String) : []
  if (!list.includes(CLIP_TAG)) return null
  if (type && !type.startsWith('video/')) return null
  const poster = list.find((t) => t.startsWith('poster:'))?.slice(7) ?? null
  const dur = Number(list.find((t) => t.startsWith('duration:'))?.slice(9))
  return {
    poster: poster && /^[0-9a-f-]{36}$/i.test(poster) ? poster : null,
    durationMs: dur > 0 ? dur : null
  }
}

export function clipTags(posterId: string | null, durationMs: number): string[] {
  const tags = [CLIP_TAG, `duration:${Math.max(0, Math.round(durationMs))}`]
  if (posterId) tags.push(`poster:${posterId}`)
  return tags
}

export function clipFileName(at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `Screen clip ${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}.${p(at.getMinutes())}.${p(at.getSeconds())}.webm`
}

export function formatClipLength(ms: number | null): string {
  if (!ms) return ''
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Can this browser record a clip at all? (No getDisplayMedia → the button never renders.) */
export function canRecordClip(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getDisplayMedia &&
    typeof MediaRecorder !== 'undefined'
  )
}

/** A still from the first readable frame of a recorded blob, as PNG (null when the browser cannot decode it). */
export async function posterFromBlob(blob: Blob, maxWidth = 640): Promise<Blob | null> {
  if (typeof document === 'undefined') return null
  const url = URL.createObjectURL(blob)
  try {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.src = url
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout')), 4000)
      video.onloadeddata = () => {
        clearTimeout(t)
        res()
      }
      video.onerror = () => {
        clearTimeout(t)
        rej(new Error('decode'))
      }
    })
    // A WebM straight from MediaRecorder has no duration; the first frame is enough.
    if (video.currentTime === 0 && Number.isFinite(video.duration)) {
      video.currentTime = Math.min(0.2, video.duration / 2)
      await new Promise<void>((res) => {
        video.onseeked = () => res()
        setTimeout(res, 800)
      })
    }
    const w = video.videoWidth || 640
    const h = video.videoHeight || 360
    const scale = Math.min(1, maxWidth / w)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(w * scale)
    canvas.height = Math.round(h * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

export interface RecordedClip {
  file: File
  poster: Blob | null
  durationMs: number
}

/**
 * The composer's clip button: one click asks what to share, records straight
 * away (no countdown — the clip is a quick "look at this"), and stops at 60 s
 * or on Stop. While recording the button becomes the clock.
 */
export function ScreenClipButton({
  onClip,
  disabled
}: {
  onClip: (clip: RecordedClip) => void
  disabled?: boolean
}) {
  const [phase, setPhase] = useState<'idle' | 'asking' | 'recording' | 'finishing'>('idle')
  const chunks = useRef<Blob[]>([])
  const mime = useRef('video/webm')
  const stopping = useRef(false)
  const stopRef = useRef<() => void>(() => {})
  const cap = useScreenCapture({
    onLimit: () => stopRef.current(),
    onSharingEnded: () => stopRef.current()
  })

  const stop = async () => {
    if (stopping.current || !cap.isLive()) return
    stopping.current = true
    setPhase('finishing')
    const durationMs = Math.min(CLIP_MAX_MS, cap.meta().duration_ms)
    await cap.halt()
    const blob = new Blob(chunks.current, { type: mime.current })
    chunks.current = []
    const poster = blob.size ? await posterFromBlob(blob) : null
    if (blob.size) {
      onClip({ file: new File([blob], clipFileName(), { type: mime.current }), poster, durationMs })
    }
    setPhase('idle')
    stopping.current = false
  }
  stopRef.current = () => void stop()

  // The 60 s cap: the recorder's own limit is 30 min, so the clock is ours.
  const elapsed = cap.elapsed
  useEffect(() => {
    if (phase === 'recording' && elapsed >= CLIP_MAX_MS) stopRef.current()
  }, [elapsed, phase])

  const start = async () => {
    if (phase !== 'idle') return
    setPhase('asking')
    cap.reset()
    chunks.current = []
    try {
      mime.current = await cap.acquire({ source: 'screen', useMic: true, micId: 'default' })
    } catch {
      cap.release()
      setPhase('idle')
      return
    }
    cap.arm(mime.current, (b) => {
      if (b.size) chunks.current.push(b)
    })
    cap.begin(false)
    setPhase('recording')
  }

  if (!canRecordClip()) return null

  if (phase === 'recording' || phase === 'finishing') {
    const left = Math.max(0, CLIP_MAX_MS - cap.elapsed)
    const pct = Math.min(100, (cap.elapsed / CLIP_MAX_MS) * 100)
    return (
      <button
        type='button'
        onClick={() => void stop()}
        disabled={phase === 'finishing'}
        className='relative flex h-7 shrink-0 items-center gap-1.5 overflow-hidden rounded-md border border-red-300 bg-red-50 px-2 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-60 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200 dark:hover:bg-red-500/20'
        aria-label={phase === 'finishing' ? 'Finishing the clip' : 'Stop recording the clip'}
        data-chat-clip={phase}
      >
        <span
          className='absolute inset-y-0 left-0 bg-red-200/60 transition-[width] duration-200 ease-linear dark:bg-red-500/20'
          style={{ width: `${pct}%` }}
          aria-hidden
        />
        <span className='relative flex h-2 w-2'>
          <span className='absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-60 motion-safe:animate-ping' />
          <span className='relative inline-flex h-2 w-2 rounded-full bg-red-500' />
        </span>
        <span className='relative tabular-nums'>
          {phase === 'finishing' ? 'Saving…' : `${Math.ceil(left / 1000)} s left`}
        </span>
        <Square className='relative h-3 w-3 fill-current' strokeWidth={2} />
      </button>
    )
  }

  return (
    <button
      type='button'
      onClick={() => void start()}
      disabled={disabled || phase === 'asking'}
      className={cn(
        'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-40 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-slate-100',
        phase === 'asking' && 'text-nvr-cyan'
      )}
      aria-label='Record a screen clip (up to 60 seconds)'
      title='Record a screen clip — up to 60 s, with your microphone'
      data-chat-clip='idle'
    >
      <Clapperboard className='h-4 w-4' strokeWidth={2} />
    </button>
  )
}

/** Inline playback of a clip attachment: poster first, controls on demand. */
export function ClipPlayer({
  url,
  poster,
  name,
  durationMs,
  action
}: {
  url: string
  poster: string | null
  name: string
  durationMs: number | null
  /** An overlay control (attach to record…), top right. */
  action?: React.ReactNode
}) {
  return (
    <span className='relative inline-block max-w-[320px]' data-chat-clip-player>
      {/* biome-ignore lint/a11y/useMediaCaption: a screen recording made seconds ago has no captions */}
      <video
        src={url}
        poster={poster ?? undefined}
        controls
        playsInline
        preload={poster ? 'none' : 'metadata'}
        className='block max-h-[220px] w-full rounded-lg border border-slate-200 bg-[#0f172a] dark:border-border'
        aria-label={name}
      />
      <span className='pointer-events-none absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium text-white'>
        <Clapperboard className='h-3 w-3' strokeWidth={2} />
        Clip{durationMs ? ` · ${formatClipLength(durationMs)}` : ''}
      </span>
      {action && <span className='absolute right-1 top-1'>{action}</span>}
    </span>
  )
}
