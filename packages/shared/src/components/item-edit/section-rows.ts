import { useLayoutEffect, useState } from 'react'

/**
 * Record-form section width (migration 526, `nivaro_field_groups.form_width`).
 *
 * A top-level section set to 'half' pairs with the half section right after it
 * into one row of two columns; a half with no half neighbour still takes half
 * the row. Everything else — full sections, tabs holders, text blocks, the
 * Ungrouped zone and every panel (Pipeline, Comments, Tasks, Referenced by…) —
 * takes the whole row and breaks a pair. Two columns only while the form
 * itself is at least FORM_PAIR_MIN_PX wide (measured, like field columns, so
 * the layout editor's phone/tablet frames show what those screens get);
 * narrower, a pair stacks. Never read_width — that one shapes the read view.
 */

/** Below this form width two half sections stack (≈ the form column of a 1024 px screen). */
export const FORM_PAIR_MIN_PX = 720

export function isHalfSection(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false
  const g = item as { type?: string; container_id?: number | null; form_width?: string | null }
  return (
    (g.type === 'section' || g.type === 'metadata') && !g.container_id && g.form_width === 'half'
  )
}

export type SectionRow<T> = { kind: 'full'; item: T } | { kind: 'pair'; items: T[] }

/** The form's top-level items in rows: consecutive halves pair up, two at most per row. */
export function sectionRows<T>(items: T[], isHalf: (item: T) => boolean): SectionRow<T>[] {
  const rows: SectionRow<T>[] = []
  let open: T[] | null = null
  for (const item of items) {
    if (!isHalf(item)) {
      open = null
      rows.push({ kind: 'full', item })
      continue
    }
    if (open && open.length < 2) {
      open.push(item)
      continue
    }
    open = [item]
    rows.push({ kind: 'pair', items: open })
  }
  return rows
}

/** Whether `el` is wide enough for two half sections side by side; false until measured. */
export function useFormPairs(el: HTMLElement | null, enabled: boolean): boolean {
  const [wide, setWide] = useState(false)
  useLayoutEffect(() => {
    if (!el || !enabled) return
    const judge = (w: number) => setWide(w >= FORM_PAIR_MIN_PX)
    judge(el.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => judge(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [el, enabled])
  return enabled && wide
}
