import { memo } from 'react'
import {
  isHiddenByCuts,
  type ListKey,
  removeItem,
  trimSegment,
  upsertItemChecked
} from '../../edits'
import type { VideoEdits } from '../../types'
import type { useBarDrag } from './useBarDrag'

export type Selection = { lane: 'cuts'; index: number } | { lane: ListKey; id: string } | null

type TimedKey = 'annotations' | 'zooms' | 'blurs' | 'captions'
type TimedItem = { id: string; start_ms: number; end_ms: number; text?: string; type?: string }

// Tinted bars with dark ink: each lane reads at a glance without a saturated
// block of colour, and the label inside clears 4.5:1 in both themes. A bar
// that sits entirely inside a cut is drawn hollow (dashed border on the
// lane's ground) with the same ink, so its label keeps full contrast.
export const LANES: Array<{ key: 'cuts' | ListKey; label: string; tone: string; hollow: string }> =
  [
    { key: 'cuts', label: 'Cuts', tone: '', hollow: '' },
    {
      key: 'chapters',
      label: 'Chapters',
      tone: 'border-violet-300 bg-violet-100 text-violet-950 dark:border-violet-400/50 dark:bg-violet-500/25 dark:text-violet-50',
      hollow: ''
    },
    {
      key: 'annotations',
      label: 'Callouts',
      tone: 'border-blue-300 bg-blue-100 text-blue-950 dark:border-blue-400/50 dark:bg-blue-500/25 dark:text-blue-50',
      hollow:
        'border-dashed border-blue-400 bg-card text-blue-950 dark:border-blue-400/70 dark:text-blue-100'
    },
    {
      key: 'zooms',
      label: 'Zoom',
      tone: 'border-emerald-300 bg-emerald-100 text-emerald-950 dark:border-emerald-400/50 dark:bg-emerald-500/25 dark:text-emerald-50',
      hollow:
        'border-dashed border-emerald-500 bg-card text-emerald-950 dark:border-emerald-400/70 dark:text-emerald-100'
    },
    {
      key: 'blurs',
      label: 'Blur',
      tone: 'border-amber-300 bg-amber-100 text-amber-950 dark:border-amber-400/50 dark:bg-amber-500/25 dark:text-amber-50',
      hollow:
        'border-dashed border-amber-500 bg-card text-amber-950 dark:border-amber-400/70 dark:text-amber-100'
    },
    {
      key: 'captions',
      label: 'Captions',
      tone: 'border-fuchsia-300 bg-fuchsia-100 text-fuchsia-950 dark:border-fuchsia-400/50 dark:bg-fuchsia-500/25 dark:text-fuchsia-50',
      hollow:
        'border-dashed border-fuchsia-400 bg-card text-fuchsia-950 dark:border-fuchsia-400/70 dark:text-fuchsia-100'
    }
  ]
const laneOf = (k: ListKey) => LANES.find((l) => l.key === k)
export const LANE_H = 28
/** Narrower bars drop their label rather than show a clipped letter. */
const MIN_LABEL_PX = 40

export const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
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
/** Screen-reader name: the lane first where the bar's own label doesn't say it. */
function itemName(k: TimedKey, it: TimedItem): string {
  const label = itemLabel(k, it)
  return k === 'annotations' || k === 'captions' ? `${laneOf(k)?.label}: ${label}` : label
}

/** Rank of each id when the lane is read left to right (keyboard order). */
function orderOf<T extends { id: string }>(list: T[], start: (x: T) => number) {
  const ranked = [...list].sort((a, b) => start(a) - start(b))
  return new Map(ranked.map((x, i) => [x.id, i]))
}

const selectedRing = 'z-10 ring-2 ring-nvr-cyan'
const barBase =
  'absolute top-1 bottom-1 cursor-grab touch-none overflow-hidden rounded-[4px] border text-left text-[11px] font-medium leading-none outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan active:cursor-grabbing'
const edgeHandles = (
  <>
    <span aria-hidden className='absolute inset-y-0 left-0 w-1.5 cursor-ew-resize' />
    <span aria-hidden className='absolute inset-y-0 right-0 w-1.5 cursor-ew-resize' />
  </>
)

type Bars = ReturnType<typeof useBarDrag>

