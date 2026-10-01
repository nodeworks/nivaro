import { Circle, Download, FileWarning, Video } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { register } from '../registry/registry'
import { toolbarItems } from '../registry/toolbarItems'
import { BTN, errorOf } from './shared'
import { useFrozenSnapshotId } from './snapshots'

/**
 * #1165 — capture the last 30 seconds of the flow map as a WebM, client-side
 * (MediaRecorder on canvas.captureStream). Nothing records until the capture is armed; while it
 * is, two recorders run staggered by SEGMENT_MS / 2 and restart every SEGMENT_MS, so one of them
 * always holds at least the last 30 seconds (and at most a minute) as a complete file. Download
 * it, or attach it to a new issue (uploaded as a file + a still of the canvas).
 */
const SEGMENT_MS = 60_000
const FPS = 15
const MIME = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']

export function captureSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as { MediaRecorder?: unknown }).MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    'captureStream' in HTMLCanvasElement.prototype
  )
}
function mimeType(): string {
  const MR = (window as unknown as { MediaRecorder: typeof MediaRecorder }).MediaRecorder
  return MIME.find((m) => MR.isTypeSupported?.(m)) ?? 'video/webm'
}

interface Seg {
  rec: MediaRecorder
  chunks: Blob[]
  started: number
}

/** The recorder that has run longest (≥ 30 s once armed for 30 s). */
export function longestRunning<T extends { started: number }>(segs: T[]): T | null {
  return segs.reduce<T | null>((best, s) => (!best || s.started < best.started ? s : best), null)
}

