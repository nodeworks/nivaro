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
  type UniqueIdentifier,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import { getEventCoordinates } from '@dnd-kit/utilities'
import { Plus } from 'lucide-react'
import {
  type CSSProperties,
  createContext,
  type PointerEvent,
  type ReactNode,
  type TouchEvent,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { createPortal } from 'react-dom'
import { type LayoutBundle, type LayoutOp, UNGROUPED_KEY } from '../../../lib/layout-ops'
import { type DesignDnd, type DesignTarget, targetKey } from '../design-context'
import { mergeBlocked, mergePlan } from '../section-structure'
import {
  type DndNodeData,
  type DropHint,
  dndRole,
  nodeData,
  typedKeyboardCoordinates
} from './collision'
import { mergeAwareCollision, mergeIndicatorStyle } from './merge-drop'
import { carriedTargets, copyAfterDrop, type DropMode, dropMany, manyLabel } from './multi-drop'
import { DndStore, DndStoreContext, IDLE, NO_DND } from './node'
import { dropLabel, landsOnCanvas, orderAfterDrop, placeAfterDrop } from './order'
import { copyableGroup, railAwareCollision, railDropData } from './rail-drop'
import { MOUSE_ACTIVATION, MousePointerSensor, TOUCH_ACTIVATION, TouchSensor } from './sensors'
import { TrashZone } from './TrashZone'
import {
  TRASH_DROP_ID,
  type TrashPlan,
  trashAwareCollision,
  trashDropData,
  trashPlan,
  trashPlanMany
} from './trash-drop'
import type { TrashWarning } from './trash-links'
import { UndoChip } from './UndoChip'

export { NO_DND }

// Drag and drop on the layout editor canvas (spec §7.5). Every DesignNode is
// draggable and a drop target; what may land where is typedCollision's call,
// the order a drop makes is orderAfterDrop's, and a drop is applied as one
// op batch. Nothing on the form moves while dragging: the dragged node dims,
// a DragOverlay copy follows the pointer, and an insertion line (absolutely
// placed, so no reflow) shows where it will land. Add panel rows
// (useAddDragSource) drag the same way; their drop is placeAfterDrop's one
// `place` op. A drag that starts on one of several selected fields carries
// them all (#3178); Alt copies instead of moving (#3199); a section over
// another section's header joins it (#3198); a finger presses and holds to
// drag (#3193); a trash drop leaves an Undo chip where it happened (#3204).

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
  if (hint.merge) return mergeIndicatorStyle(over.headerHeight?.() ?? 0)
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
  // The dragging dim and a step's chevron shape belong to the form, not the
  // preview: a step or tab copies as a plain, readable card.
  copy.classList.remove('opacity-40')
  if (copy.style.clipPath) {
    copy.style.clipPath = 'none'
    copy.style.transform = 'none'
    copy.style.overflow = 'visible'
    copy.style.borderRadius = '0'
    copy.style.height = '100%'
    for (const el of Array.from(copy.querySelectorAll<HTMLElement>('*')))
      if (el.style.clipPath) {
        el.style.clipPath = 'none'
        el.style.borderRadius = '0'
      }
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

function OverlayCopy({
  node,
  store,
  count
}: {
  node: HTMLElement
  store: DndStore
  /** #3178: how many things the drag carries (a badge from 2). */
  count: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Over the trash the copy shrinks and fades toward its top-left corner (away from the
  // pointer), so the trash's "Release to remove …" stays readable under it.
  const overTrash = useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.state.overKey === TRASH_DROP_ID, [store]),
    () => false
  )
  // #3199: Alt held — the drop copies.
  const copy = useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.state.copy, [store]),
    () => false
  )
  useLayoutEffect(() => {
    const host = ref.current
    if (!host) return
    host.replaceChildren(designClone(node))
    return () => host.replaceChildren()
  }, [node])
  const badge =
    count > 1 || copy ? (
      <span
        data-design-drag-badge={copy ? 'copy' : 'count'}
        className='absolute -right-2 -top-2 z-10 inline-flex h-6 min-w-6 items-center justify-center gap-0.5 rounded-full bg-nvr-cyan px-1.5 text-[11.5px] font-semibold text-white shadow-md ring-2 ring-white dark:ring-[#0f172a]'
      >
        {copy && <Plus aria-hidden className='h-3 w-3' />}
        {count > 1 ? count : copy ? 'Copy' : null}
      </span>
    ) : null
  return (
    <div
      aria-hidden
      data-design-drag-preview=''
      data-over-trash={overTrash ? '' : undefined}
      data-copy={copy ? '' : undefined}
      style={{
        transformOrigin: 'top left',
        transform: overTrash ? 'scale(0.4)' : undefined,
        opacity: overTrash ? 0.45 : undefined
      }}
      className='pointer-events-none relative h-full w-full cursor-grabbing transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none'
    >
      {/* Several carried: a second card peeks out behind the first. */}
      {count > 1 && (
        <span className='absolute inset-0 translate-x-1.5 translate-y-1.5 rounded-lg bg-white shadow-lg ring-1 ring-slate-900/10 dark:bg-card dark:ring-white/10' />
      )}
      <div
        ref={ref}
        className='relative h-full w-full overflow-hidden rounded-lg bg-white shadow-xl ring-1 ring-slate-900/10 dark:bg-card dark:ring-white/10'
      />
      {badge}
      {/* The cursor says it too, wherever the pointer is. */}
      {copy && <style>{'*{cursor:copy !important}'}</style>}
    </div>
  )
}

