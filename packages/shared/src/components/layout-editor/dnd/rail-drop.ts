import { type CollisionDetection, useDroppable } from '@dnd-kit/core'
import { useCallback, useContext, useSyncExternalStore } from 'react'
import { type LayoutBundle, UNGROUPED_KEY } from '../../../lib/layout-ops'
import { type DndNodeData, nodeData, TABLE_FORM_ZONES, typedCollision } from './collision'
import { DndStoreContext } from './node'

// #2584: drag a section from the canvas onto a layout in the Layouts rail to
// copy it there (with its tabs, fields and settings). Rail rows are droppables
// of their own kind: typedCollision never sees them (no DndNodeData), and
// railAwareCollision lets only a real section land on one.

const PREFIX = 'rail-layout:'

export interface RailDropData {
  railLayoutId: number
}

export const railDropId = (layoutId: number) => `${PREFIX}${layoutId}`

export function railDropData(v: unknown): RailDropData | null {
  const d = v as RailDropData | null | undefined
  return d && typeof d.railLayoutId === 'number' ? d : null
}

/** The section key a drag would copy: a real group of the layout (never the Ungrouped zone,
 *  a table form zone, a slot card or an Add panel row). */
export function copyableGroup(bundle: LayoutBundle | null, d: DndNodeData | null): string | null {
  if (!bundle || !d || d.add || d.target.kind !== 'group' || d.role.kind !== 'group') return null
  const key = d.target.key
  if (key === UNGROUPED_KEY || TABLE_FORM_ZONES.includes(key)) return null
  return bundle.groups.some((g) => g.key === key) ? key : null
}

type Rect = { left: number; right: number; top: number; bottom: number }
const inside = (r: Rect, p: { x: number; y: number }) =>
  p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom

/**
 * typedCollision, plus: a dragged section whose pointer is over a rail row
 * collides with that row. Pointer only — the keyboard path is the section's
 * "Copy to layout…" action.
 */
export function railAwareCollision(isCopyable: (d: DndNodeData | null) => boolean) {
  const detect: CollisionDetection = (args) => {
    const p = args.pointerCoordinates
    if (p && isCopyable(nodeData(args.active.data.current))) {
      for (const c of args.droppableContainers) {
        if (c.disabled || !railDropData(c.data.current)) continue
        const r = args.droppableRects.get(c.id)
        if (r && inside(r, p)) return [{ id: c.id, data: { droppableContainer: c } }]
      }
    }
    return typedCollision(args)
  }
  return detect
}

const NO_STORE = { subscribe: () => () => {}, over: () => false, active: () => false }

/**
 * One rail row as a drop target. `over`: a section is over it now; `armed`: a
 * section is being dragged (rows show they take it).
 */
export function useRailDrop(layoutId: number, disabled: boolean) {
  const store = useContext(DndStoreContext)
  const id = railDropId(layoutId)
  const { setNodeRef } = useDroppable({
    id,
    data: { railLayoutId: layoutId } satisfies RailDropData,
    disabled: disabled || !store
  })
  const subscribe = store?.subscribe ?? NO_STORE.subscribe
  const over = useSyncExternalStore(
    subscribe,
    useCallback(() => !!store && store.state.overKey === id, [store, id]),
    () => false
  )
  const armed = useSyncExternalStore(
    subscribe,
    useCallback(() => {
      const k = store?.state.activeKey
      return !!k && k.startsWith('group:') && k !== `group:${UNGROUPED_KEY}`
    }, [store]),
    () => false
  )
  return { ref: setNodeRef, over: over && !disabled, armed: armed && !disabled }
}
