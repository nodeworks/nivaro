import { type CSSProperties, createContext, type ReactNode, useContext } from 'react'
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
  /** "Preview as role": what that role's field permissions do to the node
   *  (hidden: faint with a tag, still selectable; read-only: a lock tag). */
  roleMark?(t: DesignTarget): RoleMark | null
  /** Preview modes' tags on a node (role differences, what-if changes, state
   *  requirements). `highlight` rings the node so differences stand out. */
  marks?(t: DesignTarget): DesignMark[]
  /** "Who sees this field" overlay: a tint and a clickable chip on the node. */
  overlay?(t: DesignTarget): DesignOverlay | null
}

export interface DesignMark {
  text: string
  tone: 'violet' | 'emerald' | 'amber' | 'slate'
  /** Instant tooltip (data-tip) with the detail. */
  tip?: string
  highlight?: boolean
}

export interface DesignOverlay {
  /** Classes tinting the node (background + ring), light and dark. */
  className: string
  /** Rendered in the node's badge row; clicks reach it (data-design-pass). */
  chip: ReactNode
}

export interface RoleMark {
  kind: 'hidden' | 'readonly'
  /** The role's name, for the tag ("Hidden for Finance"). */
  role: string
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
  /** Preview the record as if it were in this pipeline state (state key). */
  stateKey?: string | null
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
