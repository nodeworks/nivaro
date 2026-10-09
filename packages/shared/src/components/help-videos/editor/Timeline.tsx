import { Info, Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type { VideoEdits } from '../types'
import type { Stretch } from './suggestCuts'
import { clock, LANES, Lanes, type Selection } from './timeline/Lanes'
import { Playhead } from './timeline/Playhead'
import { laneLayout } from './timeline/packRows'
import { useBarDrag } from './timeline/useBarDrag'
import { waveformPath } from './timeline/waveform'

export type { Selection }

const RULER_H = 24
const SOUND_H = 32
const MAX_PX_PER_SEC = 200
/** Ruler label steps, in seconds; the first that leaves ≥ 64 px between labels wins. */
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

/** The editor timeline, laid out in SOURCE time: cut-away parts stay visible
 *  as hatched gaps, so trimming and re-including footage is direct. */
export function Timeline({
  edits,
  sourceMs,
  playheadSrcMs,
  levels,
  uploaded,
  silences,
  selection,
  onSelect,
  onSeek,
  onChange,
  note: noteProp,
  onNote
}: {
  edits: VideoEdits
  sourceMs: number
  playheadSrcMs: number
  levels: number[] | null
  /** The source is an uploaded file: there are no microphone levels to draw. */
  uploaded?: boolean
  /** Suggested silent stretches, shaded on the sound lane. */
  silences?: Stretch[]
  selection: Selection
  onSelect: (s: Selection) => void
  onSeek: (srcMs: number) => void
  onChange: (e: VideoEdits, key?: string) => void
  /** Controlled note (the editor routes its own refusals here too). Without
   *  `onNote` the timeline keeps its note itself. */
  note?: string | null
  onNote?: (n: string | null) => void
}) {
  const scroller = useRef<HTMLDivElement | null>(null)
  const [viewW, setViewW] = useState(0)
  const [pxPerSec, setPxPerSec] = useState<number | null>(null)
  // A change the server would refuse (overlapping zooms, too short) is not
  // applied; the reason shows here until the next interaction.
  const [ownNote, setOwnNote] = useState<string | null>(null)
  const note = onNote ? (noteProp ?? null) : ownNote
  const setNote = onNote ?? setOwnNote
  const hintId = useId()
  // Bars at the same moment stack on sub-rows; labels and lanes share it.
  const layout = useMemo(() => laneLayout(edits), [edits])

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () => setViewW(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // "Fit" shows the whole recording; it is also where the timeline opens.
  const fitPx = viewW > 0 && sourceMs > 0 ? Math.min(40, (viewW - 8) / (sourceMs / 1000)) : 40
  const pps = pxPerSec ?? fitPx
  const width = Math.max(viewW, (sourceMs / 1000) * pps + 8)
  const toPx = useCallback((ms: number) => (ms / 1000) * pps, [pps])
  const toMs = useCallback(
    (px: number) => Math.max(0, Math.min(sourceMs, (px / pps) * 1000)),
    [pps, sourceMs]
  )
  const zoomBy = (f: number) => setPxPerSec(Math.max(fitPx, Math.min(MAX_PX_PER_SEC, pps * f)))

  // True while a bar or the ruler is dragged: the playhead stops following.
  const dragging = useRef(false)
  const { drag, nudge } = useBarDrag({
    edits,
    sourceMs,
    pps,
    playheadSrcMs,
    dragging,
    onChange,
    onSelect,
    setNote
  })

  const scrub = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const el = e.currentTarget
    const seekAt = (clientX: number) => onSeek(toMs(clientX - el.getBoundingClientRect().left))
    seekAt(e.clientX)
    onSelect(null)
    setNote(null)
    el.setPointerCapture(e.pointerId)
    dragging.current = true
    const move = (ev: PointerEvent) => seekAt(ev.clientX)
    const up = () => {
      dragging.current = false
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const tickStep = (TICK_STEPS.find((s) => s * pps >= 64) ?? 600) * 1000
  const ticks = Array.from({ length: Math.floor(sourceMs / tickStep) + 1 }, (_, i) => i * tickStep)
  const wave = useMemo(
    () => (levels?.length ? waveformPath(levels, pps, SOUND_H) : ''),
    [levels, pps]
  )

  return (
    <section
      className='flex shrink-0 flex-col border-t border-border bg-card'
      aria-label='Timeline'
      data-hv-timeline
    >
      <div className='flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1'>
        <p
          className='flex min-w-0 flex-1 items-start gap-1.5 text-[12px] leading-snug text-amber-800 dark:text-amber-200'
          role='status'
          data-hv-timeline-note
        >
          {note && (
            <>
              <Info className='mt-px h-3.5 w-3.5 shrink-0' aria-hidden />
              <span>{note}</span>
            </>
          )}
        </p>
        <div className='ml-auto flex items-center gap-0.5'>
          <button
            type='button'
            className={zoomButton}
            onClick={() => zoomBy(1 / 1.6)}
            disabled={pps <= fitPx + 0.001}
            aria-label='Zoom out'
            data-hv-zoom-out
          >
            <ZoomOut className='h-4 w-4' />
          </button>
          <button
            type='button'
            className={zoomButton}
            onClick={() => zoomBy(1.6)}
            disabled={pps >= MAX_PX_PER_SEC}
            aria-label='Zoom in'
            data-hv-zoom-in
          >
            <ZoomIn className='h-4 w-4' />
          </button>
          <button
            type='button'
            className={`${zoomButton} w-auto gap-1 px-2 text-[12px]`}
            onClick={() => setPxPerSec(null)}
            disabled={pxPerSec === null}
            data-hv-zoom-fit
          >
            <Maximize2 className='h-3.5 w-3.5' aria-hidden />
            Fit
          </button>
        </div>
      </div>
      <p id={hintId} className='sr-only'>
        Left and Right arrows move along the lane. Alt with an arrow moves the item a tenth of a
        second, with Shift a whole second. Delete removes it.
      </p>
      <div className='flex border-t border-border'>
        <div className='w-[76px] shrink-0 border-r border-border sm:w-[88px]' aria-hidden>
          <div style={{ height: RULER_H }} className='border-b border-border' />
          <div
            className='border-b border-border px-2 text-[11px] text-muted-foreground'
            style={{ height: SOUND_H, lineHeight: `${SOUND_H}px` }}
          >
            Sound
          </div>
          {LANES.map((l) => (
            <div
              key={l.key}
              className='truncate border-b border-border px-2 text-[12px] font-medium text-foreground last:border-b-0'
              style={{ height: layout.height[l.key], lineHeight: '28px' }}
              data-hv-lane-label={l.key}
            >
              {l.label}
            </div>
          ))}
        </div>
        <div ref={scroller} className='min-w-0 flex-1 overflow-x-auto overscroll-x-contain'>
          <div className='relative' style={{ width }}>
            {/* ruler: press or drag to move the playhead */}
            <div
              className='relative cursor-col-resize touch-none select-none border-b border-border'
              style={{ height: RULER_H }}
              onPointerDown={scrub}
              data-hv-ruler
            >
              {ticks.map((t) => (
                <span
                  key={t}
                  className='absolute top-0 h-full border-l border-border pl-1 font-mono text-[10px] leading-6 text-muted-foreground tabular-nums'
                  style={{ left: toPx(t) }}
                >
                  {clock(t)}
                </span>
              ))}
            </div>
            {/* sound, from the recorder's microphone levels */}
            <div className='relative border-b border-border' style={{ height: SOUND_H }}>
              {silences?.map((r) => (
                <span
                  key={`${r.start_ms}-${r.end_ms}`}
                  className='absolute inset-y-0 bg-amber-200/50 dark:bg-amber-400/15'
                  style={{ left: toPx(r.start_ms), width: toPx(r.end_ms - r.start_ms) }}
                  data-hv-silence
                />
              ))}
              {wave ? (
                <svg
                  className='absolute inset-0 text-slate-400 dark:text-slate-500'
                  width={width}
                  height={SOUND_H}
                  aria-hidden
                >
                  <title>Microphone level</title>
                  <path d={wave} stroke='currentColor' strokeWidth={1} fill='none' />
                </svg>
              ) : (
                <span
                  className='absolute inset-y-0 left-2 text-[11px] leading-8 text-muted-foreground'
                  data-hv-sound-empty={uploaded ? 'upload' : 'no-mic'}
                >
                  {uploaded
                    ? 'No sound levels for an uploaded video'
                    : 'No microphone in this recording'}
                </span>
              )}
            </div>
            <Lanes
              edits={edits}
              sourceMs={sourceMs}
              pps={pps}
              selection={selection}
              onSelect={onSelect}
              drag={drag}
              nudge={nudge}
              hintId={hintId}
              layout={layout}
            />
            <Playhead srcMs={playheadSrcMs} pps={pps} scroller={scroller} dragging={dragging} />
          </div>
        </div>
      </div>
    </section>
  )
}

const zoomButton =
  'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none'
