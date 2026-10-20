import { useDraggable, useDroppable } from '@dnd-kit/core'
import {
  type CSSProperties,
  createContext,
  type PointerEvent,
  useCallback,
  useContext,
  useId,
  useRef,
  useSyncExternalStore
} from 'react'
import type { LayoutBundle } from '../../../lib/layout-ops'
import { type DesignDnd, type DesignTarget, targetKey } from '../design-context'
import { type DndNodeData, type DropSide, dndRole } from './collision'

// The per-node half of the layout editor's drag and drop: the store a
// LayoutDndProvider shares with its nodes, and the one hook every DesignNode
// (and every tab pane) calls to register with dnd-kit.

export type DragState = {
  activeKey: string | null
  /** The droppable id the drop line shows on (a DesignNode's targetKey, or `body:<group>`). */
  overKey: string | null
  side: DropSide | null
  indicator: CSSProperties | null
}
export const IDLE: DragState = { activeKey: null, overKey: null, side: null, indicator: null }

export class DndStore {
  bundle: LayoutBundle | null = null
  state: DragState = IDLE
  /** Registered element → its pointer activator (dnd-kit's onPointerDown). */
  activators = new WeakMap<Element, () => ((e: PointerEvent) => void) | undefined>()
  /** Droppable id → registered element (the overlay copies it, the drop line measures it). */
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

  /** Remember `el` under `id` (and forget the element it replaces). */
  track(id: string, prev: HTMLElement | null, el: HTMLElement | null) {
    if (prev && this.nodes.get(id) === prev) this.nodes.delete(id)
    if (el) this.nodes.set(id, el)
  }
}

export const DndStoreContext = createContext<DndStore | null>(null)

/** No drag and drop: nodes select but never move. */
export const NO_DND: DesignDnd = {
  draggableProps: () => ({}),
  isDragging: () => false,
  dropSlot: () => null
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

export interface NodeDndOpts {
  /** Inherited nodes, the folded chip copy of a header tile: register nothing. */
  disabled?: boolean
  /** Draggable but never a drop target (a folded header tile in the row). */
  noDrop?: boolean
}

export interface NodeDnd {
  props: object
  dragging: boolean
  slot: DropSide | null
  indicator: CSSProperties | null
}

/**
 * The one drag and drop hook of a DesignNode, called on every render. Inside
 * a LayoutDndProvider it registers the node with dnd-kit as a draggable and a
 * drop target; outside one (tests, hosts without drag and drop) it reads the
 * design's plain `dnd` functions. Same hooks either way, so a canvas may gain
 * or lose its provider, or swap `dnd`, without breaking.
 */
export function useDesignDndNode(dnd: DesignDnd, t: DesignTarget, opts: NodeDndOpts = {}): NodeDnd {
  const store = useContext(DndStoreContext)
  const key = targetKey(t)
  const uid = useId()
  const nodeRef = useRef<HTMLElement | null>(null)
  const role = store?.bundle ? dndRole(store.bundle, t) : null
  const live = !!store && !!role && !opts.disabled
  // A node that is not live never shares an id with the live one.
  const id = live ? key : `${key}#${uid}`
  const data: DndNodeData | undefined = role
    ? {
        target: t,
        role,
        headerHeight: role.kind === 'group' ? () => headerHeight(nodeRef.current) : undefined
      }
    : undefined
  const drag = useDraggable({ id, data, disabled: !live })
  const drop = useDroppable({ id, data, disabled: !live || !!opts.noDrop })
  useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    () => store?.slice(key) ?? '',
    () => ''
  )
  const listeners = useRef(drag.listeners)
  listeners.current = drag.listeners
  const { setNodeRef: setDrag, setActivatorNodeRef } = drag
  const setDrop = drop.setNodeRef
  const ref = useCallback(
    (el: HTMLElement | null) => {
      store?.track(key, nodeRef.current, el)
      nodeRef.current = el
      setDrag(el)
      setDrop(el)
      // Keyboard drags start only from the node itself, never from a button
      // inside it (a section's header, its chevron).
      setActivatorNodeRef(el)
      if (el && store)
        store.activators.set(
          el,
          () => listeners.current?.onPointerDown as ((e: PointerEvent) => void) | undefined
        )
    },
    [key, setActivatorNodeRef, setDrag, setDrop, store]
  )

  if (!store)
    return {
      props: dnd.draggableProps(t, opts.disabled ? { disabled: true } : undefined),
      dragging: dnd.isDragging(t),
      slot: dnd.dropSlot(t),
      indicator: dnd.dropIndicator?.(t) ?? null
    }
  const s = store.state
  const over = s.overKey === key
  return {
    // The pointer activator is not spread here: LayoutDndProvider relays
    // pointerdown to it. The keyboard one stays on the node.
    props: live ? { ref, ...drag.attributes, onKeyDown: drag.listeners?.onKeyDown } : {},
    dragging: s.activeKey === key,
    slot: over ? s.side : null,
    indicator: over ? s.indicator : null
  }
}

/**
 * A tab, step or container-tab pane as a drop target for its group's fields
 * (the pane is not a DesignNode). `ref` goes on an element INSIDE the pane:
 * the pane itself (its parent) is registered, so the form's markup is not
 * changed.
 */
export function useDesignDropBody(groupKey: string) {
  const store = useContext(DndStoreContext)
  const id = `body:${groupKey}`
  const role = store?.bundle ? dndRole(store.bundle, { kind: 'group', key: groupKey }) : null
  const live = role?.kind === 'group' && role.body
  const drop = useDroppable({
    id,
    data: { target: { kind: 'group', key: groupKey }, role: { kind: 'body', key: groupKey } },
    disabled: !live
  })
  useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    () => store?.slice(id) ?? '',
    () => ''
  )
  const paneRef = useRef<HTMLElement | null>(null)
  const setDrop = drop.setNodeRef
  const ref = useCallback(
    (el: HTMLElement | null) => {
      const pane = el?.parentElement ?? null
      store?.track(id, paneRef.current, pane)
      paneRef.current = pane
      setDrop(pane)
      // The drop line is placed inside the pane.
      if (pane && getComputedStyle(pane).position === 'static') pane.style.position = 'relative'
    },
    [id, setDrop, store]
  )
  const over = store?.state.overKey === id
  return {
    ref,
    slot: over ? (store?.state.side ?? null) : null,
    indicator: over ? (store?.state.indicator ?? null) : null
  }
}
