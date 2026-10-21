import { Eraser, MousePointer2, MoveUpRight, PenLine } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { cn } from '../../../lib/utils'
import {
  contentRect,
  type DrawTool,
  drawStore,
  type Mark,
  markOpacity,
  type Pointer
} from './huddle-draw'
import { huddleStore } from './huddle-store'

const POINTER_EVERY_MS = 33
const STROKE_EVERY_MS = 40
const MIN_STEP = 0.003
const MAX_POINTS = 600

const TOOLS: Array<{ id: DrawTool; label: string; tip: string; Icon: typeof PenLine }> = [
  {
    id: 'pointer',
    label: 'Point',
    tip: 'Point — everyone sees where you are pointing',
    Icon: MousePointer2
  },
  { id: 'pen', label: 'Draw', tip: 'Draw on the shared screen', Icon: PenLine },
  { id: 'arrow', label: 'Arrow', tip: 'Draw an arrow', Icon: MoveUpRight }
]

const overlayButton =
  'flex h-6 w-6 items-center justify-center rounded text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'

function drawMark(
  ctx: CanvasRenderingContext2D,
  m: Mark,
  map: (p: [number, number]) => [number, number],
  dpr: number
) {
  const pts = m.pts.map(map)
  if (!pts.length) return
  const stroke = (width: number, color: string) => {
    ctx.strokeStyle = color
    ctx.lineWidth = width * dpr
    ctx.beginPath()
    if (m.tool === 'arrow') {
      const [x0, y0] = pts[0]
      const [x1, y1] = pts[pts.length - 1]
      const a = Math.atan2(y1 - y0, x1 - x0)
      const head = 13 * dpr
      ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
      ctx.moveTo(x1 - head * Math.cos(a - 0.45), y1 - head * Math.sin(a - 0.45))
      ctx.lineTo(x1, y1)
      ctx.lineTo(x1 - head * Math.cos(a + 0.45), y1 - head * Math.sin(a + 0.45))
    } else {
      ctx.moveTo(pts[0][0], pts[0][1])
      for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y)
      if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.1, pts[0][1])
    }
    ctx.stroke()
  }
  // A dark halo under the colour keeps a pastel mark readable on any screen.
  stroke(6.5, 'rgba(15,23,42,0.55)')
  stroke(3.5, m.color)
}

function drawPointer(
  ctx: CanvasRenderingContext2D,
  p: Pointer,
  [x, y]: [number, number],
  dpr: number,
  self: boolean
) {
  ctx.fillStyle = p.color
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 2 * dpr
  ctx.beginPath()
  ctx.arc(x, y, 7 * dpr, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  if (self) return
  const label = p.name
  ctx.font = `${600} ${11 * dpr}px system-ui, sans-serif`
  const w = ctx.measureText(label).width + 10 * dpr
  const h = 17 * dpr
  // Near the right edge the name sits on the left of the dot, so it is never cut off.
  const lx = x + 10 * dpr + w > ctx.canvas.width ? x - 10 * dpr - w : x + 10 * dpr
  const ly = y + 6 * dpr
  ctx.fillStyle = 'rgba(15,23,42,0.8)'
  ctx.beginPath()
  ctx.roundRect?.(lx, ly, w, h, 4 * dpr)
  if (!ctx.roundRect) ctx.rect(lx, ly, w, h)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, lx + 5 * dpr, ly + h / 2)
}

/**
 * The marks layer over a shared screen (#2856). Viewers get a small tool strip
 * (point, draw, arrow, clear); the presenter sees everyone's marks on their
 * own preview plus "N people are pointing" and a clear button. The canvas
 * sits exactly over the <video> box and maps 0–1 coordinates onto the picture
 * inside it, letterboxing included.
 */
