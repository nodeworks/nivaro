import { type CSSProperties, createContext, useContext } from 'react'

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
 * Drag and drop for design nodes (LayoutDndProvider supplies the real one).
 * Every DesignNode calls `draggableProps` exactly once per render,
 * unconditionally — it may call React hooks (the provider's does), so a
 * canvas keeps one `dnd` for its whole life. `disabled` (inherited nodes, the
 * folded copy of a header tile) registers nothing.
 */
export interface DesignDnd {
  draggableProps(t: DesignTarget, opts?: { disabled?: boolean }): object
  isDragging(t: DesignTarget): boolean
  dropSlot(t: DesignTarget): 'before' | 'after' | null
  /** Where the insertion line sits inside the node (absolute; no layout shift). */
  dropIndicator?(t: DesignTarget): CSSProperties | null
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
