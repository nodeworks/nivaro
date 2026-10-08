import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useRef,
  useState
} from 'react'
import { removeItem, upsertItemChecked } from '../edits'
import { activeAt, zoomAt } from '../playerMath'
import type { Annotation, Point, Rect, VideoEdits } from '../types'
import type { Selection } from './Timeline'
import {
  arrowTailFor,
  clickRect,
  editsForPreview,
  newItemFor,
  type ReshapeMode,
  rectFromPoints,
  reshapeItem,
  squareRect,
  type Tool
} from './tools'

type ShapeLane = 'annotations' | 'zooms' | 'blurs'
type Shape = {
  id: string
  start_ms: number
  end_ms: number
  rect: Rect
  to?: Point | null
  type?: Annotation['type']
  text?: string
}

const TOOL_NAMES: Record<Tool, string> = {
  callout: 'a callout',
  arrow: 'an arrow',
  box: 'a box',
  ripple: 'a click ripple',
  zoom: 'the area to zoom into',
  blur: 'the area to blur'
}
/** A press that moves less than this is a click: the tool's default shape. */
const CLICK_PX = 4
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

function shapeName(lane: ShapeLane, s: Shape): string {
  if (lane === 'zooms') return 'Zoom area'
  if (lane === 'blurs') return 'Blur area'
  const kind = { callout: 'Callout', arrow: 'Arrow', box: 'Box', ripple: 'Click ripple' }[
    s.type ?? 'callout'
  ]
  return s.text?.trim() ? `${kind} “${s.text.trim()}”` : kind
}

/**
 * Drawing and direct manipulation on the preview. Laid out in frame pixels
 * but stored as frame fractions, the same space the render uses. The
 * picture may be zoomed (a zoom at the playhead): pointer positions are
 * mapped back to the unzoomed picture, so shapes land where they are drawn.
 *
 * - With a tool: drag to draw (a click places the tool's default shape).
 * - Without one: click a shape on the picture to select it; drag it to move
 *   it, drag its corner to resize it (an arrow: drag either end).
 * - The selected shape takes the keyboard: arrows move it, Alt+arrows
 *   resize it (an arrow's tip), Shift for bigger steps, Delete removes it.
 * Every change goes through upsertItemChecked; a refusal goes to onRefused.
 */
