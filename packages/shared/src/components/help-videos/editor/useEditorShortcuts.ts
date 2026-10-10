import { useEffect, useRef } from 'react'
import { NUDGE_FRAME_MS, NUDGE_SECOND_MS } from './selection'

export type EditorShortcutActions = {
  undo: () => void
  redo: () => void
  split: () => void
  deletePiece: () => void
  /** M: a chapter at the playhead. */
  addChapter: () => void
  /** H: a held frame at the playhead (#1537). */
  addHold: () => void
  /** Escape: put the drawing tool down. */
  stopDrawing: () => void
  /** ?: show or hide the list of shortcuts. */
  toggleShortcuts: () => void
  /** A kept piece is selected (Delete cuts it). */
  pieceSelected: boolean
  /** How many timeline items are selected (#1543). With more than one, the
   *  arrows nudge them all and Delete removes them all; with one or more,
   *  Ctrl/⌘+D duplicates and [ / ] align their start / end edges to the
   *  playhead. */
  itemsSelected: number
  nudgeSelection: (deltaMs: number) => void
  deleteSelection: () => void
  duplicateSelection: () => void
  alignSelection: (edge: 'start' | 'end') => void
}

/** Shortcuts on the Edit tab: S split, Delete cut the selected piece,
 *  M add a chapter, H hold the frame, Escape stop drawing, ? list the
 *  shortcuts, Ctrl/⌘+Z undo, Shift+Ctrl/⌘+Z or Ctrl+Y redo; on a selection
 *  of items Ctrl/⌘+D duplicate, [ and ] align to the playhead, and on a
 *  group the arrows nudge (a frame; Shift: a second) and Delete removes.
 *  Never while typing or inside a popover or menu. The window listener is
 *  added once; each key reads the latest actions from a ref. */
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
      const group = a.itemsSelected > 1
      if (mod && (k === 'z' || k === 'y')) {
        e.preventDefault()
        if (e.shiftKey || k === 'y') a.redo()
        else a.undo()
      } else if (mod && k === 'd' && a.itemsSelected > 0) {
        e.preventDefault()
        a.duplicateSelection()
      } else if (!mod && !e.altKey && k === 's') a.split()
      else if (!mod && !e.altKey && k === 'm') a.addChapter()
      else if (!mod && !e.altKey && k === 'h') a.addHold()
      else if (!mod && !e.altKey && (e.key === '[' || e.key === ']') && a.itemsSelected > 0) {
        e.preventDefault()
        a.alignSelection(e.key === '[' ? 'start' : 'end')
      } else if (!mod && !e.altKey && group && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        const step = e.shiftKey ? NUDGE_SECOND_MS : NUDGE_FRAME_MS
        a.nudgeSelection(e.key === 'ArrowLeft' ? -step : step)
      } else if (e.key === 'Escape') a.stopDrawing()
      else if (!mod && e.key === '?') a.toggleShortcuts()
      else if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        if (group) {
          e.preventDefault()
          a.deleteSelection()
        } else if (a.pieceSelected) {
          e.preventDefault()
          a.deletePiece()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
