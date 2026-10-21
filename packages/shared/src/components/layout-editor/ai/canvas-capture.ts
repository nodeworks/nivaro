import { captureElementImage } from '../../../lib/screenshot'

/**
 * What the visual critique (#2690) sends about the canvas: every section's
 * box (relative to the canvas, in CSS pixels) and how many rows of fields it
 * drew, plus — only when no preview record is shown — a masked picture.
 */

export interface SectionBox {
  key: string
  x: number
  y: number
  w: number
  h: number
  rows: number
}

const GROUP_SEL = '[data-design-target^="group:"]'
const FIELD_SEL = '[data-design-target^="field:"]'

/** The canvas's scroll container inside an editor body. */
export function canvasRoot(editor: Element | null): HTMLElement | null {
  return (editor?.querySelector('main') as HTMLElement | null) ?? null
}

/** Each section's box once (the first pane when two are side by side). */
export function measureSections(root: HTMLElement): {
  canvas: { w: number; h: number }
  sections: SectionBox[]
} {
  const base = root.getBoundingClientRect()
  const top = base.top - root.scrollTop
  const left = base.left - root.scrollLeft
  const out: SectionBox[] = []
  const seen = new Set<string>()
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(GROUP_SEL))) {
    const key = (el.getAttribute('data-design-target') ?? '').slice('group:'.length)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const r = el.getBoundingClientRect()
    // Rows: distinct tops of the fields whose nearest section is this one.
    const tops = new Set<number>()
    for (const f of Array.from(el.querySelectorAll<HTMLElement>(FIELD_SEL))) {
      if (f.parentElement?.closest(GROUP_SEL) !== el) continue
      tops.add(Math.round(f.getBoundingClientRect().top / 4))
    }
    out.push({
      key,
      x: Math.round(r.left - left),
      y: Math.round(r.top - top),
      w: Math.round(r.width),
      h: Math.round(r.height),
      rows: tops.size
    })
  }
  return {
    canvas: { w: Math.round(root.scrollWidth), h: Math.round(root.scrollHeight) },
    sections: out
  }
}

/** The canvas as a masked JPEG (editor tags left out), or null. */
export function captureCanvas(root: HTMLElement): Promise<string | null> {
  const content = (root.firstElementChild as HTMLElement | null) ?? root
  return captureElementImage(content, {
    maxWidth: 1200,
    ignoreSelector: '[data-design-badges]'
  })
}
