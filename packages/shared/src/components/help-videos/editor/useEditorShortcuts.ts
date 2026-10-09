import { useEffect, useRef } from 'react'

export type EditorShortcutActions = {
  undo: () => void
  redo: () => void
  split: () => void
  deletePiece: () => void
  /** M: a chapter at the playhead. */
  addChapter: () => void
  /** Escape: put the drawing tool down. */
  stopDrawing: () => void
  /** ?: show or hide the list of shortcuts. */
  toggleShortcuts: () => void
  /** A kept piece is selected (Delete cuts it). */
  pieceSelected: boolean
}

/** Shortcuts on the Edit tab: S split, Delete cut the selected piece,
 *  M add a chapter, Escape stop drawing, ? list the shortcuts,
 *  Ctrl/⌘+Z undo, Shift+Ctrl/⌘+Z or Ctrl+Y redo. Never while typing or
 *  inside a popover or menu. The window listener is added once; each key
 *  reads the latest actions from a ref. */
export function useEditorShortcuts(active: boolean, actions: EditorShortcutActions) {
  const latest = useRef({ active, actions })
  latest.current = { active, actions }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { active: on, actions: a } = latest.current
      if (!on || e.defaultPrevented) return
      // The target can be the window or document itself, not an element.
      const t = e.target instanceof HTMLElement ? e.target : null
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
        if (e.shiftKey || k === 'y') a.redo()
        else a.undo()
      } else if (!mod && !e.altKey && k === 's') a.split()
      else if (!mod && !e.altKey && k === 'm') a.addChapter()
      else if (e.key === 'Escape') a.stopDrawing()
      else if (!mod && e.key === '?') a.toggleShortcuts()
      else if (!mod && (e.key === 'Delete' || e.key === 'Backspace') && a.pieceSelected) {
        e.preventDefault()
        a.deletePiece()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
