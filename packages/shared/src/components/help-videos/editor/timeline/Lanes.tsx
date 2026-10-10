import { type FocusEvent, memo, type PointerEvent as ReactPointerEvent, useRef } from 'react'
import {
  isHiddenByCuts,
  type ListKey,
  removeItem,
  removeZoomKeyframe,
  segmentIndexAt,
  trimSegment,
  upsertItem,
  upsertItemChecked
} from '../../edits'
import type { Annotation, RecordedClick, VideoEdits, Zoom } from '../../types'
import {
  isItemSelected,
  moveItems,
  type SelectedItem,
  type Selection,
  selectedItems,
  toggleItem
} from '../selection'
import { clickForRipple, clickTargetText } from '../tools'
import { LANE_H, type laneLayout, type Packed, SUB_H } from './packRows'
import type { useBarDrag } from './useBarDrag'

export type { Selection }

type TimedKey = 'annotations' | 'zooms' | 'blurs' | 'captions'
type TimedItem = { id: string; start_ms: number; end_ms: number; text?: string; type?: string }

// Tinted bars with dark ink: each lane reads at a glance without a saturated
// block of colour, and the label inside clears 4.5:1 in both themes. Dark
// tints sit on an opaque card ground (the same colour as a 25% tint), so
// bars that overlap never show each other's labels through. A bar
// that sits entirely inside a cut is drawn hollow (dashed border on the
// lane's ground) with the same ink, so its label keeps full contrast.
export const LANES: Array<{ key: 'cuts' | ListKey; label: string; tone: string; hollow: string }> =
  [
    { key: 'cuts', label: 'Cuts', tone: '', hollow: '' },
    {
      key: 'holds',
      label: 'Holds',
      tone: 'border-slate-400 bg-slate-100 text-slate-950 dark:border-slate-400/60 dark:bg-card dark:bg-[linear-gradient(rgb(148_163_184/0.25),rgb(148_163_184/0.25))] dark:text-slate-50',
      hollow:
        'border-dashed border-slate-500 bg-card text-slate-950 dark:border-slate-400/70 dark:text-slate-100'
    },
    {
      key: 'chapters',
      label: 'Chapters',
      tone: 'border-violet-300 bg-violet-100 text-violet-950 dark:border-violet-400/50 dark:bg-card dark:bg-[linear-gradient(rgb(139_92_246/0.25),rgb(139_92_246/0.25))] dark:text-violet-50',
      hollow: ''
    },
    {
      key: 'annotations',
      label: 'Callouts',
      tone: 'border-blue-300 bg-blue-100 text-blue-950 dark:border-blue-400/50 dark:bg-card dark:bg-[linear-gradient(rgb(59_130_246/0.25),rgb(59_130_246/0.25))] dark:text-blue-50',
      hollow:
        'border-dashed border-blue-400 bg-card text-blue-950 dark:border-blue-400/70 dark:text-blue-100'
    },
    {
      key: 'zooms',
      label: 'Zoom',
      tone: 'border-emerald-300 bg-emerald-100 text-emerald-950 dark:border-emerald-400/50 dark:bg-card dark:bg-[linear-gradient(rgb(16_185_129/0.25),rgb(16_185_129/0.25))] dark:text-emerald-50',
      hollow:
        'border-dashed border-emerald-500 bg-card text-emerald-950 dark:border-emerald-400/70 dark:text-emerald-100'
    },
    {
      key: 'blurs',
      label: 'Blur',
      tone: 'border-amber-300 bg-amber-100 text-amber-950 dark:border-amber-400/50 dark:bg-card dark:bg-[linear-gradient(rgb(245_158_11/0.25),rgb(245_158_11/0.25))] dark:text-amber-50',
      hollow:
        'border-dashed border-amber-500 bg-card text-amber-950 dark:border-amber-400/70 dark:text-amber-100'
    },
    {
      key: 'captions',
      label: 'Captions',
      tone: 'border-fuchsia-300 bg-fuchsia-100 text-fuchsia-950 dark:border-fuchsia-400/50 dark:bg-card dark:bg-[linear-gradient(rgb(217_70_239/0.25),rgb(217_70_239/0.25))] dark:text-fuchsia-50',
      hollow:
        'border-dashed border-fuchsia-400 bg-card text-fuchsia-950 dark:border-fuchsia-400/70 dark:text-fuchsia-100'
    }
  ]
const laneOf = (k: ListKey) => LANES.find((l) => l.key === k)

export { LANE_H }

/** Narrower bars drop their label rather than show a clipped letter. */
const MIN_LABEL_PX = 40

