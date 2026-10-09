import { ChevronLeft, ChevronRight, MousePointerClick, X } from 'lucide-react'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigation } from '../../../context'
import { HelpVideoSheet } from '../viewer/HelpVideoSheet'
import {
  claimWalkHost,
  endHelpVideoWalk,
  goToWalkStep,
  setWalkWatching,
  useCurrentHelpVideoPage,
  useHelpVideoWalk,
  useIsWalkOwner,
  type Walk
} from './store'
import { findStepElement, isVisibleElement, stepScreen } from './target'

/** How long a step looks for its element before saying it can't find it. */
export const FIND_WAIT_MS = 3000
const GAP = 10
const EDGE = 16
const BUBBLE_W = 320

/**
 * Draws the guided walk ("Show me on this page") when one is running. Mount
 * it once per host; several may be mounted (the recording provider, every
 * help-video sheet) and only the earliest still mounted draws, so a walk
 * survives the sheet that started it closing.
 */
export function HelpVideoWalkHost() {
  const id = useRef(Symbol('help-video-walk-host')).current
  useEffect(() => claimWalkHost(id), [id])
  const owner = useIsWalkOwner(id)
  const walk = useHelpVideoWalk()
  if (!owner || !walk) return null
  return <WalkOverlay key={walk.run} walk={walk} />
}

type Rect = { top: number; left: number; width: number; height: number }
type Status = 'searching' | 'found' | 'missing'

const reduceMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const btn =
  'inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-[12.5px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
const primary = `${btn} bg-nvr-cyan text-white hover:bg-nvr-cyan/90`
const quiet = `${btn} border border-border bg-background text-foreground hover:bg-muted`