export function PreviewTools({
  frame,
  edits,
  srcMs,
  sourceMs,
  tool,
  selection,
  onSelect,
  onChange,
  onRefused,
  onDone,
  note
}: {
  frame: { width: number; height: number }
  edits: VideoEdits
  srcMs: number
  sourceMs: number
  tool: Tool | null
  selection: Selection
  onSelect: (s: Selection) => void
  onChange: (e: VideoEdits, key?: string) => void
  onRefused: (reason: string) => void
  onDone: () => void
  /** The editor's current note. On narrow screens the timeline (where it is
   *  announced) is below the fold, so the picture shows a copy too. */
  note?: string | null
}) {
  const layer = useRef<HTMLDivElement | null>(null)
  const selectedEl = useRef<HTMLButtonElement | null>(null)
  const focusSelected = useRef(false)
  const hintId = useId()
  const [draft, setDraft] = useState<{ a: Point; b: Point; x0: number; y0: number } | null>(null)
  const W = frame.width
  const H = frame.height

  // The zoom the player shows at this moment (same edits the player gets).
  const view = zoomAt(editsForPreview(edits, selection), srcMs)
  /** Pointer → picture fraction, through the zoom. */
  const frac = (e: { clientX: number; clientY: number }): Point => {
    const r = (layer.current as HTMLDivElement).getBoundingClientRect()
    const fx = r.width ? (e.clientX - r.left) / r.width : 0
    const fy = r.height ? (e.clientY - r.top) / r.height : 0
    return { x: clamp01((fx - view.tx) / view.z), y: clamp01((fy - view.ty) / view.z) }
  }
  /** Picture fraction → layer pixels, through the zoom. */
  const px = (p: Point) => ({ x: (p.x * view.z + view.tx) * W, y: (p.y * view.z + view.ty) * H })
  const box = (r: Rect) => {
    const tl = px(r)
    return { left: tl.x, top: tl.y, width: r.w * view.z * W, height: r.h * view.z * H }
  }

  const write = (base: VideoEdits, lane: ShapeLane, item: Shape, key?: string) => {
    const r = upsertItemChecked(base, lane, item as never)
    if (r.refused) onRefused(r.refused)
    else if (r.edits !== base) onChange(r.edits, key)
    return !r.refused
  }

  // ── Drawing ──────────────────────────────────────────────────────────────
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!tool || e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = frac(e)
    setDraft({ a: p, b: p, x0: e.clientX, y0: e.clientY })
  }
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (draft) setDraft({ ...draft, b: frac(e) })
  }
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draft || !tool) return
    setDraft(null)
    const click = Math.hypot(e.clientX - draft.x0, e.clientY - draft.y0) < CLICK_PX
    let rect: Rect
    let to: Point | undefined
    if (tool === 'arrow') {
      // Dragged from tail to tip; a click is the tip, pointed at from nearby.
      const tail = click ? arrowTailFor(draft.a) : draft.a
      rect = { x: tail.x, y: tail.y, w: 0.02, h: 0.02 }
      to = click ? draft.a : draft.b
    } else rect = click ? clickRect(tool, draft.a) : rectFromPoints(draft.a, draft.b)
    const { key, item } = newItemFor(tool, rect, srcMs, sourceMs, to)
    // A refused shape (an overlapping zoom) keeps the tool up to try again.
    if (!write(edits, key as ShapeLane, item)) return
    onSelect({ lane: key, id: item.id })
    focusSelected.current = true
    onDone()
  }

  // ── The selected shape ───────────────────────────────────────────────────
  const lane: ShapeLane | null =
    selection &&
    (selection.lane === 'annotations' || selection.lane === 'zooms' || selection.lane === 'blurs')
      ? selection.lane
      : null
  const selected = lane
    ? (edits[lane] as Shape[]).find((x) => x.id === (selection as { id: string }).id)
    : undefined
  const visible = !!selected && srcMs >= selected.start_ms && srcMs <= selected.end_ms
  const isArrow = selected?.type === 'arrow' && !!selected.to

  // A shape just drawn takes the keyboard straight away. When a focused
  // shape leaves the picture (its time passed), focus stays in the preview
  // instead of falling back to the page.
  const shapeFocused = useRef(false)
  useEffect(() => {
    if (focusSelected.current && visible) {
      focusSelected.current = false
      selectedEl.current?.focus({ preventScroll: true })
    }
    if (!visible && shapeFocused.current) {
      shapeFocused.current = false
      const active = document.activeElement
      if (!active || active === document.body) layer.current?.focus({ preventScroll: true })
    }
  })

  const edit =
    (mode: ReshapeMode, s: Shape, l: ShapeLane) => (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0 || tool) return
      e.preventDefault()
      e.stopPropagation()
      const el = e.currentTarget
      el.setPointerCapture(e.pointerId)
      if ((selection as { id?: string } | null)?.id !== s.id) {
        onSelect({ lane: l, id: s.id })
        focusSelected.current = true
      } else selectedEl.current?.focus({ preventScroll: true })
      const p0 = frac(e)
      const base = edits
      // A click that selects (with a pixel or two of jitter) moves nothing.
      const [x0, y0] = [e.clientX, e.clientY]
      let moving = false
      const move = (ev: PointerEvent) => {
        if (!moving && Math.hypot(ev.clientX - x0, ev.clientY - y0) < CLICK_PX) return
        moving = true
        const p = frac(ev)
        write(base, l, reshapeItem(s, l, mode, p.x - p0.x, p.y - p0.y), `rect:${s.id}`)
      }
      const up = () => {
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
        el.removeEventListener('pointercancel', up)
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
      el.addEventListener('pointercancel', up)
    }

  const onShapeKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (!selected || !lane) return
    const dirs: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1]
    }
    const dir = dirs[e.key]
    if (dir) {
      const step = e.shiftKey ? 0.05 : 0.01
      const mode: ReshapeMode = e.altKey ? (isArrow ? 'tip' : 'resize') : 'move'
      write(
        edits,
        lane,
        reshapeItem(selected, lane, mode, dir[0] * step, dir[1] * step),
        `rect:${selected.id}`
      )
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      onChange(removeItem(edits, lane, selected.id))
      onSelect(null)
      layer.current?.focus({ preventScroll: true })
    } else if (e.key === 'Escape') {
      onSelect(null)
      layer.current?.focus({ preventScroll: true })
    } else return
    // Handled here: the player's own keys (arrows seek) must not see it.
    e.preventDefault()
    e.stopPropagation()
  }

  // Shapes on the picture right now, to click and select (not zooms: a
  // zoom fills the picture while it plays; select it on the timeline). The
  // selected one keeps its area too: a drag that selected it holds the
  // pointer there.
  const pickable: Array<{ lane: ShapeLane; s: Shape }> = tool
    ? []
    : [
        ...activeAt(edits.blurs as Shape[], srcMs).map((s) => ({ lane: 'blurs' as const, s })),
        ...activeAt(edits.annotations as Shape[], srcMs).map((s) => ({
          lane: 'annotations' as const,
          s
        }))
      ]

  /** An arrow's hit area: the box around both ends, padded for the pointer. */
  const reach = (s: Shape) => {
    if (s.type !== 'arrow' || !s.to) return box(s.rect)
    const a = px(s.rect)
    const b = px(s.to)
    const pad = 8
    return {
      left: Math.min(a.x, b.x) - pad,
      top: Math.min(a.y, b.y) - pad,
      width: Math.abs(a.x - b.x) + 2 * pad,
      height: Math.abs(a.y - b.y) + 2 * pad
    }
  }

  const preview = draft && tool && tool !== 'arrow' ? rectFromPoints(draft.a, draft.b) : null
  const handle =
    'absolute h-3.5 w-3.5 touch-none rounded-[3px] border border-white bg-nvr-cyan shadow-[0_0_0_1px_rgb(0_0_0/0.6)] before:absolute before:-inset-2 before:content-[""]'

  return (
    <div
      ref={layer}
      tabIndex={-1}
      // Above the player's big Play button: with a tool up, a drag that
      // starts on it still draws (it covers much of a small picture).
      className={`absolute inset-0 z-10 outline-none ${tool ? 'cursor-crosshair touch-none' : ''}`}
      style={{ pointerEvents: tool ? 'auto' : 'none' }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => setDraft(null)}
      data-hv-preview-tools={tool ?? 'select'}
    >
      {/* Out of the way while drawing: it would cover the shape on a small picture. */}
      {tool && !draft && (
        <p
          className='pointer-events-none absolute top-2 left-1/2 w-max max-w-[calc(100%-16px)] -translate-x-1/2 rounded-md bg-[#020617]/80 px-2.5 py-1 text-center text-[12px] leading-snug font-medium text-white'
          data-hv-tool-hint
        >
          Drag on the picture to draw {TOOL_NAMES[tool]}. Esc to stop.
        </p>
      )}
      {note && (
        <p
          aria-hidden
          className='pointer-events-none absolute inset-x-2 bottom-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-[12px] leading-snug text-amber-900 shadow-[0_1px_4px_rgb(0_0_0/0.25)] lg:hidden dark:bg-amber-950 dark:text-amber-100'
          data-hv-preview-note
        >
          {note}
        </p>
      )}
      {preview && (
        <div
          className='absolute rounded-[2px] border-2 border-dashed border-nvr-cyan bg-nvr-cyan/10 shadow-[0_0_0_1px_rgb(0_0_0/0.45)]'
          style={box(tool === 'zoom' ? squareRect(preview) : preview)}
          data-hv-draft
        />
      )}
      {draft && tool === 'arrow' && (
        <svg className='absolute inset-0 text-nvr-cyan' width={W} height={H} aria-hidden='true'>
          <line
            x1={px(draft.a).x}
            y1={px(draft.a).y}
            x2={px(draft.b).x}
            y2={px(draft.b).y}
            stroke='currentColor'
            strokeWidth={3}
            strokeDasharray='6 4'
            strokeLinecap='round'
          />
        </svg>
      )}
      {pickable.map(({ lane: l, s }) => (
        <div
          key={s.id}
          aria-hidden
          className='pointer-events-auto absolute cursor-pointer rounded-[2px] hover:outline hover:outline-2 hover:outline-dashed hover:outline-white/90'
          style={reach(s)}
          onPointerDown={edit('move', s, l)}
          data-hv-pick={s.id}
        />
      ))}
      {selected && lane && visible && !tool && (
        <>
          <p id={hintId} className='sr-only'>
            Arrow keys move it.{' '}
            {isArrow ? 'Alt with an arrow key moves its tip.' : 'Alt with an arrow key resizes it.'}{' '}
            Shift takes bigger steps. Delete removes it.
          </p>
          <button
            ref={selectedEl}
            type='button'
            className='pointer-events-auto absolute cursor-move touch-none rounded-[2px] outline-none ring-2 ring-nvr-cyan shadow-[0_0_0_3px_rgb(0_0_0/0.5)] focus-visible:ring-[3px]'
            style={reach(selected)}
            onPointerDown={edit('move', selected, lane)}
            onKeyDown={onShapeKey}
            onFocus={() => {
              shapeFocused.current = true
            }}
            onBlur={(e) => {
              // Focus moved somewhere else (not the shape leaving the picture).
              if (e.relatedTarget) shapeFocused.current = false
            }}
            aria-label={`${shapeName(lane, selected)}, selected`}
            aria-describedby={hintId}
            data-hv-shape
            data-hv-selected={selected.id}
          >
            {!isArrow && (
              <span
                className={`${handle} -right-[7px] -bottom-[7px] cursor-nwse-resize`}
                onPointerDown={edit('resize', selected, lane)}
                data-hv-resize
              />
            )}
          </button>
          {isArrow &&
            selected.to &&
            (
              [
                ['tail', px(selected.rect)],
                ['tip', px(selected.to)]
              ] as const
            ).map(([end, at]) => (
              <span
                key={end}
                aria-hidden
                className={`${handle} pointer-events-auto -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full`}
                style={{ left: at.x, top: at.y }}
                onPointerDown={edit(end, selected, lane)}
                data-hv-arrow-end={end}
              />
            ))}
        </>
      )}
    </div>
  )
}
