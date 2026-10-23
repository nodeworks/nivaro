/**
 * Picture-in-picture replay (#1401): the floating corner window. Mounted once
 * in the app layout, so it survives every admin route change; portaled to
 * body and dock-aware (a pinned chat panel moves it over, like the bug button
 * and the help-video mini player). Drag it by its title bar; it settles into
 * the nearest corner, remembered per browser. Closing hands the replay back to
 * the Session replays page at the same moment.
 */
import { GripHorizontal, Maximize2, Square } from 'lucide-react'
import { type CSSProperties, type PointerEvent as ReactPointerEvent, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'
import type { ReplayControls } from './controls'
import {
  closeFloatingReplay,
  dockFloatingReplay,
  resumeStartAt,
  useFloatingReplay
} from './floating-store'
import { ReplayPlayer } from './index'

export type Corner = 'br' | 'bl' | 'tr' | 'tl'

const CORNER_KEY = 'nvr.replay.floatCorner'
const MARGIN = 16
const WIDTH = 480

function readCorner(): Corner {
  try {
    const v = window.localStorage.getItem(CORNER_KEY)
    return v === 'bl' || v === 'tr' || v === 'tl' ? v : 'br'
  } catch {
    return 'br'
  }
}

/** The corner nearest to where the window was dropped (by its centre). */
export function nearestCorner(
  rect: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number }
): Corner {
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const v = cy < viewport.height / 2 ? 't' : 'b'
  const h = cx < viewport.width / 2 ? 'l' : 'r'
  return `${v}${h}` as Corner
}

function cornerStyle(c: Corner): CSSProperties {
  return {
    [c[0] === 't' ? 'top' : 'bottom']: MARGIN,
    [c[1] === 'l' ? 'left' : 'right']: MARGIN
  }
}

const chromeButton =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-muted-foreground dark:hover:bg-white/5 dark:hover:text-foreground'

export function FloatingReplayHost() {
  const floating = useFloatingReplay()
  const navigate = useNavigate()
  const controlsRef = useRef<ReplayControls | null>(null)
  const boxRef = useRef<HTMLElement | null>(null)
  const [corner, setCorner] = useState<Corner>(readCorner)
  const [drag, setDrag] = useState<{ left: number; top: number } | null>(null)
  const grab = useRef<{ dx: number; dy: number } | null>(null)

  if (!floating) return null

  const backToPage = () => {
    const at = controlsRef.current?.getTime() ?? floating.at
    dockFloatingReplay(at)
    navigate('/analytics/replays')
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return
    const box = boxRef.current?.getBoundingClientRect()
    if (!box) return
    grab.current = { dx: e.clientX - box.left, dy: e.clientY - box.top }
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setDrag({ left: box.left, top: box.top })
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!grab.current) return
    setDrag({
      left: Math.min(Math.max(0, e.clientX - grab.current.dx), window.innerWidth - 120),
      top: Math.min(Math.max(0, e.clientY - grab.current.dy), window.innerHeight - 40)
    })
  }
  const onPointerUp = () => {
    if (!grab.current) return
    grab.current = null
    const box = boxRef.current?.getBoundingClientRect()
    if (box) {
      const c = nearestCorner(box, { width: window.innerWidth, height: window.innerHeight })
      setCorner(c)
      try {
        window.localStorage.setItem(CORNER_KEY, c)
      } catch {
        /* private window — this visit only */
      }
    }
    setDrag(null)
  }

  return createPortal(
    <section
      ref={boxRef}
      aria-label={`Floating replay: ${floating.title}`}
      className='fixed z-[90] flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl dark:border-border dark:bg-card'
      style={{
        width: WIDTH,
        maxWidth: `calc(100vw - ${MARGIN * 2}px)`,
        maxHeight: `calc(100vh - ${MARGIN * 2}px)`,
        // A modal sheet sets pointer-events: none on body; the window stays usable.
        pointerEvents: 'auto',
        ...(drag ? { left: drag.left, top: drag.top } : cornerStyle(corner))
      }}
      data-replay-floating=''
      data-nvr-dock-aware
      data-nvr-recording-hide
    >
      <div
        className='flex h-9 shrink-0 cursor-grab touch-none select-none items-center gap-1 border-b border-slate-200 px-2 text-[12.5px] active:cursor-grabbing dark:border-border'
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <GripHorizontal className='h-3.5 w-3.5 shrink-0 text-slate-300' />
        <span className='min-w-0 flex-1 truncate font-medium text-slate-900 dark:text-foreground'>
          {floating.title}
        </span>
        <button
          type='button'
          className={chromeButton}
          onClick={closeFloatingReplay}
          aria-label='Stop the replay'
          title='Stop the replay'
          data-replay-float-stop=''
        >
          <Square className='h-3 w-3' />
        </button>
        <button
          type='button'
          className={chromeButton}
          onClick={backToPage}
          aria-label='Close — back to the replays page'
          title='Close — back to the replays page, at this moment'
          data-replay-float-close=''
        >
          <Maximize2 className='h-3.5 w-3.5' />
        </button>
      </div>
      <div className='min-h-0 overflow-y-auto px-2 pb-2'>
        <ReplayPlayer
          key={floating.recording.id}
          recordingId={floating.recording.id}
          startAt={resumeStartAt(floating.at)}
          live={floating.live}
          minHeight={220}
          panel='none'
          controlsRef={controlsRef}
        />
      </div>
    </section>,
    document.body
  )
}