function WalkOverlay({ walk }: { walk: Walk }) {
  const nav = useNavigation()
  const pageKey = useCurrentHelpVideoPage()
  const step = walk.steps[walk.index]
  const total = walk.steps.length
  const last = walk.index === total - 1
  const headingId = useId()

  // The path changes without an event the walk can hear (any router): poll it.
  const [path, setPath] = useState(() => window.location.pathname)
  useEffect(() => {
    const t = window.setInterval(() => {
      if (window.location.pathname !== path) setPath(window.location.pathname)
    }, 300)
    return () => window.clearInterval(t)
  }, [path])

  const screen = stepScreen(step, { pageKey, path })
  const [status, setStatus] = useState<Status>('searching')
  const elRef = useRef<Element | null>(null)
  const [rect, setRect] = useState<Rect | null>(null)

  const next = useCallback(() => goToWalkStep(walk.index + 1), [walk.index])
  const back = useCallback(() => goToWalkStep(walk.index - 1), [walk.index])

  // Find the step's element, and keep finding it: SPA screens render late and
  // re-render often, so the DOM is watched (debounced) and the element is
  // looked up again whenever it leaves the page.
  useEffect(() => {
    elRef.current = null
    setRect(null)
    setStatus('searching')
    if (screen !== 'here' || walk.watching) return
    let started = performance.now()
    let scrolled = false
    let timer = 0
    const look = () => {
      timer = 0
      const cur = elRef.current
      if (cur && isVisibleElement(cur)) return
      // Lost after being found (a re-render, or hidden): wait again before giving up.
      if (cur) started = performance.now()
      const el = findStepElement(step)
      if (el) {
        elRef.current = el
        setStatus('found')
        if (!scrolled) {
          scrolled = true
          const r = el.getBoundingClientRect()
          if (
            r.bottom < 0 ||
            r.top > window.innerHeight ||
            r.right < 0 ||
            r.left > window.innerWidth
          )
            el.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' })
        }
      } else {
        elRef.current = null
        setStatus(performance.now() - started >= FIND_WAIT_MS ? 'missing' : 'searching')
      }
    }
    look()
    const mo = new MutationObserver(() => {
      if (!timer) timer = window.setTimeout(look, 120)
    })
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'aria-hidden', 'style', 'data-state']
    })
    // Also on a clock: the wait runs out without the DOM changing.
    const poll = window.setInterval(look, 500)
    return () => {
      mo.disconnect()
      window.clearInterval(poll)
      if (timer) window.clearTimeout(timer)
    }
  }, [step, screen, walk.watching])

  // Follow the element as the page scrolls, resizes or animates.
  useEffect(() => {
    if (status !== 'found') return
    let frame = 0
    let prev: Rect | null = null
    const tick = () => {
      const el = elRef.current
      if (el?.isConnected) {
        const r = el.getBoundingClientRect()
        const nextRect = { top: r.top, left: r.left, width: r.width, height: r.height }
        if (
          !prev ||
          Math.abs(prev.top - nextRect.top) > 0.5 ||
          Math.abs(prev.left - nextRect.left) > 0.5 ||
          Math.abs(prev.width - nextRect.width) > 0.5 ||
          Math.abs(prev.height - nextRect.height) > 0.5
        ) {
          prev = nextRect
          setRect(nextRect)
        }
      }
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [status])

  // Clicking the element moves on; the click itself goes through untouched.
  useEffect(() => {
    if (walk.watching) return
    const onClick = (e: MouseEvent) => {
      const el = elRef.current
      const t = e.target
      if (!el || !(t instanceof Node) || !el.contains(t)) return
      window.setTimeout(next, 0)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') endHelpVideoWalk()
    }
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [next, walk.watching])

  // Focus moves to the walk once, when it starts.
  const bubble = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const t = window.setTimeout(() => bubble.current?.focus({ preventScroll: true }), 60)
    return () => window.clearTimeout(t)
  }, [])

  const [bubbleH, setBubbleH] = useState(150)
  useLayoutEffect(() => {
    const h = bubble.current?.offsetHeight
    if (h && Math.abs(h - bubbleH) > 1) setBubbleH(h)
  })

  if (walk.watching) {
    return (
      <HelpVideoSheet
        videoId={walk.videoId}
        open
        startAtMs={step.edited_ms}
        showMe={false}
        onOpenChange={(o) => !o && setWalkWatching(false)}
      />
    )
  }

  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(BUBBLE_W, vw - EDGE * 2)
  const pos = (() => {
    if (status === 'found' && rect) {
      const left = Math.min(Math.max(EDGE, rect.left), vw - width - EDGE)
      const below = rect.top + rect.height + GAP
      if (below + bubbleH <= vh - EDGE) return { top: below, left }
      const above = rect.top - GAP - bubbleH
      if (above >= EDGE) return { top: above, left }
      return { top: Math.max(EDGE, vh - bubbleH - EDGE), left }
    }
    return { top: vh - bubbleH - 24, left: vw - width - 24 }
  })()

  const sameOrigin = !!step.origin && step.origin === window.location.origin
  const canGo = screen === 'elsewhere' && !!step.path && sameOrigin
  const action = step.text ?? null

  return createPortal(
    <>
      {status === 'found' && rect && (
        <div
          aria-hidden
          data-hv-walk-ring
          className='pointer-events-none fixed z-[129] rounded-md shadow-[0_0_0_4px_rgb(var(--nvr-cyan-rgb)/0.28)] ring-2 ring-nvr-cyan transition-[top,left,width,height] duration-150 motion-reduce:transition-none'
          style={{
            top: rect.top - 4,
            left: rect.left - 4,
            width: rect.width + 8,
            height: rect.height + 8
          }}
          data-hv-walk=''
        />
      )}
      <div
        ref={bubble}
        role='dialog'
        aria-modal='false'
        aria-labelledby={headingId}
        tabIndex={-1}
        className='fixed z-[130] rounded-lg border border-border bg-popover p-3 text-[13px] text-popover-foreground shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
        // A modal dialog on the page makes body children pointer-events:none.
        style={{ top: pos.top, left: pos.left, width, pointerEvents: 'auto' }}
        data-hv-walk=''
        data-hv-walk-step={walk.index}
        data-hv-walk-status={screen === 'elsewhere' ? 'elsewhere' : status}
      >
        <div className='flex items-start gap-2'>
          <MousePointerClick
            className='mt-0.5 h-4 w-4 shrink-0 text-[#2563eb] dark:text-sky-300'
            aria-hidden
          />
          <div className='min-w-0 flex-1'>
            <p id={headingId} className='text-[12px] text-muted-foreground'>
              <span className='font-medium text-foreground' data-hv-walk-count>
                Step {walk.index + 1} of {total}
              </span>
              <span className='sr-only'> of the walk through </span>
              <span aria-hidden> · </span>
              <span className='break-words'>{walk.title}</span>
            </p>
            <div aria-live='polite' className='mt-1 space-y-1' data-hv-walk-text>
              {screen === 'elsewhere' ? (
                <p>This step is on another screen.</p>
              ) : status === 'missing' ? (
                <p>
                  Can't find <strong className='font-semibold'>{step.label}</strong> on this screen.
                </p>
              ) : (
                <>
                  {action && <p className='whitespace-pre-line'>{action}</p>}
                  <p className={action ? 'text-[12px] text-muted-foreground' : ''}>
                    {status === 'searching' ? 'Looking for ' : 'Click '}
                    <strong className='font-semibold text-foreground'>{step.label}</strong>
                    {status === 'searching' ? '…' : '.'}
                  </p>
                </>
              )}
            </div>
          </div>
          <button
            type='button'
            aria-label='Exit the walk'
            onClick={endHelpVideoWalk}
            className='-mr-1 -mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none'
            data-hv-walk-exit
          >
            <X className='h-4 w-4' aria-hidden />
          </button>
        </div>
        <div className='mt-3 flex flex-wrap items-center gap-2'>
          <button
            type='button'
            className={quiet}
            onClick={back}
            disabled={walk.index === 0}
            data-hv-walk-back
          >
            <ChevronLeft className='h-3.5 w-3.5' aria-hidden /> Back
          </button>
          {screen === 'here' && status === 'missing' && (
            <button
              type='button'
              className={quiet}
              onClick={() => setWalkWatching(true)}
              data-hv-walk-watch
            >
              Watch this step
            </button>
          )}
          {canGo && (
            <button
              type='button'
              className={quiet}
              onClick={() => nav.navigate(step.path as string)}
              data-hv-walk-go
            >
              Go there
            </button>
          )}
          <button
            type='button'
            className={`${screen === 'here' && status !== 'missing' ? primary : quiet} ml-auto`}
            onClick={next}
            data-hv-walk-next
          >
            {screen === 'here' && status !== 'missing' ? (last ? 'Done' : 'Next') : 'Skip'}
            {!(last && screen === 'here' && status !== 'missing') && (
              <ChevronRight className='h-3.5 w-3.5' aria-hidden />
            )}
          </button>
        </div>
      </div>
    </>,
    document.body
  )
}