export const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const ANNOTATION_NAMES: Record<string, string> = {
  callout: 'Callout',
  step: 'Step',
  arrow: 'Arrow',
  box: 'Box',
  spotlight: 'Spotlight',
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
/** "Hold 2.5 s": a held frame's label. */
export const holdLabel = (ms: number) => `Hold ${(ms / 1000).toFixed(1).replace(/\.0$/, '')} s`

/** Rank of each id when the lane is read left to right (keyboard order). */
function orderOf<T extends { id: string }>(list: T[], start: (x: T) => number) {
  const ranked = [...list].sort((a, b) => start(a) - start(b))
  return new Map(ranked.map((x, i) => [x.id, i]))
}

const selectedRing = 'z-10 ring-2 ring-nvr-cyan'
/** A card marker on the cuts lane: a label only (drags pass through it). */
const bookend =
  'pointer-events-none absolute top-1.5 z-[5] flex h-[16px] items-center whitespace-nowrap rounded-[3px] border border-slate-500 bg-white px-1 text-[10px] font-semibold leading-none text-slate-900 dark:border-slate-400 dark:bg-slate-900 dark:text-slate-50'
const barBase =
  'absolute cursor-grab touch-none overflow-hidden rounded-[4px] border text-left text-[11px] font-medium leading-none outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan active:cursor-grabbing'
const edgeHandles = (
  <>
    <span aria-hidden className='absolute inset-y-0 left-0 w-1.5 cursor-ew-resize' />
    <span aria-hidden className='absolute inset-y-0 right-0 w-1.5 cursor-ew-resize' />
  </>
)

type Bars = ReturnType<typeof useBarDrag>
type Layout = ReturnType<typeof laneLayout>

/** A bar's place in its lane: the usual inset with one row, else its
 *  sub-row (bars at the same moment stack instead of hiding each other). */
function rowBox(p: Packed, id: string) {
  if (p.rows === 1) return { top: 4, height: LANE_H - 8 }
  return { top: 2 + (p.row.get(id) ?? 0) * SUB_H, height: SUB_H - 4 }
}

/** A lane is a labelled group. Focus lands on it when its last bar is
 *  deleted, and an empty lane is the lane's one tab stop. */
function laneProps(key: 'cuts' | ListKey, count: number, height = LANE_H) {
  const label = LANES.find((l) => l.key === key)?.label ?? key
  return {
    role: 'group',
    'aria-label': count ? label : `${label}: none yet`,
    tabIndex: count ? -1 : 0,
    'data-hv-lane': key,
    className:
      'relative border-b border-border outline-none last:border-b-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan',
    style: { height }
  } as const
}

const withModifier = (e: ReactPointerEvent<HTMLElement>) => e.shiftKey || e.metaKey || e.ctrlKey

/**
 * The seven edit lanes: kept pieces over a hatched "cut away" ground, held
 * frames, chapter marks, and one lane each for callouts, zoom, blur and
 * captions.
 *
 * Memoised and never given the playhead: during playback only the playhead
 * moves, and these hundreds of bars stay put. Each lane is one tab stop (the
 * selected bar, else the first); arrows move along the lane. Shift- or
 * ⌘-click adds a bar to the selection or takes it out (#1543); dragging a
 * bar of a group moves the whole group, and the group's keys (arrows nudge,
 * Delete) are the editor's.
 */
export const Lanes = memo(function Lanes({
  edits,
  sourceMs,
  pps,
  selection,
  onSelect,
  drag,
  nudge,
  hintId,
  layout,
  clicks,
  onSeek
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
  /** Sub-rows and heights (Timeline memoises it on the edits). */
  layout: Layout
  /** The recorder's clicks: a ripple's tip says what its click hit. */
  clicks?: RecordedClick[] | null
  /** A zoom's stop (#1539) moves the playhead to it when pressed. */
  onSeek?: (srcMs: number) => void
}) {
  const toPx = (ms: number) => (ms / 1000) * pps
  const group = selectedItems(selection)
  const multi = group.length > 1
  const isSelected = (k: ListKey, id: string) => isItemSelected(selection, k, id)
  /** The lane's one tab stop: its selected bar, else the earliest. */
  const tabStop = (k: ListKey, order: Map<string, number>) => {
    const sel = group.find((it) => it.lane === k && order.has(it.id))
    if (sel) return sel.id
    for (const [id, rank] of order) if (rank === 0) return id
    return null
  }
  // A modifier click changes the selection without the focus that follows
  // it (Chrome focuses a pressed button) selecting that one bar alone.
  const skipFocus = useRef(false)
  const onFocus = (item: SelectedItem) => (_e: FocusEvent<HTMLElement>) => {
    if (skipFocus.current) {
      skipFocus.current = false
      return
    }
    if (!isSelected(item.lane, item.id)) onSelect(item)
  }
  /** A press on a bar: with a modifier it joins or leaves the selection; on
   *  a bar of a group it drags the group; else it selects and drags the bar. */
  const press = (
    e: ReactPointerEvent<HTMLElement>,
    item: SelectedItem,
    span: { start_ms: number; end_ms: number },
    single: () => void
  ) => {
    if (e.button !== 0) return
    if (withModifier(e)) {
      e.preventDefault()
      e.stopPropagation()
      skipFocus.current = true
      onSelect(toggleItem(selection, item))
      return
    }
    if (multi && isSelected(item.lane, item.id)) {
      drag(
        e,
        span.start_ms,
        span.end_ms,
        (st) => moveItems(edits, group, st - span.start_ms, sourceMs),
        'multi:move',
        false
      )
      return
    }
    onSelect(item)
    single()
  }
  // A stale index (pieces were cut since) still leaves the lane one stop.
  const cutsStop =
    selection?.lane === 'cuts'
      ? Math.max(0, Math.min(selection.index, edits.segments.length - 1))
      : 0
  const chapterOrder = orderOf(edits.chapters, (c) => c.at_ms)
  const chapterStop = tabStop('chapters', chapterOrder)
  const holds = edits.holds ?? []
  const holdOrder = orderOf(holds, (h) => h.at_ms)
  const holdStop = tabStop('holds', holdOrder)

  return (
    <>
      {/* cuts: kept pieces over a hatched "cut away" ground */}
      <div {...laneProps('cuts', edits.segments.length)}>
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
              className={`${barBase} top-1 bottom-1 flex items-center justify-center border-slate-400 bg-slate-200 text-slate-900 dark:border-slate-500 dark:bg-slate-700 dark:text-slate-50 ${selected ? selectedRing : ''}`}
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
        {/* The intro and outro cards add time outside the recording: marked at
            its two ends, never as source time (they hold none). */}
        {edits.intro && edits.segments.length > 0 && (
          <span
            className={bookend}
            style={{ left: toPx(edits.segments[0].start_ms) }}
            data-hv-bookend='intro'
          >
            Intro {Math.round(edits.intro.duration_ms / 1000)}s
          </span>
        )}
        {edits.outro && edits.segments.length > 0 && (
          <span
            className={`${bookend} -translate-x-full`}
            style={{ left: toPx(edits.segments[edits.segments.length - 1].end_ms) }}
            data-hv-bookend='outro'
          >
            Outro {Math.round(edits.outro.duration_ms / 1000)}s
          </span>
        )}
      </div>
      {/* holds (#1537): a moment each, held for a while of edited time */}
      <div {...laneProps('holds', holds.length)}>
        {holds.map((h) => {
          const hidden = segmentIndexAt(edits, h.at_ms) < 0
          const move = (at: number) =>
            upsertItemChecked(edits, 'holds', {
              ...h,
              at_ms: Math.max(0, Math.min(sourceMs, at))
            })
          const item: SelectedItem = { lane: 'holds', id: h.id }
          return (
            <button
              key={h.id}
              type='button'
              data-hv-item={`holds:${h.id}`}
              data-hv-order={holdOrder.get(h.id)}
              data-hv-hidden={hidden || undefined}
              data-tip={hidden ? 'Hidden: this sits inside a cut' : undefined}
              tabIndex={h.id === holdStop ? 0 : -1}
              aria-label={`Held frame at ${clock(h.at_ms)}, ${(h.hold_ms / 1000).toFixed(1)} seconds${hidden ? ', hidden by a cut' : ''}`}
              aria-describedby={hintId}
              aria-pressed={isSelected('holds', h.id)}
              onPointerDown={(e) =>
                press(e, item, { start_ms: h.at_ms, end_ms: h.at_ms }, () =>
                  drag(e, h.at_ms, h.at_ms + 1, (st) => move(st), `holds:${h.id}`, false)
                )
              }
              onFocus={onFocus(item)}
              onKeyDown={(e) => {
                if (multi) return
                nudge(
                  e,
                  (d) => move(h.at_ms + d),
                  `holds:${h.id}`,
                  () => removeItem(edits, 'holds', h.id)
                )
              }}
              className={`${barBase} top-1 bottom-1 whitespace-nowrap px-1.5 tabular-nums ${hidden ? laneOf('holds')?.hollow : laneOf('holds')?.tone} ${isSelected('holds', h.id) ? selectedRing : ''}`}
              style={{ left: toPx(h.at_ms) }}
            >
              {holdLabel(h.hold_ms)}
            </button>
          )
        })}
      </div>
      {/* chapters: a point in time each */}
      <div {...laneProps('chapters', edits.chapters.length)}>
        {edits.chapters.map((c) => {
          const move = (at: number) =>
            upsertItemChecked(edits, 'chapters', {
              ...c,
              at_ms: Math.max(0, Math.min(sourceMs, at))
            })
          const item: SelectedItem = { lane: 'chapters', id: c.id }
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
              onPointerDown={(e) =>
                press(e, item, { start_ms: c.at_ms, end_ms: c.at_ms }, () =>
                  drag(e, c.at_ms, c.at_ms + 1, (st) => move(st), `chapters:${c.id}`, false)
                )
              }
              onFocus={onFocus(item)}
              onKeyDown={(e) => {
                if (multi) return
                nudge(
                  e,
                  (d) => move(c.at_ms + d),
                  `chapters:${c.id}`,
                  () => removeItem(edits, 'chapters', c.id)
                )
              }}
              className={`${barBase} top-1 bottom-1 max-w-[180px] truncate px-1.5 ${laneOf('chapters')?.tone} ${isSelected('chapters', c.id) ? selectedRing : ''}`}
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
        const packed = layout.lanes[k]
        const lane = laneOf(k)
        return (
          <div key={k} {...laneProps(k, items.length, layout.height[k])}>
            {items.map((it) => {
              const hidden = isHiddenByCuts(edits, it.start_ms, it.end_ms)
              const place = (s: number, en: number) =>
                upsertItemChecked(edits, k, {
                  ...(it as object),
                  start_ms: s,
                  end_ms: en
                } as never)
              const barW = Math.max(6, toPx(it.end_ms - it.start_ms))
              const hit =
                k === 'annotations'
                  ? clickTargetText(clickForRipple(it as unknown as Annotation, clicks))
                  : null
              const item: SelectedItem = { lane: k, id: it.id }
              return (
                <button
                  key={it.id}
                  type='button'
                  data-hv-item={`${k}:${it.id}`}
                  data-hv-order={order.get(it.id)}
                  data-hv-hidden={hidden || undefined}
                  data-tip={
                    hidden
                      ? 'Hidden: this sits entirely inside a cut'
                      : hit
                        ? `Click on ${hit}`
                        : undefined
                  }
                  data-hv-ripple-target={hit ?? undefined}
                  tabIndex={it.id === stop ? 0 : -1}
                  aria-label={`${itemName(k, it)}${hit ? ` on ${hit}` : ''}, ${clock(it.start_ms)} to ${clock(it.end_ms)}${hidden ? ', hidden by a cut' : ''}`}
                  aria-describedby={hintId}
                  aria-pressed={isSelected(k, it.id)}
                  onPointerDown={(e) =>
                    press(e, item, it, () =>
                      drag(e, it.start_ms, it.end_ms, place, `${k}:${it.id}`)
                    )
                  }
                  onFocus={onFocus(item)}
                  onKeyDown={(e) => {
                    if (multi) return
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
                  }}
                  className={`${barBase} truncate px-1.5 ${hidden ? lane?.hollow : lane?.tone} ${isSelected(k, it.id) ? selectedRing : ''}`}
                  style={{ left: toPx(it.start_ms), width: barW, ...rowBox(packed, it.id) }}
                >
                  {/* Too short to read: the bar alone, named by aria-label. */}
                  {barW >= MIN_LABEL_PX && itemLabel(k, it)}
                  {edgeHandles}
                </button>
              )
            })}
            {/* A moving zoom's stops (#1539): diamonds on its bar. Pressing
                one selects the zoom and moves the playhead there; Delete on
                a focused one removes the stop. */}
            {k === 'zooms' &&
              (items as unknown as Zoom[]).flatMap((z) =>
                (z.keyframes ?? []).map((kf) => {
                  const box = rowBox(packed, z.id)
                  return (
                    <button
                      key={`${z.id}:${kf.at_ms}`}
                      type='button'
                      tabIndex={-1}
                      aria-label={`Zoom stop at ${clock(kf.at_ms)}`}
                      title={`Stop at ${clock(kf.at_ms)}: press to go there, Delete to remove it`}
                      data-hv-keyframe={`${z.id}:${kf.at_ms}`}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        if (e.button !== 0) return
                        e.preventDefault()
                        e.currentTarget.focus({ preventScroll: true })
                        onSelect({ lane: 'zooms', id: z.id })
                        onSeek?.(kf.at_ms)
                      }}
                      onKeyDown={(e) =>
                        nudge(e, null, `kf:${z.id}:${kf.at_ms}`, () =>
                          upsertItem(edits, 'zooms', removeZoomKeyframe(z, kf.at_ms))
                        )
                      }
                      className='absolute z-[6] h-2.5 w-2.5 -translate-x-1/2 rotate-45 cursor-pointer rounded-[1px] border border-emerald-700 bg-white outline-none hover:bg-emerald-200 focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-emerald-200 dark:bg-emerald-950 dark:hover:bg-emerald-800'
                      style={{ left: toPx(kf.at_ms), top: box.top + box.height / 2 - 5 }}
                    />
                  )
                })
              )}
          </div>
        )
      })}
    </>
  )
})
