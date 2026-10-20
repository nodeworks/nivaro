import {
  type Announcements,
  type Collision,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  MeasuringStrategy,
  type Modifier,
  PointerSensor,
  type UniqueIdentifier,
  useDraggable,
  useDroppable,
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
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { createPortal } from 'react-dom'
import type { LayoutBundle, LayoutOp } from '../../../lib/layout-ops'
import { type DesignDnd, type DesignTarget, targetKey } from '../design-context'
import {
  type DndNodeData,
  type DropHint,
  type DropSide,
  dndRole,
  nodeData,
  typedCollision,
  typedKeyboardCoordinates
} from './collision'
import { dropLabel, orderAfterDrop } from './order'

// Drag and drop on the layout editor canvas (spec §7.5). Every DesignNode is
// draggable and a drop target; what may land where is typedCollision's call,
// the order a drop makes is orderAfterDrop's, and a drop is applied as one
// op batch. Nothing on the form moves while dragging: the dragged node dims,
// a DragOverlay copy follows the pointer, and an insertion line (absolutely
// placed, so no reflow) shows where it will land.

type DragState = {
  activeKey: string | null
  overKey: string | null
  side: DropSide | null
  indicator: CSSProperties | null
}
const IDLE: DragState = { activeKey: null, overKey: null, side: null, indicator: null }

class DndStore {
  bundle: LayoutBundle | null = null
  state: DragState = IDLE
  /** Registered element → its pointer activator (dnd-kit's onPointerDown). */
  activators = new WeakMap<Element, () => ((e: PointerEvent) => void) | undefined>()
  /** Target key → registered element (the overlay copies it, the indicator measures it). */
  nodes = new Map<string, HTMLElement>()
  private subs = new Set<() => void>()

  subscribe = (fn: () => void) => {
    this.subs.add(fn)
    return () => {
      this.subs.delete(fn)
    }
  }

  set(next: Partial<DragState>) {
    const s = { ...this.state, ...next }
    const cur = this.state
    if (
      s.activeKey === cur.activeKey &&
      s.overKey === cur.overKey &&
      s.side === cur.side &&
      JSON.stringify(s.indicator) === JSON.stringify(cur.indicator)
    )
      return
    this.state = s
    for (const fn of this.subs) fn()
  }

  /** What one node renders from: a node re-renders only when its slice changes. */
  slice(key: string): string {
    const s = this.state
    const over = s.overKey === key ? `${s.side}${JSON.stringify(s.indicator)}` : ''
    return `${s.activeKey === key ? 1 : 0}|${over}`
  }
}

const DndStoreContext = createContext<DndStore | null>(null)

/** No drag and drop: nodes select but never move. */
export const NO_DND: DesignDnd = {
  draggableProps: () => ({}),
  isDragging: () => false,
  dropSlot: () => null
}

const DndApiContext = createContext<DesignDnd>(NO_DND)

/** The `dnd` part of LayoutDesign, from the nearest LayoutDndProvider (NO_DND outside one). */
export function useLayoutDnd(): DesignDnd {
  return useContext(DndApiContext)
}

const noSubscribe = () => () => {}

// A section's header strip height, measured live: a field dropped there goes
// first in the section.
function headerHeight(el: HTMLElement | null): number {
  if (!el) return 0
  const header = Array.from(el.querySelectorAll('[data-design-group-header]')).find(
    (h) => h.closest('[data-design-target]') === el
  )
  return header ? header.getBoundingClientRect().bottom - el.getBoundingClientRect().top : 0
}

// LayoutDesign.dnd.draggableProps: registers the node with dnd-kit as both a
// draggable and a drop target. Called once per DesignNode render (a hook).
function useDesignDndNode(t: DesignTarget, opts?: { disabled?: boolean }): object {
  const store = useContext(DndStoreContext)
  const key = targetKey(t)
  const uid = useId()
  const nodeRef = useRef<HTMLElement | null>(null)
  const role = store?.bundle ? dndRole(store.bundle, t) : null
  const disabled = !store || !role || !!opts?.disabled
  // A disabled node never shares an id with the live one.
  const id = disabled ? `${key}#${uid}` : key
  const data: DndNodeData | undefined = role
    ? {
        target: t,
        role,
        headerHeight: role.kind === 'group' ? () => headerHeight(nodeRef.current) : undefined
      }
    : undefined
  const drag = useDraggable({ id, data, disabled })
  const drop = useDroppable({ id, data, disabled })
  useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    () => store?.slice(key) ?? '',
    () => ''
  )
  const listeners = useRef(drag.listeners)
  listeners.current = drag.listeners
  const setDrag = drag.setNodeRef
  const setDrop = drop.setNodeRef
  const ref = useCallback(
    (el: HTMLElement | null) => {
      const prev = nodeRef.current
      if (prev && store?.nodes.get(key) === prev) store.nodes.delete(key)
      nodeRef.current = el
      setDrag(el)
      setDrop(el)
      if (el && store) {
        store.nodes.set(key, el)
        store.activators.set(
          el,
          () => listeners.current?.onPointerDown as ((e: PointerEvent) => void) | undefined
        )
      }
    },
    [key, setDrag, setDrop, store]
  )
  if (disabled) return {}
  // The pointer activator is not spread here: LayoutDndProvider relays
  // pointerdown to it (see `relay`). The keyboard one stays on the node.
  return { ref, ...drag.attributes, onKeyDown: drag.listeners?.onKeyDown }
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

const MEASURING = { droppable: { strategy: MeasuringStrategy.Always } }
const AUTO_SCROLL = { threshold: { x: 0.08, y: 0.15 }, acceleration: 12 }
const INSTRUCTIONS = {
  draggable:
    'Press space or enter to pick this up. Use the arrow keys to choose where it goes, then space or enter to drop it, or escape to cancel.'
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

  const dnd = useMemo<DesignDnd>(
    () => ({
      draggableProps: useDesignDndNode,
      isDragging: (t) => store.state.activeKey === targetKey(t),
      dropSlot: (t) => (store.state.overKey === targetKey(t) ? store.state.side : null),
      dropIndicator: (t) => (store.state.overKey === targetKey(t) ? store.state.indicator : null)
    }),
    [store]
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: typedKeyboardCoordinates })
  )
  const [overlay, setOverlay] = useState<Overlay | null>(null)

  const name = useCallback(
    (x: { data: { current?: unknown } } | null | undefined) => {
      const d = nodeData(x?.data.current)
      if (!d) return 'this'
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

  const track = ({ active, over, collisions }: DragMoveEvent) => {
    const a = nodeData(active.data.current)
    const o = nodeData(over?.data.current)
    const hint = hintFor(collisions, over?.id)
    if (!a || !o || !hint || targetKey(o.target) === targetKey(a.target)) {
      store.set({ overKey: null, side: null, indicator: null })
      return
    }
    const overKey = targetKey(o.target)
    const overWidth = store.nodes.get(overKey)?.getBoundingClientRect().width ?? 0
    const dragged = active.rect.current.initial?.width ?? null
    store.set({
      overKey,
      side: hint.side,
      indicator: indicatorStyle(hint, o, overWidth, dragged)
    })
  }

  const onDragEnd = ({ active, over, collisions }: DragEndEvent) => {
    const a = nodeData(active.data.current)
    const o = nodeData(over?.data.current)
    const hint = hintFor(collisions, over?.id)
    const b = store.bundle
    reset()
    if (!a || !o || !hint || !b) return
    const ops = orderAfterDrop(b, a.target, o.target, hint.side)
    if (ops.length) applyRef.current(ops, { label: dropLabel(b, a.target) })
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