export function HuddleDrawOverlay({
  screen,
  videoRef,
  presenter
}: {
  /** Socket id of whoever shares this screen. */
  screen: string
  videoRef: React.RefObject<HTMLVideoElement | null>
  presenter?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState({ x: 0, y: 0, w: 0, h: 0 })
  const [tool, setTool] = useState<DrawTool | null>(null)
  const snap = useSyncExternalStore(drawStore.subscribe, drawStore.getSnapshot)
  const [pointing, setPointing] = useState(0)

  // Follow the video's box (it resizes with the panel and when the stream's size arrives).
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const measure = () => {
      setBox((b) =>
        b.x === v.offsetLeft &&
        b.y === v.offsetTop &&
        b.w === v.offsetWidth &&
        b.h === v.offsetHeight
          ? b
          : { x: v.offsetLeft, y: v.offsetTop, w: v.offsetWidth, h: v.offsetHeight }
      )
    }
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(v)
    v.addEventListener('loadedmetadata', measure)
    v.addEventListener('resize', measure)
    document.addEventListener('fullscreenchange', measure)
    return () => {
      ro?.disconnect()
      v.removeEventListener('loadedmetadata', measure)
      v.removeEventListener('resize', measure)
      document.removeEventListener('fullscreenchange', measure)
    }
  }, [videoRef])

  const picture = useCallback(() => {
    const v = videoRef.current
    return contentRect(box.w, box.h, v?.videoWidth ?? 0, v?.videoHeight ?? 0)
  }, [box, videoRef])

  // Paint while anything is showing; the loop stops itself once every mark faded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: snap.version restarts the loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !box.w || !box.h) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(box.w * dpr)) canvas.width = Math.round(box.w * dpr)
    if (canvas.height !== Math.round(box.h * dpr)) canvas.height = Math.round(box.h * dpr)
    let raf = 0
    const frame = () => {
      const now = Date.now()
      const alive = drawStore.prune(now)
      const r = picture()
      const map = ([x, y]: [number, number]): [number, number] => [
        (r.x + x * r.w) * dpr,
        (r.y + y * r.h) * dpr
      ]
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (const m of drawStore.getSnapshot().marks.get(screen) ?? []) {
        ctx.globalAlpha = markOpacity(now - m.at)
        drawMark(ctx, m, map, dpr)
      }
      const self = huddleStore.getSnapshot().self
      for (const p of drawStore.getSnapshot().pointers.get(screen)?.values() ?? []) {
        ctx.globalAlpha = markOpacity(now - p.at)
        drawPointer(ctx, p, map([p.x, p.y]), dpr, p.from === self)
      }
      ctx.globalAlpha = 1
      setPointing(drawStore.pointing(screen, now))
      if (alive) raf = requestAnimationFrame(frame)
    }
    frame()
    return () => cancelAnimationFrame(raf)
  }, [snap.version, box, screen, picture])

  // ── Input (viewers with a tool picked) ────────────────────────────────────
  const stroke = useRef<{
    id: string
    tool: 'pen' | 'arrow'
    pts: Array<[number, number]>
    sent: number
    timer: ReturnType<typeof setTimeout> | null
  } | null>(null)
  const lastPointer = useRef(0)

  const norm = (e: React.PointerEvent): [number, number] | null => {
    const c = canvasRef.current
    if (!c) return null
    const rect = c.getBoundingClientRect()
    const r = picture()
    if (!r.w || !r.h) return null
    const x = (e.clientX - rect.left - r.x) / r.w
    const y = (e.clientY - rect.top - r.y) / r.h
    if (x < -0.02 || x > 1.02 || y < -0.02 || y > 1.02) return null
    return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]
  }

  const flush = () => {
    const s = stroke.current
    if (!s) return
    if (s.timer) clearTimeout(s.timer)
    s.timer = null
    if (s.tool === 'arrow') {
      const a = s.pts[0]
      const b = s.pts[s.pts.length - 1]
      drawStore.send({ t: 'st', s: screen, id: s.id, tool: 'arrow', k: 0, p: [...a, ...b] })
      return
    }
    if (s.sent >= s.pts.length) return
    const p = s.pts.slice(s.sent).flat()
    drawStore.send({ t: 'st', s: screen, id: s.id, tool: 'pen', k: s.sent, p })
    s.sent = s.pts.length
  }
  const schedule = () => {
    const s = stroke.current
    if (s && !s.timer) s.timer = setTimeout(flush, STROKE_EVERY_MS)
  }

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!tool) return
    const p = norm(e)
    if (!p) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    if (tool === 'pointer') {
      drawStore.send({ t: 'pt', s: screen, x: p[0], y: p[1] })
      return
    }
    stroke.current = { id: drawStore.nextStrokeId(), tool, pts: [p, p], sent: 0, timer: null }
    flush()
  }
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!tool) return
    const p = norm(e)
    if (!p) return
    if (tool === 'pointer') {
      const now = Date.now()
      if (now - lastPointer.current < POINTER_EVERY_MS) return
      lastPointer.current = now
      drawStore.send({ t: 'pt', s: screen, x: p[0], y: p[1] })
      return
    }
    const s = stroke.current
    if (!s) return
    if (s.tool === 'arrow') {
      s.pts = [s.pts[0], p]
    } else {
      const last = s.pts[s.pts.length - 1]
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < MIN_STEP || s.pts.length >= MAX_POINTS) {
        return
      }
      s.pts.push(p)
    }
    schedule()
  }
  const onUp = () => {
    flush()
    stroke.current = null
  }

  useEffect(() => {
    if (!tool) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTool(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tool])

  const hasMarks = !!snap.marks.get(screen)?.length

  return (
    <>
      <canvas
        ref={canvasRef}
        className={cn('absolute', tool ? 'cursor-crosshair touch-none' : 'pointer-events-none')}
        style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        aria-hidden
        data-huddle-draw-canvas
      />
      {presenter ? (
        pointing > 0 || hasMarks ? (
          <div className='absolute left-1.5 top-1.5 flex items-center gap-1' data-huddle-pointing>
            {pointing > 0 && (
              <span className='rounded bg-black/65 px-1.5 py-0.5 text-[10.5px] font-medium text-white'>
                {pointing === 1 ? '1 person is pointing' : `${pointing} people are pointing`}
              </span>
            )}
            <button
              type='button'
              onClick={() => drawStore.send({ t: 'clr', s: screen })}
              className={cn(overlayButton, 'bg-black/55 hover:bg-black/75')}
              aria-label='Clear the marks on your screen'
              data-tip='Clear marks'
            >
              <Eraser className='h-3.5 w-3.5' strokeWidth={2} />
            </button>
          </div>
        ) : null
      ) : (
        <div
          role='toolbar'
          aria-label='Mark up the shared screen'
          className='absolute left-1.5 top-1.5 flex items-center gap-0.5 rounded-md bg-black/60 p-0.5'
          data-huddle-draw-tools
        >
          {TOOLS.map(({ id, label, tip, Icon }) => (
            <button
              key={id}
              type='button'
              onClick={() => setTool((t) => (t === id ? null : id))}
              className={cn(
                overlayButton,
                tool === id ? 'bg-white text-slate-900' : 'hover:bg-white/15'
              )}
              aria-pressed={tool === id}
              aria-label={label}
              data-tip={tool === id ? `${label} — click again or press Esc to stop` : tip}
              data-huddle-tool={id}
            >
              <Icon className='h-3.5 w-3.5' strokeWidth={2} />
            </button>
          ))}
          <span className='mx-0.5 h-3.5 w-px bg-white/25' aria-hidden />
          <button
            type='button'
            onClick={() => drawStore.send({ t: 'clr', s: screen })}
            disabled={!hasMarks}
            className={cn(
              overlayButton,
              'hover:bg-white/15 disabled:opacity-40 disabled:hover:bg-transparent'
            )}
            aria-label='Clear all marks'
            data-tip='Clear all marks'
          >
            <Eraser className='h-3.5 w-3.5' strokeWidth={2} />
          </button>
        </div>
      )}
    </>
  )
}
