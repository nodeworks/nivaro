import type { ReactNode } from 'react'
import type { LayoutBundle, LayoutOp } from '../../lib/layout-ops'
import type { LayoutDesign } from './design-context'

// The one seam between the editor shell and the drag-and-drop layer
// (dnd/LayoutDndProvider). Until that lands this is inert: nothing drags,
// nothing shows a drop slot. Swapping in the real layer changes only the two
// bodies below.

export const NO_DND: LayoutDesign['dnd'] = {
  draggableProps: () => ({}),
  isDragging: () => false,
  dropSlot: () => null
}

export function EditorDndProvider({
  children
}: {
  bundle: LayoutBundle
  apply(ops: LayoutOp[], opts?: { label: string }): void
  children: ReactNode
}) {
  return <>{children}</>
}

/** LayoutDesign.dnd for the canvas; called inside EditorDndProvider. */
export function useEditorDnd(): LayoutDesign['dnd'] {
  return NO_DND
}
