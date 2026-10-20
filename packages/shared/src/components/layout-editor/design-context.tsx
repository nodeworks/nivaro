import { type CSSProperties, createContext, useContext } from 'react'
import type { ActiveLayoutData } from '../item-edit/types'
import type { RefusedWrite } from './design-canvas'

export type DesignTarget =
  | { kind: 'field'; field: string; group_key: string | null }
  | { kind: 'group'; key: string }
  | { kind: 'slot'; field: string; group_key: string | null }
  | { kind: 'header'; field: string }

export interface LayoutDesign {
  selected: DesignTarget | null
  onSelect(t: DesignTarget): void
  showHidden: boolean
  /** Parent layout name when the node comes from an inherited layout, else null. */
  inheritedFrom(t: DesignTarget): string | null
  dnd: DesignDnd
}

/**
 * Drag and drop state for design nodes. Plain functions, no hooks: inside a
 * LayoutDndProvider every DesignNode registers through the provider's store
 * (useDesignDndNode) and these only answer questions; outside one (tests,
 * hosts without drag and drop) DesignNode takes its props and state from
 * here. `disabled` (inherited nodes, the folded copy of a header tile) asks
 * for no drag props. Passing NO_DND (dnd/node.ts) turns dragging off even
 * inside a provider.
 */
export interface DesignDnd {
  draggableProps(t: DesignTarget, opts?: { disabled?: boolean }): object
  isDragging(t: DesignTarget): boolean
  dropSlot(t: DesignTarget): 'before' | 'after' | null
  /** Where the insertion line sits inside the node (absolute; no layout shift). */
  dropIndicator?(t: DesignTarget): CSSProperties | null
}

/**
 * The `design` prop of every renderer the layout editor uses as its canvas
 * (ItemEditForm, RecordReadView, RecordDrilldownSheet).
 */
export interface LayoutDesignProp {
  /** The draft layout — rendered instead of the server's resolved layout. */
  layout: ActiveLayoutData
  /** Preview record (its values, steps and rules); null/absent = no values. */
  record?: Record<string, unknown> | null
  context: LayoutDesign
  /** Something on the canvas tried to write and was refused (tests, dev tooling). */
  onRefusedWrite?: (w: RefusedWrite) => void
}

export const LayoutDesignContext = createContext<LayoutDesign | null>(null)

export function useLayoutDesign(): LayoutDesign | null {
  return useContext(LayoutDesignContext)
}

export function targetKey(t: DesignTarget): string {
  switch (t.kind) {
    case 'field':
    case 'slot':
      return `${t.kind}:${t.field}:${t.group_key ?? ''}`
    case 'group':
      return `group:${t.key}`
    case 'header':
      return `header:${t.field}`
  }
}
