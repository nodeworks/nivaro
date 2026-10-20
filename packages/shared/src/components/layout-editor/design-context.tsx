import { createContext, useContext } from 'react'

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
