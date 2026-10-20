import { createContext, useContext } from 'react'
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
  dnd: {
    draggableProps(t: DesignTarget): object
    isDragging(t: DesignTarget): boolean
    dropSlot(t: DesignTarget): 'before' | 'after' | null
  }
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
