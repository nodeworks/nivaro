import {
  type Active,
  type Announcements,
  type Collision,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardCode,
  KeyboardSensor,
  MeasuringStrategy,
  type Modifier,
  type Over,
  PointerSensor,
  type UniqueIdentifier,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import { getEventCoordinates } from '@dnd-kit/utilities'
import {
  type CSSProperties,
  createContext,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import { type LayoutBundle, type LayoutOp, UNGROUPED_KEY } from '../../../lib/layout-ops'
import { type DesignDnd, type DesignTarget, targetKey } from '../design-context'
import {
  type DndNodeData,
  type DropHint,
  nodeData,
  typedCollision,
  typedKeyboardCoordinates
} from './collision'
import { DndStore, DndStoreContext, IDLE, NO_DND } from './node'

export { NO_DND }

import { dropLabel, landsOnCanvas, orderAfterDrop, placeAfterDrop } from './order'

// Drag and drop on the layout editor canvas (spec §7.5). Every DesignNode is
// draggable and a drop target; what may land where is typedCollision's call,
// the order a drop makes is orderAfterDrop's, and a drop is applied as one
// op batch. Nothing on the form moves while dragging: the dragged node dims,
// a DragOverlay copy follows the pointer, and an insertion line (absolutely
// placed, so no reflow) shows where it will land. Add panel rows
// (useAddDragSource) drag the same way; their drop is placeAfterDrop's one
// `place` op.

const DndApiContext = createContext<DesignDnd>(NO_DND)

/** The `dnd` part of LayoutDesign, from the nearest LayoutDndProvider (NO_DND outside one). */
export function useLayoutDnd(): DesignDnd {
  return useContext(DndApiContext)
}

const BAR = 3
const BODY_INSET = 20

/**
 * Where the insertion line sits inside the hovered node, in px from its
 * edges. Into a section's body: under the header (first) or at the bottom
 * (last), as wide as the dragged element. Between stacked nodes: a line
 * across the gap (as wide as the dragged field, or the whole section);
 * between side-by-side ones (half-width fields, tabs, header tiles): a line
 * down the gap.
 */
export function indicatorStyle(
  hint: DropHint,
  over: DndNodeData,
  overWidth: number,
  draggedWidth: number | null
): CSSProperties {
  if (hint.body) {
    const room = overWidth - 2 * BODY_INSET
    const width = draggedWidth && room > 0 ? Math.min(draggedWidth, room) : undefined
    const across = width ? { left: BODY_INSET, width } : { left: BODY_INSET, right: BODY_INSET }
    return hint.side === 'before'
      ? { top: (over.headerHeight?.() ?? 0) + 4, height: BAR, ...across }
      : { bottom: 8, height: BAR, ...across }
  }
  if (hint.axis === 'x')
    return { top: 0, bottom: 0, width: BAR, [hint.side === 'before' ? 'left' : 'right']: -4 }
  const width =
    over.role.kind === 'item' && draggedWidth && overWidth
      ? Math.min(draggedWidth, overWidth)
      : undefined
  return {
    [hint.side === 'before' ? 'top' : 'bottom']: -6,
    height: BAR,
    left: 0,
    ...(width ? { width } : { right: 0 })
  }
}

const hintFor = (collisions: Collision[] | null, overId: UniqueIdentifier | undefined) =>
  ((collisions ?? []).find((c) => c.id === overId)?.data as { hint?: DropHint } | undefined)
    ?.hint ?? null

/**
 * Where a `position: fixed` child of `host` is measured from: the viewport,
 * unless `host` or an ancestor makes a containing block (a transformed sheet).
 */
export function fixedOrigin(host: HTMLElement): { x: number; y: number } {
  for (let el: HTMLElement | null = host; el && el !== document.documentElement; ) {
    const cs = getComputedStyle(el)
    const block =
      (cs.transform && cs.transform !== 'none') ||
      (cs.perspective && cs.perspective !== 'none') ||
      (cs.filter && cs.filter !== 'none') ||
      /paint|layout|strict|content/.test(cs.contain ?? '') ||
      /transform|perspective|filter/.test(cs.willChange ?? '')
    if (block) {
      const r = el.getBoundingClientRect()
      return { x: r.left + el.clientLeft - el.scrollLeft, y: r.top + el.clientTop - el.scrollTop }
    }
    el = el.parentElement
  }
  return { x: 0, y: 0 }
}

/** A static copy of a canvas node for the drag preview: how it looks on the form, inert. */
export function designClone(node: HTMLElement): HTMLElement {
  const copy = node.cloneNode(true) as HTMLElement
  for (const el of [copy, ...Array.from(copy.querySelectorAll<HTMLElement>('*'))]) {
    for (const a of ['data-design-target', 'data-selected', 'data-drop-slot', 'id'])
      el.removeAttribute(a)
  }
  for (const el of Array.from(copy.querySelectorAll('[data-design-drop-indicator]'))) el.remove()
  for (const a of ['role', 'tabindex', 'aria-describedby', 'aria-pressed', 'aria-hidden'])
    copy.removeAttribute(a)
  copy.removeAttribute('data-header-folded')
  copy.setAttribute('inert', '')
  Object.assign(copy.style, { margin: '0', width: '100%', opacity: '1', outline: 'none' })
  return copy
}

// Tall sections preview their top part only.
const OVERLAY_MAX_H = 320

function OverlayCopy({ node }: { node: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const host = ref.current
    if (!host) return
    host.replaceChildren(designClone(node))
    return () => host.replaceChildren()
  }, [node])
  return (
    <div
      ref={ref}
      aria-hidden
      data-design-drag-preview=''
      className='pointer-events-none h-full w-full cursor-grabbing overflow-hidden rounded-lg bg-white shadow-xl ring-1 ring-slate-900/10 dark:bg-card dark:ring-white/10'
    />
  )
}

type Overlay = { node: HTMLElement; host: HTMLElement; height: number; shift: Modifier }

const UNGROUPED: DesignTarget = { kind: 'group', key: UNGROUPED_KEY }
const MEASURING = { droppable: { strategy: MeasuringStrategy.Always } }
// Space picks up (Enter keeps its click: a tab switches, a header selects).
const KEYBOARD_CODES = {
  start: [KeyboardCode.Space],
  cancel: [KeyboardCode.Esc],
  end: [KeyboardCode.Space, KeyboardCode.Enter, KeyboardCode.Tab]
}
const AUTO_SCROLL = { threshold: { x: 0.08, y: 0.15 }, acceleration: 12 }
const INSTRUCTIONS = {
  draggable:
    'Press space to pick this up. Use the arrow keys to choose where it goes, then space or enter to drop it, or escape to cancel.'
}

export function LayoutDndProvider({
  bundle,
  apply,
  children
}: {
  bundle: LayoutBundle | null
  /** useLayoutDraft's apply: one call per drop, one undo step. */
  apply(ops: LayoutOp[], opts?: { label: string }): void
  children: ReactNode
}) {
  const [store] = useState(() => new DndStore())
  // Read by nodes while they render and by the drop handler: always the
  // bundle this render shows.
  store.bundle = bundle
  const applyRef = useRef(apply)
  applyRef.current = apply

  // Nodes read the store through useDesignDndNode; these serve anything else
  // that asks (an inspector, a toolbar).
  const dnd = useMemo<DesignDnd>(
    () => ({
      draggableProps: () => ({}),
      isDragging: (t) => store.state.activeKey === targetKey(t),
      dropSlot: (t) => (store.state.overKey === targetKey(t) ? store.state.side : null),
      dropIndicator: (t) => (store.state.overKey === targetKey(t) ? store.state.indicator : null)
    }),
    [store]
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: typedKeyboardCoordinates,
      keyboardCodes: KEYBOARD_CODES
    })
  )
  const [overlay, setOverlay] = useState<Overlay | null>(null)

  const name = useCallback(
    (x: { data: { current?: unknown } } | null | undefined) => {
      const d = nodeData(x?.data.current)
      if (!d) return 'this'
      if (d.add) return d.add.label
      const t = d.target
      if (t.kind === 'group') {
        if (t.key === '__ungrouped__') return 'Ungrouped fields'
        return store.bundle?.groups.find((g) => g.key === t.key)?.label ?? 'section'
      }
      const el = store.nodes.get(targetKey(t))
      const label = el?.querySelector('label, [data-header-label]')?.textContent?.trim()
      return label || (t.kind === 'slot' ? 'panel' : 'field')
    },
    [store]
  )
  const announcements = useMemo<Announcements>(
    () => ({
      onDragStart: ({ active }) => `Picked up ${name(active)}.`,
      onDragOver: ({ active, over }) =>
        over
          ? `${name(active)} is over ${name(over)}.`
          : `${name(active)} is not over a place it can go.`,
      onDragEnd: ({ active, over }) =>
        over ? `Dropped ${name(active)} by ${name(over)}.` : `Dropped ${name(active)}.`,
      onDragCancel: ({ active }) => `Cancelled. ${name(active)} stays where it was.`
    }),
    [name]
  )

  const reset = () => {
    store.set(IDLE)
    setOverlay(null)
  }

  const onDragStart = ({ active, activatorEvent }: DragStartEvent) => {
    const d = nodeData(active.data.current)
    if (!d) return
    const key = targetKey(d.target)
    store.set({ ...IDLE, activeKey: key })
    const node = store.nodes.get(key)
    if (!node || typeof document === 'undefined') return
    // Inside a modal sheet the preview goes into the sheet (outside it, the
    // modal lock would swallow it); fixed positioning is measured from there.
    const host = (node.closest('[role=dialog]') as HTMLElement | null) ?? document.body
    const origin = fixedOrigin(host)
    const rect = node.getBoundingClientRect()
    // A tall section previews its top part; keep the grab point under the
    // pointer by sliding the preview down to it.
    const grab = getEventCoordinates(activatorEvent)
    const offset = grab ? grab.y - rect.top : 0
    const slide =
      rect.height > OVERLAY_MAX_H && offset > OVERLAY_MAX_H - 32 ? offset - OVERLAY_MAX_H / 2 : 0
    const shift: Modifier = ({ transform }) => ({
      ...transform,
      x: transform.x - origin.x,
      y: transform.y - origin.y + slide
    })
    setOverlay({ node, host, height: Math.min(rect.height, OVERLAY_MAX_H), shift })
  }

  // One drop plan per (bundle, dragged, over, side): what the line shows is
  // exactly what the drop will do.
  const plans = useRef<{ bundle: LayoutBundle | null; map: Map<string, LayoutOp[]> }>({
    bundle: null,
    map: new Map()
  })
  const planFor = (
    active: Active,
    over: Over | null,
    collisions: Collision[] | null
  ): { a: DndNodeData; o: DndNodeData; hint: DropHint; ops: LayoutOp[] } | null => {
    const a = nodeData(active.data.current)
    const o = nodeData(over?.data.current)
    const hint = hintFor(collisions, over?.id)
    const b = store.bundle
    if (!a || !o || !hint || !b || !over) return null
    if (plans.current.bundle !== b) plans.current = { bundle: b, map: new Map() }
    const k = `${active.id}|${over.id}|${hint.side}`
    let ops = plans.current.map.get(k)
    if (!ops) {
      ops = a.add
        ? placeAfterDrop(b, a.add.field, o.target, hint.side, a.add.patch)
        : orderAfterDrop(b, a.target, o.target, hint.side)
      // A slot leaving for the canvas shows its line on the Ungrouped card;
      // where that card is not on screen (steps mode), no line — so no drop.
      if (landsOnCanvas(b, a.target, o.target) && !store.nodes.has(targetKey(UNGROUPED))) ops = []
      plans.current.map.set(k, ops)
    }
    return { a, o, hint, ops }
  }

  const track = ({ active, over, collisions }: DragMoveEvent) => {
    const plan = planFor(active, over, collisions)
    // No line where a drop would do nothing.
    if (!plan || plan.ops.length === 0 || !over) {
      store.set({ overKey: null, side: null, indicator: null })
      return
    }
    let { o, hint } = plan
    let overKey = String(over.id)
    // A slot leaving a section for the Ungrouped zone becomes a slot card
    // beside the Ungrouped card: the line shows there.
    if (store.bundle && landsOnCanvas(store.bundle, plan.a.target, o.target)) {
      overKey = targetKey(UNGROUPED)
      o = {
        target: UNGROUPED,
        role: { kind: 'group', key: UNGROUPED_KEY, parent: null, body: true }
      }
      hint = { side: hint.side, axis: 'y', body: false }
    }
    const overWidth = store.nodes.get(overKey)?.getBoundingClientRect().width ?? 0
    const dragged = active.rect.current.initial?.width ?? null
    store.set({
      overKey,
      side: hint.side,
      indicator: indicatorStyle(hint, o, overWidth, dragged)
    })
  }

  const onDragEnd = ({ active, over, collisions }: DragEndEvent) => {
    const plan = planFor(active, over, collisions)
    const b = store.bundle
    reset()
    if (!plan?.ops.length || !b) return
    const add = plan.a.add
    applyRef.current(plan.ops, { label: add ? `Add ${add.label}` : dropLabel(b, plan.a.target) })
    add?.onAdded?.(plan.ops)
  }

  // The canvas (DesignCanvas) cancels pointerdown in its capture phase so
  // inputs, menus and pickers inside stay inert — and dnd-kit ignores a
  // cancelled pointerdown. This wrapper sees it first and hands it to the
  // innermost node's activator.
  const relay = (e: PointerEvent<HTMLDivElement>) => {
    const el = (e.target as Element | null)?.closest?.('[data-design-target]')
    if (el) store.activators.get(el)?.()?.(e)
  }

  return (
    <DndStoreContext.Provider value={store}>
      <DndApiContext.Provider value={dnd}>
        <DndContext
          sensors={sensors}
          collisionDetection={typedCollision}
          measuring={MEASURING}
          autoScroll={AUTO_SCROLL}
          accessibility={{ announcements, screenReaderInstructions: INSTRUCTIONS }}
          onDragStart={onDragStart}
          onDragMove={track}
          onDragOver={track}
          onDragEnd={onDragEnd}
          onDragCancel={reset}
        >
          <div className='contents' onPointerDownCapture={relay}>
            {children}
          </div>
          {overlay &&
            createPortal(
              <DragOverlay
                dropAnimation={null}
                zIndex={1000}
                modifiers={[overlay.shift]}
                style={{ height: overlay.height }}
              >
                <OverlayCopy node={overlay.node} />
              </DragOverlay>,
              overlay.host
            )}
        </DndContext>
      </DndApiContext.Provider>
    </DndStoreContext.Provider>
  )
}