type Overlay = { node: HTMLElement; host: HTMLElement; height: number; shift: Modifier }

/** The undo chip after a trash drop (#3204). */
type Chip = {
  label: string
  /** The undo step's name the drop made; the chip lives while Undo would reverse it. */
  applied: string
  point: { x: number; y: number }
  host: HTMLElement
  origin: { x: number; y: number }
  /** Set once the draft reports the step (the chip then follows its undo label). */
  armed: boolean
}

const UNGROUPED: DesignTarget = { kind: 'group', key: UNGROUPED_KEY }
const MEASURING = { droppable: { strategy: MeasuringStrategy.Always } }
// Space picks up (Enter keeps its click: a tab switches, a header selects).
const KEYBOARD_CODES = {
  start: [KeyboardCode.Space],
  cancel: [KeyboardCode.Esc],
  end: [KeyboardCode.Space, KeyboardCode.Enter, KeyboardCode.Tab]
}
const INSTRUCTIONS = {
  draggable:
    'Press space to pick this up. Use the arrow keys to choose where it goes, then space or enter to drop it, or escape to cancel. Hold Alt to copy instead of moving.'
}

type DropPlan = { a: DndNodeData; o: DndNodeData; hint: DropHint; ops: LayoutOp[]; label: string }

export function LayoutDndProvider({
  bundle,
  apply,
  onDragActive,
  onDropOnLayout,
  selection,
  undo,
  warnTrash,
  children
}: {
  bundle: LayoutBundle | null
  /** useLayoutDraft's apply: one call per drop, one undo step. */
  apply(ops: LayoutOp[], opts?: { label: string }): void
  /** Told when a drag starts (true) and ends or is cancelled (false). Hosts
   *  whose own Escape handler runs before dnd-kit's (registered at drag start)
   *  leave Escape to the drag while one is on. */
  onDragActive?: (active: boolean) => void
  /** #2584: a section was dropped on a layout in the Layouts rail — copy it there. */
  onDropOnLayout?: (groupKey: string, layoutId: number) => void
  /** #3178: the canvas selection — a drag that starts on one of several selected fields moves them all. */
  selection?: DesignTarget[]
  /** #3204: the draft's undo and the label of the step it would reverse (the trash's Undo chip). */
  undo?: { run(): void; label: string | null }
  /** #3190: what depends on what a trash drop would take off the form. */
  warnTrash?: (bundle: LayoutBundle, ops: LayoutOp[]) => TrashWarning | null
  children: ReactNode
}) {
  const [store] = useState(() => new DndStore())
  // Read by nodes while they render and by the drop handler: always the
  // bundle this render shows.
  store.bundle = bundle
  const applyRef = useRef(apply)
  applyRef.current = apply
  const dropOnLayoutRef = useRef(onDropOnLayout)
  dropOnLayoutRef.current = onDropOnLayout
  const selectionRef = useRef(selection ?? [])
  selectionRef.current = selection ?? []
  const warnRef = useRef(warnTrash)
  warnRef.current = warnTrash
  const undoRef = useRef(undo)
  undoRef.current = undo
  // What the current drag carries (#3178): the dragged node, or the selection it belongs to.
  const carried = useRef<DesignTarget[]>([])
  // Rail rows take a dragged section only when the host copies (onDropOnLayout).
  // The trash (dnd/trash-drop.ts) wins over everything under the pointer, then rail rows;
  // a section over another section's header joins it (dnd/merge-drop.ts).
  const [collision] = useState(() =>
    trashAwareCollision(
      mergeAwareCollision(
        railAwareCollision(
          (d) => !!dropOnLayoutRef.current && copyableGroup(store.bundle, d) != null
        ),
        (a, o) =>
          !store.state.copy &&
          a.target.kind === 'group' &&
          o.target.kind === 'group' &&
          !!store.bundle &&
          mergeBlocked(store.bundle, a.target.key, o.target.key) === null
      ),
      (d) => trashPlan(store.bundle, d) != null
    )
  )
  // No auto-scroll while the pointer rests on the trash at the bottom of the screen.
  const [autoScroll] = useState(() => ({
    threshold: { x: 0.08, y: 0.15 },
    acceleration: 12,
    canScroll: () => store.state.overKey !== TRASH_DROP_ID
  }))
  // What the trash would do with the current drag (null: the trash does not show).
  const [trash, setTrash] = useState<{
    plan: TrashPlan
    name: string
    warning: TrashWarning | null
  } | null>(null)
  const [chip, setChip] = useState<Chip | null>(null)

  // Nodes read the store through useDesignDndNode; these serve anything else
  // that asks (an inspector, a toolbar).
  const dnd = useMemo<DesignDnd>(
    () => ({
      draggableProps: () => ({}),
      isDragging: (t) => store.isCarried(targetKey(t)),
      dropSlot: (t) => (store.state.overKey === targetKey(t) ? store.state.side : null),
      dropIndicator: (t) => (store.state.overKey === targetKey(t) ? store.state.indicator : null)
    }),
    [store]
  )

  // #3193: a mouse or pen drags after 4px; a finger presses and holds first.
  const sensors = useSensors(
    useSensor(MousePointerSensor, { activationConstraint: MOUSE_ACTIVATION }),
    useSensor(TouchSensor, { activationConstraint: TOUCH_ACTIVATION }),
    useSensor(KeyboardSensor, {
      coordinateGetter: typedKeyboardCoordinates,
      keyboardCodes: KEYBOARD_CODES
    })
  )
  const [overlay, setOverlay] = useState<Overlay | null>(null)

  const nameOf = useCallback(
    (d: DndNodeData | null) => {
      if (!d) return 'this'
      if (d.add) return d.add.label
      const t = d.target
      if (t.kind === 'group') {
        if (t.key === '__ungrouped__') return 'Ungrouped fields'
        return store.bundle?.groups.find((g) => g.key === t.key)?.label ?? 'section'
      }
      const el = store.nodes.get(targetKey(t))
      // Without the required mark ("Description *").
      const label = el
        ?.querySelector('label, [data-header-label]')
        ?.textContent?.replace(/\s*\*\s*$/, '')
        .trim()
      return label || (t.kind === 'slot' ? 'panel' : 'field')
    },
    [store]
  )
  const name = useCallback(
    (x: { data: { current?: unknown } } | null | undefined) => nameOf(nodeData(x?.data.current)),
    [nameOf]
  )
  // The dragged thing, or "3 fields" when a selection is carried.
  const dragName = useCallback(
    (x: { data: { current?: unknown } } | null | undefined) =>
      carried.current.length > 1
        ? manyLabel(carried.current, 'move').replace(/^Move /, '')
        : name(x),
    [name]
  )
  const announcements = useMemo<Announcements>(
    () => ({
      onDragStart: ({ active }) => `Picked up ${dragName(active)}.`,
      onDragOver: ({ active, over }) =>
        over && trashDropData(over.data.current)
          ? `${dragName(active)} is over Remove. Drop it to take it off this form.`
          : over && store.state.merge && store.state.overKey === String(over.id)
            ? `${dragName(active)} is over ${name(over)}. Drop it to join them.`
            : over
              ? `${dragName(active)} is over ${name(over)}${store.state.copy ? '. Dropping copies it' : ''}.`
              : `${dragName(active)} is not over a place it can go.`,
      onDragEnd: ({ active, over }) =>
        over && trashDropData(over.data.current)
          ? `Removed ${dragName(active)} from this form. Undo brings it back.`
          : over
            ? `Dropped ${dragName(active)} by ${name(over)}.`
            : `Dropped ${dragName(active)}.`,
      onDragCancel: ({ active }) => `Cancelled. ${dragName(active)} stays where it was.`
    }),
    [name, dragName, store]
  )

  const lastMove = useRef<DragMoveEvent | null>(null)
  const reset = () => {
    store.set(IDLE)
    carried.current = []
    lastMove.current = null
    setOverlay(null)
    setTrash(null)
    onDragActive?.(false)
  }

  const onDragStart = ({ active, activatorEvent }: DragStartEvent) => {
    onDragActive?.(true)
    setChip(null)
    const d = nodeData(active.data.current)
    if (!d) return
    const key = targetKey(d.target)
    const b = store.bundle
    carried.current = d.add ? [d.target] : carriedTargets(b, selectionRef.current, d.target)
    const many = carried.current.length > 1
    const alt = !d.add && !!(activatorEvent as { altKey?: boolean } | null)?.altKey
    store.set({
      ...IDLE,
      activeKey: key,
      carried: many ? carried.current.map(targetKey) : null,
      copy: alt
    })
    const removable = many
      ? trashPlanMany(
          b,
          carried.current.map((t) => {
            const role = b ? dndRole(b, t) : null
            return role ? { target: t, role } : null
          })
        )
      : trashPlan(b, d)
    setTrash(
      removable && b
        ? {
            plan: removable,
            name: many ? dragName(active) : name(active),
            warning: warnRef.current?.(b, removable.ops) ?? null
          }
        : null
    )
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

  // One drop plan per (bundle, dragged, over, side, mode): what the line shows
  // is exactly what the drop will do.
  const plans = useRef<{ bundle: LayoutBundle | null; map: Map<string, DropPlan | null> }>({
    bundle: null,
    map: new Map()
  })
  const planFor = (
    active: Active,
    over: Over | null,
    collisions: Collision[] | null
  ): DropPlan | null => {
    const a = nodeData(active.data.current)
    const o = nodeData(over?.data.current)
    const hint = hintFor(collisions, over?.id)
    const b = store.bundle
    if (!a || !o || !hint || !b || !over) return null
    if (plans.current.bundle !== b) plans.current = { bundle: b, map: new Map() }
    const mode: DropMode = store.state.copy && !a.add ? 'copy' : 'move'
    const many = carried.current.length > 1
    const k = `${active.id}|${over.id}|${hint.side}|${hint.merge ? 'join' : ''}|${mode}|${many ? carried.current.length : 1}`
    if (plans.current.map.has(k)) return plans.current.map.get(k) ?? null
    let ops: LayoutOp[] = []
    let label = ''
    if (hint.merge && a.target.kind === 'group' && o.target.kind === 'group') {
      const plan = mergePlan(b, a.target.key, o.target.key)
      if (plan.ok) {
        ops = plan.ops
        label = plan.label
      }
    } else if (a.add) {
      ops = placeAfterDrop(b, a.add.field, o.target, hint.side, a.add.patch)
      label = `Add ${a.add.label}`
    } else if (many) {
      ops = dropMany(b, carried.current, o.target, hint.side, mode)
      label = manyLabel(carried.current, mode)
    } else if (mode === 'copy') {
      ops = copyAfterDrop(b, a.target, o.target, hint.side)
      label = copyLabel(b, a.target, nameOf(a))
    } else {
      ops = orderAfterDrop(b, a.target, o.target, hint.side)
      label = dropLabel(b, a.target)
      // A slot leaving for the canvas shows its line on the Ungrouped card;
      // where that card is not on screen (steps mode), no line — so no drop.
      if (landsOnCanvas(b, a.target, o.target) && !store.nodes.has(targetKey(UNGROUPED))) ops = []
    }
    const plan = { a, o, hint, ops, label }
    plans.current.map.set(k, plan)
    return plan
  }

  const track = (e: DragMoveEvent) => {
    lastMove.current = e
    const { active, over, collisions } = e
    // Over the trash: it lights up, no line on the form.
    if (over && trashDropData(over.data.current)) {
      store.set({ overKey: TRASH_DROP_ID, side: null, indicator: null, merge: null })
      return
    }
    // Over a layout in the rail: that row lights up, no line on the form.
    if (over && railDropData(over.data.current)) {
      store.set({ overKey: String(over.id), side: null, indicator: null, merge: null })
      return
    }
    const plan = planFor(active, over, collisions)
    // No line where a drop would do nothing.
    if (!plan || plan.ops.length === 0 || !over) {
      store.set({ overKey: null, side: null, indicator: null, merge: null })
      return
    }
    let { o, hint } = plan
    let overKey = String(over.id)
    // A slot leaving a section for the Ungrouped zone becomes a slot card
    // beside the Ungrouped card: the line shows there.
    const single = carried.current.length <= 1 && !store.state.copy && !hint.merge
    if (single && store.bundle && landsOnCanvas(store.bundle, plan.a.target, o.target)) {
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
      indicator: indicatorStyle(hint, o, overWidth, dragged),
      merge: hint.merge ? nameOf(o) : null
    })
  }

  // #3199: Alt held during a drag copies. Read from the keys and from every
  // pointer move (Alt pressed while the window was not focused); the line is
  // worked out again at once.
  const dragging = overlay != null || trash != null
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-reads the live drag through refs
  useEffect(() => {
    if (!dragging) return
    const set = (alt: boolean) => {
      if (!store.state.activeKey || store.state.copy === alt) return
      const d = lastMove.current ? nodeData(lastMove.current.active.data.current) : null
      if (d?.add) return
      store.set({ copy: alt })
      if (lastMove.current) track(lastMove.current)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') return
      // Alt alone would focus the browser's menu bar on Windows.
      e.preventDefault()
      set(e.type === 'keydown')
    }
    const onMove = (e: globalThis.PointerEvent) => set(e.altKey)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    window.addEventListener('pointermove', onMove, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
      window.removeEventListener('pointermove', onMove, true)
    }
  }, [dragging, store])

  const onDragEnd = ({ active, over, collisions, activatorEvent, delta }: DragEndEvent) => {
    if (trashDropData(over?.data.current)) {
      const b = store.bundle
      const many = carried.current.length > 1
      const removal = many
        ? trashPlanMany(
            b,
            carried.current.map((t) => {
              const role = b ? dndRole(b, t) : null
              return role ? { target: t, role } : null
            })
          )
        : trashPlan(b, nodeData(active.data.current))
      const label = dragName(active)
      const node = store.nodes.get(String(active.id))
      const host =
        (node?.closest('[role=dialog]') as HTMLElement | null) ??
        (typeof document === 'undefined' ? null : document.body)
      const start = getEventCoordinates(activatorEvent)
      reset()
      if (!removal) return
      const applied = `Remove ${label}`
      applyRef.current(removal.ops, { label: applied })
      // #3204: Undo, right where it was dropped.
      if (undoRef.current && host && start)
        setChip({
          label,
          applied,
          point: { x: start.x + delta.x, y: start.y + delta.y },
          host,
          origin: fixedOrigin(host),
          armed: false
        })
      return
    }
    const rail = railDropData(over?.data.current)
    if (rail) {
      const key = copyableGroup(store.bundle, nodeData(active.data.current))
      reset()
      if (key) dropOnLayoutRef.current?.(key, rail.railLayoutId)
      return
    }
    const plan = planFor(active, over, collisions)
    const b = store.bundle
    reset()
    if (!plan?.ops.length || !b) return
    const add = plan.a.add
    applyRef.current(plan.ops, { label: plan.label })
    add?.onAdded?.(plan.ops)
  }

  const undoLabel = undo?.label ?? null
  if (chip && !chip.armed && undoLabel === chip.applied) chip.armed = true
  const chipLive = !!chip && (!chip.armed || undoLabel === chip.applied)

  // The canvas (DesignCanvas) cancels pointerdown in its capture phase so
  // inputs, menus and pickers inside stay inert — and dnd-kit ignores a
  // cancelled pointerdown. This wrapper sees it first and hands it to the
  // innermost node's activator. Touches go the same way (#3193).
  const relay = (e: PointerEvent<HTMLDivElement> | TouchEvent<HTMLDivElement>) => {
    // A width handle (#2701) drags the width, not the field.
    if ((e.target as Element | null)?.closest?.('[data-design-resize]')) return
    const el = (e.target as Element | null)?.closest?.('[data-design-target]')
    if (!el) return
    const listeners = store.activators.get(el)?.()
    listeners?.[e.type === 'touchstart' ? 'onTouchStart' : 'onPointerDown']?.(e)
  }

  return (
    <DndStoreContext.Provider value={store}>
      <DndApiContext.Provider value={dnd}>
        <DndContext
          sensors={sensors}
          collisionDetection={collision}
          measuring={MEASURING}
          autoScroll={autoScroll}
          accessibility={{ announcements, screenReaderInstructions: INSTRUCTIONS }}
          onDragStart={onDragStart}
          onDragMove={track}
          onDragOver={track}
          onDragEnd={onDragEnd}
          onDragCancel={reset}
        >
          <div className='contents' onPointerDownCapture={relay} onTouchStartCapture={relay}>
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
                <OverlayCopy
                  node={overlay.node}
                  store={store}
                  count={Math.max(1, carried.current.length)}
                />
              </DragOverlay>,
              overlay.host
            )}
          {trash &&
            createPortal(
              <TrashZone
                store={store}
                plan={trash.plan}
                name={trash.name}
                warning={trash.warning}
              />,
              overlay?.host ?? document.body
            )}
          {chip &&
            undo &&
            createPortal(
              <UndoChip
                label={chip.label}
                point={chip.point}
                origin={chip.origin}
                stillUndoable={chipLive}
                onUndo={() => undoRef.current?.run()}
                onClose={() => setChip(null)}
              />,
              chip.host
            )}
        </DndContext>
      </DndApiContext.Provider>
    </DndStoreContext.Provider>
  )
}

/** The undo step's name for an Alt-drop (#3199). */
function copyLabel(b: LayoutBundle, t: DesignTarget, name: string): string {
  if (t.kind === 'group') {
    const g = b.groups.find((x) => x.key === t.key)
    return `Copy ${g?.type === 'tab' ? 'tab' : 'section'} "${g?.label || name}"`
  }
  return `Copy ${name}`
}