function Capture() {
  const frozen = useFrozenSnapshotId()
  const [armed, setArmed] = useState(false)
  const [armedAt, setArmedAt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [, setTick] = useState(0)
  const segs = useRef<Seg[]>([])
  const timers = useRef<Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>>([])

  const stopAll = () => {
    for (const t of timers.current) clearTimeout(t as ReturnType<typeof setTimeout>)
    for (const t of timers.current) clearInterval(t as ReturnType<typeof setInterval>)
    timers.current = []
    for (const s of segs.current) if (s.rec.state !== 'inactive') s.rec.stop()
    segs.current = []
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: stop every recorder on unmount only
  useEffect(() => stopAll, [])

  const startSeg = (canvas: HTMLCanvasElement) => {
    const stream = canvas.captureStream(FPS)
    const rec = new MediaRecorder(stream, { mimeType: mimeType(), videoBitsPerSecond: 1_500_000 })
    const seg: Seg = { rec, chunks: [], started: Date.now() }
    rec.ondataavailable = (e) => {
      if (e.data.size) seg.chunks.push(e.data)
    }
    rec.start(1000)
    segs.current.push(seg)
    // a segment runs SEGMENT_MS, then starts over
    const t = setTimeout(() => {
      segs.current = segs.current.filter((x) => x !== seg)
      if (rec.state !== 'inactive') rec.stop()
      for (const tr of stream.getTracks()) tr.stop()
      if (canvas.isConnected) startSeg(canvas)
    }, SEGMENT_MS)
    timers.current.push(t)
  }

  const arm = () => {
    const canvas = document.getElementById('tm-canvas') as HTMLCanvasElement | null
    if (!canvas || !captureSupported()) {
      toast.error('This browser cannot record the canvas')
      return
    }
    try {
      startSeg(canvas)
      timers.current.push(setTimeout(() => startSeg(canvas), SEGMENT_MS / 2))
      timers.current.push(setInterval(() => setTick((n) => n + 1), 1000))
      setArmed(true)
      setArmedAt(Date.now())
    } catch (e) {
      stopAll()
      toast.error(`Could not start the capture: ${errorOf(e)}`)
    }
  }
  const disarm = () => {
    stopAll()
    setArmed(false)
  }

  /** The longest-running segment as a finished file (the recorder restarts after). */
  const take = async (): Promise<Blob | null> => {
    const seg = longestRunning(segs.current)
    if (!seg) return null
    await new Promise<void>((resolve) => {
      seg.rec.addEventListener('dataavailable', () => resolve(), { once: true })
      seg.rec.requestData()
    })
    return new Blob(seg.chunks, { type: 'video/webm' })
  }
  const name = () => `traffic-map-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`

  const download = async () => {
    setBusy(true)
    try {
      const blob = await take()
      if (!blob?.size) return void toast.error('Nothing recorded yet')
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name()
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } finally {
      setBusy(false)
    }
  }
  const attach = async () => {
    setBusy(true)
    try {
      const blob = await take()
      if (!blob?.size) return void toast.error('Nothing recorded yet')
      const fd = new FormData()
      fd.append('file', new File([blob], name(), { type: 'video/webm' }))
      const up = await api.post('/files/upload', fd, { headers: { 'Content-Type': undefined } })
      const fileId = (up.data.data as { id: string }).id
      const canvas = document.getElementById('tm-canvas') as HTMLCanvasElement | null
      let still: string | null = null
      try {
        still = canvas?.toDataURL('image/jpeg', 0.7) ?? null
        if (still && still.length > 2_400_000) still = null
      } catch {
        still = null
      }
      const res = await api.post('/issues', {
        title: 'Traffic Map capture',
        severity: 'medium',
        details: `A capture of the Traffic Map flow (the last ${Math.round((Date.now() - (longestRunning(segs.current)?.started ?? Date.now())) / 1000)} seconds).\nVideo: ${window.location.origin}/api/files/${fileId}?download=1\nPage: ${window.location.href}`,
        screenshot: still
      })
      const id = (res.data.data as { id?: number } | undefined)?.id
      toast.success(id ? `Issue #${id} raised with the capture` : 'Issue raised with the capture')
    } catch (e) {
      toast.error(`Could not attach the capture: ${errorOf(e)}`)
    } finally {
      setBusy(false)
    }
  }

  if (frozen) return null
  const held = armed ? Math.min(60, Math.round((Date.now() - armedAt) / 1000)) : 0
  if (!armed)
    return (
      <button
        type='button'
        id='tm-capture'
        className={BTN}
        onClick={arm}
        disabled={!captureSupported()}
        title='Keep a rolling recording of the flow map so the last 30 seconds can be saved'
      >
        <Video className='h-3.5 w-3.5' aria-hidden='true' />
        Record
      </button>
    )
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          id='tm-capture'
          className={cn(BTN, 'border-[var(--tm-error)] text-[var(--tm-error-ink)]')}
          aria-label={`Recording, ${held} seconds held`}
        >
          <Circle
            className='h-2.5 w-2.5 fill-current motion-safe:animate-pulse'
            aria-hidden='true'
          />
          Recording <span className='tabular-nums'>{Math.min(held, 30)}s</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[280px] p-3'>
        <div className='traffic-map grid gap-2 text-[12px] text-[var(--tm-fg)]'>
          <p className='text-[var(--tm-fg-2)]'>
            {held < 30
              ? `Holding ${held} seconds so far; it keeps up to the last minute.`
              : 'Holding the last 30 seconds (up to a minute).'}{' '}
            Nothing leaves the browser until you save or attach it.
          </p>
          <div className='flex flex-wrap gap-1.5'>
            <button
              type='button'
              className={BTN}
              disabled={busy}
              onClick={() => void download()}
              id='tm-capture-download'
            >
              <Download className='h-3.5 w-3.5' aria-hidden='true' />
              Download
            </button>
            <button
              type='button'
              className={BTN}
              disabled={busy}
              onClick={() => void attach()}
              id='tm-capture-issue'
            >
              <FileWarning className='h-3.5 w-3.5' aria-hidden='true' />
              Attach to a new issue
            </button>
            <button type='button' className={BTN} onClick={disarm} id='tm-capture-stop'>
              Stop recording
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

register(toolbarItems, { id: 'capture', order: 70, slot: 'actions', Component: Capture })
