import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Hover any table cell inside a `[data-copy-cells]` container and a tiny copy
 * button appears at the cell's right edge — one window listener plus one
 * portal node, TipLayer's pattern. Copies the cell's DISPLAYED text (what the
 * user can see is what they get).
 *
 * Mount once per surface; extra mounts are harmless — only the first live
 * instance listens and renders.
 */
let mountedInstances = 0

export function CellCopyLayer() {
  const [target, setTarget] = useState<{ x: number; y: number; text: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [owns, setOwns] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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
      const el = e.target as HTMLElement | null
      // Moving onto the button itself must not clear it — the button lives
      // outside the cell, so closest('td') would be null mid-click.
      if (el?.closest?.('[data-cell-copy-btn]')) return
      const td = el?.closest?.('td') as HTMLTableCellElement | null
      if (!td || !td.closest('[data-copy-cells]') || td.hasAttribute('colspan')) {
        setTarget((t) => (t ? null : t))
        return
      }
      if (td.querySelector('input[type="checkbox"]') || td.querySelector('[data-no-copy]')) {
        setTarget((t) => (t ? null : t))
        return
      }
      const text = td.innerText.trim()
      if (!text || text === '—') {
        setTarget((t) => (t ? null : t))
        return
      }
      const r = td.getBoundingClientRect()
      setTarget({ x: r.right - 24, y: r.top + (r.height - 20) / 2, text })
      setCopied(false)
    }
    const clear = () => setTarget(null)
    window.addEventListener('mouseover', over)
    window.addEventListener('scroll', clear, true)
    return () => {
      window.removeEventListener('mouseover', over)
      window.removeEventListener('scroll', clear, true)
    }
  }, [owns])

  if (!owns || !target) return null
  return createPortal(
    <button
      type='button'
      data-cell-copy-btn
      aria-label='Copy cell value'
      // Below tooltips (120) but above sticky cells; the row's own click
      // handler must never fire from a copy.
      style={{ position: 'fixed', left: target.x, top: target.y, zIndex: 115 }}
      className='flex h-5 w-5 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 shadow-sm hover:text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        void navigator.clipboard?.writeText(target.text).then(() => {
          setCopied(true)
          if (copiedTimer.current) clearTimeout(copiedTimer.current)
          copiedTimer.current = setTimeout(() => setTarget(null), 900)
        })
      }}
    >
      {copied ? (
        <Check className='h-3 w-3 text-emerald-500' />
      ) : (
        <Copy className='h-3 w-3' />
      )}
    </button>,
    document.body
  )
}
