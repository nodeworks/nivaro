import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * One instant tooltip for every `[data-tip]` element on the page — a single
 * window mouseover listener plus one portal node. Native `title` has an OS
 * delay long enough that people assume nothing is there, so truncated values
 * anywhere in the app use this instead.
 *
 * Mount it once per surface; mounting it again (a record form rendered inside
 * a collection browser, say) is harmless — only the FIRST live instance
 * listens and renders, so tooltips never double up.
 */
let mountedInstances = 0

export function TipLayer() {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const [owns, setOwns] = useState(false)
  const tipRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    mountedInstances += 1
    const isOwner = mountedInstances === 1
    setOwns(isOwner)
    return () => {
      mountedInstances -= 1
    }
  }, [])

  useEffect(() => {
    if (!owns) return
    const over = (e: MouseEvent) => {
      const el = (e.target as HTMLElement)?.closest?.('[data-tip]')
      const text = el?.getAttribute('data-tip')
      if (!el || !text) {
        setTip((t) => (t ? null : t))
        return
      }
      const r = el.getBoundingClientRect()
      setTip({ x: r.left, y: r.bottom + 4, text })
    }
    const clear = () => setTip(null)
    window.addEventListener('mouseover', over)
    window.addEventListener('scroll', clear, true)
    return () => {
      window.removeEventListener('mouseover', over)
      window.removeEventListener('scroll', clear, true)
    }
  }, [owns])

  useLayoutEffect(() => {
    if (!tip) return
    const el = tipRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let { x, y } = tip
    if (r.right > window.innerWidth - 8) x = Math.max(8, window.innerWidth - r.width - 8)
    if (r.bottom > window.innerHeight - 8) y = Math.max(8, tip.y - r.height - 30)
    if (x !== tip.x || y !== tip.y) setTip({ ...tip, x, y })
  }, [tip])

  if (!owns || !tip) return null
  return createPortal(
    <div
      ref={tipRef}
      // z-[120] is the documented tooltip layer — above popovers (110) so a
      // tip triggered from inside an open sheet/popover still paints on top.
      style={{ position: 'fixed', left: tip.x, top: tip.y, zIndex: 120 }}
      className='pointer-events-none max-w-[340px] whitespace-pre-wrap break-words rounded-md bg-[#0f172a] px-2 py-1 text-[11px] font-medium leading-snug text-white shadow-lg dark:bg-[#334155]'
    >
      {tip.text}
    </div>,
    document.body
  )
}
