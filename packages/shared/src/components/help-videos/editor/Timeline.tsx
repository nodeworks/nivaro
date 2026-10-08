import { Info, Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { isHiddenByCuts, type ListKey, removeItem, trimSegment, upsertItemChecked } from '../edits'
import type { VideoEdits } from '../types'
import type { Stretch } from './suggestCuts'

export type Selection = { lane: 'cuts'; index: number } | { lane: ListKey; id: string } | null

type TimedKey = 'annotations' | 'zooms' | 'blurs' | 'captions'
type TimedItem = { id: string; start_ms: number; end_ms: number; text?: string; type?: string }

// Tinted bars with dark ink: each lane reads at a glance without a saturated
// block of colour, and the label inside clears 4.5:1 in both themes.
const LANES: Array<{ key: 'cuts' | ListKey; label: string; tone: string }> = [
  { key: 'cuts', label: 'Cuts', tone: '' },
  {
    key: 'chapters',
    label: 'Chapters',
    tone: 'border-violet-300 bg-violet-100 text-violet-950 dark:border-violet-400/50 dark:bg-violet-500/25 dark:text-violet-50'
  },
  {
    key: 'annotations',
    label: 'Callouts',
    tone: 'border-blue-300 bg-blue-100 text-blue-950 dark:border-blue-400/50 dark:bg-blue-500/25 dark:text-blue-50'
  },
  {
    key: 'zooms',
    label: 'Zoom',
    tone: 'border-emerald-300 bg-emerald-100 text-emerald-950 dark:border-emerald-400/50 dark:bg-emerald-500/25 dark:text-emerald-50'
  },
  {
    key: 'blurs',
    label: 'Blur',
    tone: 'border-amber-300 bg-amber-100 text-amber-950 dark:border-amber-400/50 dark:bg-amber-500/25 dark:text-amber-50'
  },
  {
    key: 'captions',
    label: 'Captions',
    tone: 'border-fuchsia-300 bg-fuchsia-100 text-fuchsia-950 dark:border-fuchsia-400/50 dark:bg-fuchsia-500/25 dark:text-fuchsia-50'
  }
]
const toneOf = (k: ListKey) => LANES.find((l) => l.key === k)?.tone ?? ''
const LANE_H = 28
const RULER_H = 24
const SOUND_H = 32
const SNAP_PX = 8
const EDGE_PX = 6
const MIN_ITEM_MS = 200
/** Narrower bars drop their label rather than show a clipped letter. */
const MIN_LABEL_PX = 40
const MAX_PX_PER_SEC = 200
/** Ruler label steps, in seconds; the first that leaves ≥ 64 px between labels wins. */
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`)
const ANNOTATION_NAMES: Record<string, string> = {
  callout: 'Callout',
  arrow: 'Arrow',
  box: 'Box',
  ripple: 'Click ripple'
}
function itemLabel(k: TimedKey, it: TimedItem): string {
  if (k === 'annotations') return it.text?.trim() || ANNOTATION_NAMES[it.type ?? ''] || 'Callout'
  if (k === 'zooms') return 'Zoom'
  if (k === 'blurs') return 'Blur'
  return it.text?.trim() || 'Caption'
}

/** One vertical bar per pixel column (the loudest sample in it). */
function waveformPath(levels: number[], pxPerSec: number, height: number): string {
  const cols = new Map<number, number>()
  for (let i = 0; i < levels.length; i++) {
    const x = Math.floor(((i * 100) / 1000) * pxPerSec)
    const v = Math.max(0, Math.min(1, levels[i] || 0))
    if (v > (cols.get(x) ?? -1)) cols.set(x, v)
  }
  let d = ''
  for (const [x, v] of cols) {
    const h = Math.max(1, v * (height - 4))
    d += `M${x + 0.5} ${height - 2}v${-h.toFixed(1)}`
  }
  return d
}

/** The editor timeline, laid out in SOURCE time: cut-away parts stay visible
 *  as hatched gaps, so trimming and re-including footage is direct. */
export function Timeline({
  edits,
  sourceMs,
  playheadSrcMs,
  levels,
  silences,
  selection,
  onSelect,
  onSeek,
  onChange
}: {
  edits: VideoEdits
  sourceMs: number
  playheadSrcMs: number
  levels: number[] | null
  /** Suggested silent stretches, shaded on the sound lane. */
  silences?: Stretch[]
  selection: Selection
  onSelect: (s: Selection) => void
  onSeek: (srcMs: number) => void
  onChange: (e: VideoEdits, key?: string) => void
}) {
  const scroller = useRef<HTMLDivElement | null>(null)
  const [viewW, setViewW] = useState(0)
  const [pxPerSec, setPxPerSec] = useState<number | null>(null)
  // A change the server would refuse (overlapping zooms, too short) is not
  // applied; the reason shows here until the next interaction.
  const [note, setNote] = useState<string | null>(null)

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

  // Keep the playhead in view while the video plays.
  const dragging = useRef(false)
  useEffect(() => {
    const el = scroller.current
    if (!el || dragging.current) return
    const x = toPx(playheadSrcMs)
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 16)
      el.scrollLeft = Math.max(0, x - el.clientWidth * 0.1)
  }, [playheadSrcMs, toPx])

  const snapTargets = useMemo(() => {
    const t = [playheadSrcMs, 0, sourceMs]
    for (const s of edits.segments) t.push(s.start_ms, s.end_ms)
    for (const k of ['annotations', 'zooms', 'blurs', 'captions'] as const)
      for (const x of edits[k]) t.push(x.start_ms, x.end_ms)
    for (const c of edits.chapters) t.push(c.at_ms)
    return t
  }, [edits, playheadSrcMs, sourceMs])
  const snap = (ms: number, own: number[]) => {
    for (const t of snapTargets)
      if (!own.includes(t) && Math.abs(toPx(t) - toPx(ms)) <= SNAP_PX) return t
    return Math.round(ms)
  }

  /** Apply a change, or show why it was refused (edits stay as they were). */
  const commit = (r: { edits: VideoEdits; refused?: string }, key?: string) => {
    if (r.refused) {
      setNote(sentence(r.refused))
      return
    }
    setNote(null)
    if (r.edits !== edits) onChange(r.edits, key)
  }

  // Generic drag for any timed bar: move it, or stretch it from either edge.
  const drag = (
    e: ReactPointerEvent<HTMLElement>,
    start: number,
    end: number,
    apply: (s: number, en: number) => { edits: VideoEdits; refused?: string },
    key: string,
    resizable = true
  ) => {
    if (e.button !== 0) return
    e.stopPropagation()
    setNote(null)
    const target = e.currentTarget
    const rect = target.getBoundingClientRect()
    const mode = !resizable
      ? 'move'
      : e.clientX - rect.left < EDGE_PX
        ? 'start'
        : rect.right - e.clientX < EDGE_PX
          ? 'end'
          : 'move'
    const x0 = e.clientX
    target.setPointerCapture(e.pointerId)
    dragging.current = true
    let last: VideoEdits | null = null
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - x0) < 2 && !last) return
      const d = ((ev.clientX - x0) / pps) * 1000
      let s = start
      let en = end
      if (mode === 'move') {
        s = snap(Math.max(0, Math.min(sourceMs - (end - start), start + d)), [start, end])
        en = s + (end - start)
      } else if (mode === 'start')
        s = snap(Math.min(end - MIN_ITEM_MS, Math.max(0, start + d)), [start])
      else en = snap(Math.max(start + MIN_ITEM_MS, Math.min(sourceMs, end + d)), [end])
      const r = apply(s, en)
      if (r.refused) setNote(sentence(r.refused))
      else if (r.edits !== last) {
        setNote(null)
        last = r.edits
        onChange(r.edits, key)
      }
    }
    const up = () => {
      dragging.current = false
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }

  // Keyboard: arrows nudge a selected bar (Shift = 1 s), Delete removes it.
  const nudge = (
    e: ReactKeyboardEvent,
    apply: (deltaMs: number) => { edits: VideoEdits; refused?: string },
    key: string,
    remove?: () => VideoEdits
  ) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const step = e.shiftKey ? 1000 : 100
      commit(apply(e.key === 'ArrowLeft' ? -step : step), key)
    } else if (remove && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault()
      e.stopPropagation()
      setNote(null)
      onChange(remove())
      onSelect(null)
    }
  }

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
  const isSelected = (k: ListKey, id: string) =>
    !!selection && selection.lane === k && selection.id === id
  const selectedRing = 'z-10 ring-2 ring-nvr-cyan'
  const barBase =
    'absolute top-1 bottom-1 cursor-grab touch-none overflow-hidden rounded-[4px] border text-left text-[11px] font-medium leading-none outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan active:cursor-grabbing'
  const edgeHandles = (
    <>
      <span aria-hidden className='absolute inset-y-0 left-0 w-1.5 cursor-ew-resize' />
      <span aria-hidden className='absolute inset-y-0 right-0 w-1.5 cursor-ew-resize' />
    </>
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
              style={{ height: LANE_H, lineHeight: `${LANE_H}px` }}
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
                <span className='absolute inset-y-0 left-2 text-[11px] leading-8 text-muted-foreground'>
                  No microphone in this recording
                </span>
              )}
            </div>
            {/* cuts: kept pieces over a hatched "cut away" ground */}
            <div className='relative border-b border-border' style={{ height: LANE_H }}>
              <div
                className='absolute inset-y-0 left-0 bg-[repeating-linear-gradient(135deg,transparent_0_5px,rgb(148_163_184/0.28)_5px_10px)]'
                style={{ width: toPx(sourceMs) }}
                aria-hidden
              />
              {edits.segments.map((s, i) => {
                const selected = selection?.lane === 'cuts' && selection.index === i
                return (
                  <button
                    // biome-ignore lint/suspicious/noArrayIndexKey: pieces are positional
                    key={i}
                    type='button'
                    data-hv-segment={i}
                    aria-label={`Kept piece ${clock(s.start_ms)} to ${clock(s.end_ms)}${s.speed !== 1 ? `, ${s.speed}× speed` : ''}`}
                    aria-pressed={selected}
                    onPointerDown={(e) => {
                      onSelect({ lane: 'cuts', index: i })
                      drag(
                        e,
                        s.start_ms,
                        s.end_ms,
                        (st, en) => ({
                          edits: trimSegment(edits, i, { start_ms: st, end_ms: en }, sourceMs)
                        }),
                        `seg:${i}`
                      )
                    }}
                    onFocus={() => onSelect({ lane: 'cuts', index: i })}
                    className={`${barBase} flex items-center justify-center border-slate-400 bg-slate-200 text-slate-900 dark:border-slate-500 dark:bg-slate-700 dark:text-slate-50 ${selected ? selectedRing : ''}`}
                    style={{
                      left: toPx(s.start_ms),
                      width: Math.max(4, toPx(s.end_ms - s.start_ms))
                    }}
                  >
                    {s.speed !== 1 && (
                      <span className='rounded-[3px] bg-slate-900 px-1 py-0.5 text-[10px] font-semibold text-white tabular-nums dark:bg-slate-50 dark:text-slate-900'>
                        {s.speed}×
                      </span>
                    )}
                    {edgeHandles}
                  </button>
                )
              })}
            </div>
            {/* chapters: a point in time each */}
            <div className='relative border-b border-border' style={{ height: LANE_H }}>
              {edits.chapters.map((c) => {
                const move = (at: number) =>
                  upsertItemChecked(edits, 'chapters', {
                    ...c,
                    at_ms: Math.max(0, Math.min(sourceMs, at))
                  })
                return (
                  <button
                    key={c.id}
                    type='button'
                    data-hv-chapter={c.id}
                    aria-label={`Chapter ${clock(c.at_ms)}: ${c.title}`}
                    aria-pressed={isSelected('chapters', c.id)}
                    onPointerDown={(e) => {
                      onSelect({ lane: 'chapters', id: c.id })
                      drag(e, c.at_ms, c.at_ms + 1, (st) => move(st), `chapters:${c.id}`, false)
                    }}
                    onFocus={() => onSelect({ lane: 'chapters', id: c.id })}
                    onKeyDown={(e) =>
                      nudge(
                        e,
                        (d) => move(c.at_ms + d),
                        `chapters:${c.id}`,
                        () => removeItem(edits, 'chapters', c.id)
                      )
                    }
                    className={`${barBase} max-w-[180px] truncate px-1.5 ${toneOf('chapters')} ${isSelected('chapters', c.id) ? selectedRing : ''}`}
                    style={{ left: toPx(c.at_ms) }}
                  >
                    {c.title || 'Chapter'}
                  </button>
                )
              })}
            </div>
            {(['annotations', 'zooms', 'blurs', 'captions'] as const).map((k) => (
              <div
                key={k}
                className='relative border-b border-border last:border-b-0'
                style={{ height: LANE_H }}
              >
                {(edits[k] as TimedItem[]).map((it) => {
                  const hidden = isHiddenByCuts(edits, it.start_ms, it.end_ms)
                  const place = (s: number, en: number) =>
                    upsertItemChecked(edits, k, {
                      ...(it as object),
                      start_ms: s,
                      end_ms: en
                    } as never)
                  const label = itemLabel(k, it)
                  const barW = Math.max(6, toPx(it.end_ms - it.start_ms))
                  return (
                    <button
                      key={it.id}
                      type='button'
                      data-hv-item={`${k}:${it.id}`}
                      data-tip={hidden ? 'Hidden: this sits entirely inside a cut' : undefined}
                      aria-label={`${label}, ${clock(it.start_ms)} to ${clock(it.end_ms)}${hidden ? ', hidden by a cut' : ''}`}
                      aria-pressed={isSelected(k, it.id)}
                      onPointerDown={(e) => {
                        onSelect({ lane: k, id: it.id })
                        drag(e, it.start_ms, it.end_ms, place, `${k}:${it.id}`)
                      }}
                      onFocus={() => onSelect({ lane: k, id: it.id })}
                      onKeyDown={(e) =>
                        nudge(
                          e,
                          (d) => {
                            const s = Math.max(
                              0,
                              Math.min(sourceMs - (it.end_ms - it.start_ms), it.start_ms + d)
                            )
                            return place(s, s + (it.end_ms - it.start_ms))
                          },
                          `${k}:${it.id}`,
                          () => removeItem(edits, k, it.id)
                        )
                      }
                      className={`${barBase} truncate px-1.5 ${toneOf(k)} ${hidden ? 'border-dashed opacity-60' : ''} ${isSelected(k, it.id) ? selectedRing : ''}`}
                      style={{ left: toPx(it.start_ms), width: barW }}
                    >
                      {/* Too short to read: the bar alone, named by aria-label. */}
                      {barW >= MIN_LABEL_PX && label}
                      {edgeHandles}
                    </button>
                  )
                })}
              </div>
            ))}
            {/* playhead */}
            <div
              className='pointer-events-none absolute top-0 bottom-0 z-20 w-0.5 -translate-x-1/2 bg-rose-600 dark:bg-rose-400'
              style={{ left: toPx(playheadSrcMs) }}
              data-hv-playhead
            >
              <span className='absolute -top-px left-1/2 h-2 w-2.5 -translate-x-1/2 rounded-b-[2px] bg-rose-600 dark:bg-rose-400' />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

const zoomButton =
  'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none'
