import { Download, FileImage, Maximize2, Minus, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type { Diagram } from '@/lib/diagram/layout'
import { type DiagramTheme, diagramInner, exportPng, exportSvg } from '@/lib/diagram/svg'

const MIN_Z = 0.15
const MAX_Z = 2.5

function useTheme(): DiagramTheme {
  const read = () =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
      ? 'dark'
      : 'light'
  const [theme, setTheme] = useState<DiagramTheme>(read)
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(read()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  return theme
}

export function useNarrow(): boolean {
  const q = '(max-width: 767px)'
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches
  )
  useEffect(() => {
    const m = window.matchMedia?.(q)
    if (!m) return
    const on = () => setNarrow(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return narrow
}

/**
 * Read-only SVG viewer: fit-to-width, drag to pan, wheel to pan, Ctrl/Cmd+wheel
 * or +/- to zoom, arrow keys to pan, 0 to fit, export as SVG / PNG.
 */
export function DiagramViewer({
  diagram,
  title,
  filename
}: {
  diagram: Diagram
  title: string
  filename: string
}) {
  const theme = useTheme()
  const box = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ z: 1, x: 0, y: 0 })
  const touched = useRef(false)
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null)

  const fitView = useCallback(() => {
    const el = box.current
    if (!el) return
    const z = Math.min(1.4, Math.max(MIN_Z, el.clientWidth / diagram.width))
    setView({ z, x: 0, y: 0 })
  }, [diagram.width])

  // Re-fit on size changes until the person takes over.
  useEffect(() => {
    fitView()
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (!touched.current) fitView()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [fitView])

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    touched.current = true
    setView((v) => {
      const z = Math.min(MAX_Z, Math.max(MIN_Z, v.z * factor))
      const el = box.current
      const px = cx ?? (el ? el.clientWidth / 2 : 0)
      const py = cy ?? (el ? el.clientHeight / 2 : 0)
      const k = z / v.z
      return { z, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
    })
  }, [])

  // Wheel needs a non-passive listener to preventDefault.
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      touched.current = true
      const r = el.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top)
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const onKey = (e: React.KeyboardEvent) => {
    const step = 60
    const pan = (dx: number, dy: number) => {
      touched.current = true
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
    }
    const act: Record<string, () => void> = {
      ArrowLeft: () => pan(step, 0),
      ArrowRight: () => pan(-step, 0),
      ArrowUp: () => pan(0, step),
      ArrowDown: () => pan(0, -step),
      '+': () => zoomAt(1.2),
      '=': () => zoomAt(1.2),
      '-': () => zoomAt(1 / 1.2),
      _: () => zoomAt(1 / 1.2),
      '0': () => {
        touched.current = false
        fitView()
      }
    }
    const fn = act[e.key]
    if (fn) {
      e.preventDefault()
      fn()
    }
  }

  const inner = useMemo(() => diagramInner(diagram, theme), [diagram, theme])
  const btn = 'h-7 gap-1 px-2 text-[12px]'

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <div className='flex shrink-0 flex-wrap items-center gap-1.5 border-b border-slate-200 bg-white px-3 py-2 dark:border-border dark:bg-card'>
        <Button
          size='sm'
          variant='outline'
          className={btn}
          onClick={() => zoomAt(1 / 1.2)}
          aria-label='Zoom out'
        >
          <Minus className='h-3.5 w-3.5' />
        </Button>
        <span
          className='w-12 text-center text-[12px] tabular-nums text-slate-500'
          aria-live='polite'
        >
          {Math.round(view.z * 100)}%
        </span>
        <Button
          size='sm'
          variant='outline'
          className={btn}
          onClick={() => zoomAt(1.2)}
          aria-label='Zoom in'
        >
          <Plus className='h-3.5 w-3.5' />
        </Button>
        <Button
          size='sm'
          variant='outline'
          className={btn}
          onClick={() => {
            touched.current = false
            fitView()
          }}
        >
          <Maximize2 className='h-3.5 w-3.5' /> Fit
        </Button>
        <span className='mx-1 hidden text-[11px] text-slate-400 md:inline'>
          Drag to move · Ctrl/⌘ + scroll or +/− to zoom · arrow keys to move · 0 to fit
        </span>
        <span className='ml-auto flex gap-1.5'>
          <Button
            size='sm'
            variant='outline'
            className={btn}
            onClick={() => exportSvg(diagram, theme, filename, title)}
          >
            <Download className='h-3.5 w-3.5' /> SVG
          </Button>
          <Button
            size='sm'
            variant='outline'
            className={btn}
            onClick={() =>
              exportPng(diagram, theme, filename, title).catch((e: Error) => toast.error(e.message))
            }
          >
            <FileImage className='h-3.5 w-3.5' /> PNG
          </Button>
        </span>
      </div>
      <div
        ref={box}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard pan/zoom surface
        tabIndex={0}
        role='application'
        aria-label={`${title}. Use arrow keys to move, plus and minus to zoom, 0 to fit.`}
        onKeyDown={onKey}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          drag.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y }
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          touched.current = true
          setView((v) => ({ ...v, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py }))
        }}
        onPointerUp={() => {
          drag.current = null
        }}
        className='relative min-h-[320px] flex-1 cursor-grab touch-none overflow-hidden bg-slate-50 outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan active:cursor-grabbing dark:bg-[#0b1220]'
      >
        <svg
          width={diagram.width}
          height={diagram.height}
          role='img'
          aria-label={title}
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
            transformOrigin: '0 0'
          }}
          className='absolute left-0 top-0 select-none'
          // biome-ignore lint/security/noDangerouslySetInnerHtml: markup is built by diagramInner, which escapes every config string
          dangerouslySetInnerHTML={{ __html: inner }}
        />
      </div>
    </div>
  )
}