/**
 * The six edit lanes: kept pieces over a hatched "cut away" ground, chapter
 * marks, and one lane each for callouts, zoom, blur and captions.
 *
 * Memoised and never given the playhead: during playback only the playhead
 * moves, and these hundreds of bars stay put. Each lane is one tab stop (the
 * selected bar, else the first); arrows move along the lane.
 */
export const Lanes = memo(function Lanes({
  edits,
  sourceMs,
  pps,
  selection,
  onSelect,
  drag,
  nudge,
  hintId
}: {
  edits: VideoEdits
  sourceMs: number
  pps: number
  selection: Selection
  onSelect: (s: Selection) => void
  drag: Bars['drag']
  nudge: Bars['nudge']
  /** id of the visually hidden keyboard hint every bar is described by. */
  hintId: string
}) {
  const toPx = (ms: number) => (ms / 1000) * pps
  const selectedIn = (k: ListKey) =>
    selection && selection.lane === k ? (selection as { id: string }).id : null
  const isSelected = (k: ListKey, id: string) => selectedIn(k) === id
  /** The lane's one tab stop: its selected bar, else the earliest. */
  const tabStop = (k: ListKey, order: Map<string, number>) => {
    const sel = selectedIn(k)
    if (sel && order.has(sel)) return sel
    for (const [id, rank] of order) if (rank === 0) return id
    return null
  }
  const cutsStop = selection?.lane === 'cuts' ? selection.index : 0
  const chapterOrder = orderOf(edits.chapters, (c) => c.at_ms)
  const chapterStop = tabStop('chapters', chapterOrder)

  return (
    <>
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
              data-hv-order={i}
              tabIndex={i === cutsStop ? 0 : -1}
              aria-label={`Kept piece ${clock(s.start_ms)} to ${clock(s.end_ms)}${s.speed !== 1 ? `, ${s.speed}× speed` : ''}`}
              aria-describedby={hintId}
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
              // Arrows move between pieces; Delete is the editor's "Cut piece".
              onKeyDown={(e) => nudge(e, null, `seg:${i}`)}
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
              data-hv-order={chapterOrder.get(c.id)}
              tabIndex={c.id === chapterStop ? 0 : -1}
              aria-label={`Chapter ${clock(c.at_ms)}: ${c.title}`}
              aria-describedby={hintId}
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
              className={`${barBase} max-w-[180px] truncate px-1.5 ${laneOf('chapters')?.tone} ${isSelected('chapters', c.id) ? selectedRing : ''}`}
              style={{ left: toPx(c.at_ms) }}
            >
              {c.title || 'Chapter'}
            </button>
          )
        })}
      </div>
      {(['annotations', 'zooms', 'blurs', 'captions'] as const).map((k) => {
        const items = edits[k] as TimedItem[]
        const order = orderOf(items, (x) => x.start_ms)
        const stop = tabStop(k, order)
        const lane = laneOf(k)
        return (
          <div
            key={k}
            className='relative border-b border-border last:border-b-0'
            style={{ height: LANE_H }}
          >
            {items.map((it) => {
              const hidden = isHiddenByCuts(edits, it.start_ms, it.end_ms)
              const place = (s: number, en: number) =>
                upsertItemChecked(edits, k, {
                  ...(it as object),
                  start_ms: s,
                  end_ms: en
                } as never)
              const barW = Math.max(6, toPx(it.end_ms - it.start_ms))
              return (
                <button
                  key={it.id}
                  type='button'
                  data-hv-item={`${k}:${it.id}`}
                  data-hv-order={order.get(it.id)}
                  data-hv-hidden={hidden || undefined}
                  data-tip={hidden ? 'Hidden: this sits entirely inside a cut' : undefined}
                  tabIndex={it.id === stop ? 0 : -1}
                  aria-label={`${itemName(k, it)}, ${clock(it.start_ms)} to ${clock(it.end_ms)}${hidden ? ', hidden by a cut' : ''}`}
                  aria-describedby={hintId}
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
                  className={`${barBase} truncate px-1.5 ${hidden ? lane?.hollow : lane?.tone} ${isSelected(k, it.id) ? selectedRing : ''}`}
                  style={{ left: toPx(it.start_ms), width: barW }}
                >
                  {/* Too short to read: the bar alone, named by aria-label. */}
                  {barW >= MIN_LABEL_PX && itemLabel(k, it)}
                  {edgeHandles}
                </button>
              )
            })}
          </div>
        )
      })}
    </>
  )
})
