import { useEffect } from 'react'

/** Shortcuts on the Edit tab: S split, Delete cut the selected piece,
 *  Ctrl/⌘+Z undo, Shift+Ctrl/⌘+Z or Ctrl+Y redo. Never while typing or
 *  inside a popover or menu. */
export function useEditorShortcuts(
  active: boolean,
  actions: {
    undo: () => void
    redo: () => void
    split: () => void
    deletePiece: () => void
    /** A kept piece is selected (Delete cuts it). */
    pieceSelected: boolean
  }
) {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable ||
          t.closest('[data-radix-popper-content-wrapper], [role="menu"]'))
      )
        return
      const mod = e.metaKey || e.ctrlKey
      const k = e.key.toLowerCase()
      if (mod && (k === 'z' || k === 'y')) {
        e.preventDefault()
        if (e.shiftKey || k === 'y') actions.redo()
        else actions.undo()
      } else if (!mod && !e.altKey && k === 's') actions.split()
      else if (!mod && (e.key === 'Delete' || e.key === 'Backspace') && actions.pieceSelected) {
        e.preventDefault()
        actions.deletePiece()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
}
