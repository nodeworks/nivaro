import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * One instant tooltip for every `[data-tip]` element on the page — a single
 * window mouseover listener plus one portal node. Native `title` has an OS
 * delay long enough that people assume nothing is there, so truncated values
 * anywhere in the app use this instead.
 *
 * Mount it once per surface; mounting it again (a record form rendered inside
 * a collection browser, an app shell that mounts one for every page) is
 * harmless — only the OLDEST live instance listens and renders, so tooltips
 * never double up. When the owner unmounts (a page that mounted its own is
 * left), the next live instance takes over, so the shell's copy keeps working.
 */
const liveInstances: Array<(owns: boolean) => void> = []

/** A menu whose rows carry tips: a tip drawn under a row would cover the row below it. */
const MENU = '[data-nvr-header-menu-panel], [role="menu"]'
/** Gap between a tip and what it explains. */
const GAP = 6

interface Tip {
  x: number
  y: number
  text: string
  /** A menu row's tip goes beside the menu (left of it, else right), level with the row. */
  beside?: { left: number; right: number; rowTop: number; rowHeight: number }
}

export function TipLayer() {
  const [tip, setTip] = useState<Tip | null>(null)
  const [owns, setOwns] = useState(false)
  const tipRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    liveInstances.push(setOwns)
    if (liveInstances[0] === setOwns) setOwns(true)
    return () => {
      const i = liveInstances.indexOf(setOwns)
      if (i < 0) return
      liveInstances.splice(i, 1)
      if (i === 0) liveInstances[0]?.(true)
    }
  }, [])

  useEffect(() => {
    if (!owns) return
    const over = (e: MouseEvent) => {
      const el = (e.target as HTMLElement)?.closest?.('[data-tip]')
      const text = el?.getAttribute('data-tip')
      // A button whose menu or popover is open says nothing: its tip would
      // cover the first rows of what it opened.
      if (!el || !text || el.getAttribute('aria-expanded') === 'true') {
        setTip((t) => (t ? null : t))
        return
      }
      const r = el.getBoundingClientRect()
      const menu = el.closest(MENU)
      if (menu && menu !== el) {
        const m = menu.getBoundingClientRect()
        setTip({
          x: m.left,
          y: r.top,
          text,
          beside: { left: m.left, right: m.right, rowTop: r.top, rowHeight: r.height }
        })
        return
      }
      setTip({ x: r.left, y: r.bottom + 4, text })
    }
    const clear = () => setTip(null)
    // A press acts on the element (opens its menu, switches a panel): the tip
    // goes and comes back on the next hover.
    window.addEventListener('mouseover', over)
    window.addEventListener('pointerdown', clear, true)
    window.addEventListener('scroll', clear, true)
    return () => {
      window.removeEventListener('mouseover', over)
      window.removeEventListener('pointerdown', clear, true)
      window.removeEventListener('scroll', clear, true)
    }
  }, [owns])

  useLayoutEffect(() => {
    if (!tip) return
    const el = tipRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let { x, y } = tip
    if (tip.beside) {
      // Beside the menu, never over its rows: left of it when the tip fits there, else right.
      const b = tip.beside
      const left = b.left - GAP - r.width
      x = left >= 8 ? left : Math.min(b.right + GAP, Math.max(8, window.innerWidth - r.width - 8))
      y = Math.round(b.rowTop + (b.rowHeight - r.height) / 2)
      y = Math.max(8, Math.min(y, window.innerHeight - r.height - 8))
    } else {
      if (r.right > window.innerWidth - 8) x = Math.max(8, window.innerWidth - r.width - 8)
      if (r.bottom > window.innerHeight - 8) y = Math.max(8, tip.y - r.height - 30)
    }
    if (x !== tip.x || y !== tip.y) setTip({ ...tip, x, y })
  }, [tip])

  if (!owns || !tip) return null
  return createPortal(
    <div
      ref={tipRef}
      // z-[120] is the documented tooltip layer — above popovers (110) so a
      // tip triggered from inside an open sheet/popover still paints on top.
      style={{ position: 'fixed', left: tip.x, top: tip.y, zIndex: 120 }}
      className='pointer-events-none max-w-[340px] whitespace-pre-wrap break-words rounded-md bg-[#0f172a] px-2 py-1 text-[11px] font-medium leading-snug text-white shadow-lg dark:bg-[#334155] dark:ring-1 dark:ring-white/10'
    >
      {tip.text}
    </div>,
    document.body
  )
}

/**
 * A `data-tip` that appears only while the element's text is actually cut off
 * (`truncate` / `line-clamp`): the full value on hover, nothing when it fits.
 * Re-measured on resize; the attribute is what TipLayer reads at mouseover.
 */
export function useOverflowTip<T extends HTMLElement>(text: string | null | undefined) {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const apply = () => {
      const cut = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1
      if (cut && text) el.setAttribute('data-tip', text)
      else el.removeAttribute('data-tip')
    }
    apply()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text])
  return ref
}
