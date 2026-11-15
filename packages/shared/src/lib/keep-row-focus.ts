import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react'

/**
 * Row checkboxes keep their focus through a live update (follow-ups 2026-11-15).
 *
 * The list tables re-key their <tbody> on every data refresh (CollectionBrowserView keys it on
 * dataUpdatedAt, DataTable on enterKey) so rows replay their entry animation. A live update
 * that removes ANOTHER row therefore remounts every row, and the checkbox a keyboard user was
 * on is thrown away: focus drops to <body>.
 *
 * This remembers which row's checkbox had focus (by `data-row-key`) and, after a render that
 * lost it, puts focus back on the same row's checkbox. It never takes focus otherwise: the
 * memory is dropped as soon as focus moves anywhere else (another control, outside the list,
 * or a plain blur while the checkbox is still on the page), and a restore only happens while
 * nothing has focus.
 */

/** A row selection control: a native checkbox or a Radix one (`role=checkbox`). */
const CHECKBOX = 'input[type="checkbox"], [role="checkbox"]'

function rowCheckbox(target: EventTarget | null, container: HTMLElement): string | null {
  if (!(target instanceof Element) || !container.contains(target)) return null
  if (!target.matches(CHECKBOX)) return null
  const row = target.closest('[data-row-key]')
  if (!row || !container.contains(row)) return null
  return row.getAttribute('data-row-key')
}

function nothingFocused(): boolean {
  const a = document.activeElement
  return !a || a === document.body || a === document.documentElement || !a.isConnected
}

function cssEscape(v: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(v)
    : v.replace(/["\\]/g, '\\$&')
}

/** Put focus back on `rowKey`'s checkbox inside `container`. True when it did. */
export function restoreRowCheckboxFocus(container: HTMLElement, rowKey: string): boolean {
  const row = container.querySelector(`[data-row-key="${cssEscape(rowKey)}"]`)
  const box = row?.querySelector<HTMLElement>(CHECKBOX)
  if (!box) return false
  box.focus({ preventScroll: true })
  return document.activeElement === box
}

/**
 * Keep a focused row checkbox focused across re-renders of the list inside `containerRef`.
 * Call it in the component that renders the rows; it checks after every commit.
 */
export function useKeepRowCheckboxFocus(containerRef: RefObject<HTMLElement | null>): void {
  /** The focused row checkbox: its row key and the node itself. */
  const remembered = useRef<{ key: string; el: Element } | null>(null)

  useEffect(() => {
    if (typeof document === 'undefined') return
    const onFocusIn = (e: FocusEvent) => {
      const el = containerRef.current
      const key = el ? rowCheckbox(e.target, el) : null
      remembered.current = key != null ? { key, el: e.target as Element } : null
    }
    const onFocusOut = (e: FocusEvent) => {
      const mem = remembered.current
      if (!mem || e.target !== mem.el) return
      // Moving somewhere real: focusin there sets or clears the memory.
      if (e.relatedTarget) return
      // A blur to nothing. If the checkbox is still on the page the person let go of it;
      // if it is gone, a re-render removed it and the commit restores it.
      setTimeout(() => {
        if (remembered.current === mem && mem.el.isConnected) remembered.current = null
      }, 0)
    }
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('focusout', onFocusOut, true)
    return () => {
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', onFocusOut, true)
    }
  }, [containerRef])

  useLayoutEffect(() => {
    const mem = remembered.current
    const el = containerRef.current
    // Only when the focused checkbox itself was thrown away by this render and focus went
    // nowhere: a checkbox still on the page, or focus somewhere else, is left alone.
    if (!mem || !el || mem.el.isConnected || !nothingFocused()) return
    // The row itself left the list: nothing to return to, and nothing is taken.
    if (!restoreRowCheckboxFocus(el, mem.key)) remembered.current = null
  })
}
