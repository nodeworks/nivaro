/**
 * The Investigation panel: a docked, non-modal column on the right edge of the map region (the
 * map stays live and clickable) showing the current level of the investigation stack, with
 * breadcrumbs, back / forward, pin-to-split and the registered header actions and footers.
 *
 * Keys (when focus is inside the panel, or nothing is focused): Escape back (close at the root),
 * [ back, ] forward, p pin / split. Never while typing in a field. Closing returns focus to
 * whatever had it when the panel opened. Split needs ~760px; narrower, only the current level
 * shows (the pin stays on).
 */
import { ArrowLeft, ArrowRight, ChevronRight, Columns2, X } from 'lucide-react'
import { Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { type InspectPanelProps, type InspectRef, inspectableFor } from '../registry/inspectables'
import { InspectFooters } from '../registry/inspectFooters'
import { InspectHeaderActions } from '../registry/inspectHeaderActions'
import { FeatureBoundary } from '../registry/registry'
import { refTitle } from './format'
import {
  back,
  closeInspect,
  forwardStep,
  getInspectSnapshot,
  goTo,
  type InspectStackState,
  openInspect,
  subscribeInspect,
  togglePin
} from './stack'

const ICON_BTN =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--tm-fg-2)] transition-colors duration-150 ease-out hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:opacity-40'

function useInspectStack(): InspectStackState {
  return useSyncExternalStore(subscribeInspect, getInspectSnapshot, getInspectSnapshot)
}

function typingIn(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function PanelSkeleton() {
  return (
    <div className='grid gap-2' aria-hidden='true'>
      {[86, 64, 72, 50].map((w) => (
        <div
          key={w}
          className='h-3.5 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none'
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  )
}

/** One level: its panel (or why nothing can show it) and the footers under it. */
function Level({
  inspectRef,
  anchor,
  windowSec,
  heading
}: {
  inspectRef: InspectRef
  anchor: number | null
  windowSec: number
  heading?: boolean
}) {
  const ins = inspectableFor(inspectRef.kind)
  const props: InspectPanelProps = {
    inspectRef,
    open: (ref) => openInspect(ref),
    anchor,
    windowSec
  }
  const resetKey = `${inspectRef.kind}:${inspectRef.id}`
  return (
    <div
      className='grid min-h-0 min-w-0 flex-1 content-start gap-3 overflow-auto p-3.5'
      data-tm-inspect-level={resetKey}
    >
      {heading && (
        <p className='truncate text-[12px] font-semibold text-[var(--tm-fg-2)]'>
          {refTitle(inspectRef)}
        </p>
      )}
      {ins ? (
        <FeatureBoundary
          id={`inspect:${inspectRef.kind}`}
          resetKey={resetKey}
          fallback={
            <p className='text-[12.5px] text-[var(--tm-muted)]' data-tm-inspect-failed=''>
              This {ins.label.toLowerCase()} panel failed to render. The rest of the page keeps
              working; try another level or reopen it.
            </p>
          }
        >
          <Suspense fallback={<PanelSkeleton />}>
            <ins.Panel {...props} />
          </Suspense>
        </FeatureBoundary>
      ) : (
        <p
          className='text-[12.5px] text-[var(--tm-muted)]'
          data-tm-inspect-unknown={inspectRef.kind}
        >
          Nothing can show a {inspectRef.kind} yet.
        </p>
      )}
      <InspectFooters {...props} />
    </div>
  )
}

/** Below this much available width the split view shows only the current level. */
export const SPLIT_MIN_WIDTH = 760

const CRUMB =
  'truncate rounded-sm px-1 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'

function Crumb({ refAt, i, current }: { refAt: InspectRef; i: number; current: boolean }) {
  const title = refTitle(refAt)
  return (
    <button
      type='button'
      onClick={() => goTo(i)}
      aria-current={current ? 'page' : undefined}
      data-tip={title}
      data-tm-inspect-crumb={i}
      className={cn(
        CRUMB,
        current
          ? 'max-w-[260px] font-semibold text-[var(--tm-fg)]'
          : 'max-w-[160px] text-[var(--tm-accent-ink)] hover:underline'
      )}
    >
      {title}
    </button>
  )
}

function Sep() {
  return (
    <ChevronRight className='mx-0.5 h-3 w-3 shrink-0 text-[var(--tm-muted)]' aria-hidden='true' />
  )
}

/**
 * Breadcrumbs: the root and the last two levels always show; anything between folds into a
 * "…" button whose popover lists them. The current (last) crumb never shrinks — the others do.
 */
function Crumbs({ levels, index }: { levels: InspectRef[]; index: number }) {
  const [moreOpen, setMoreOpen] = useState(false)
  const fold = levels.length > 3
  const hidden = fold ? levels.slice(1, levels.length - 2).map((r, k) => ({ r, i: k + 1 })) : []
  const shown = fold
    ? [
        { r: levels[0], i: 0 },
        { r: levels[levels.length - 2], i: levels.length - 2 },
        { r: levels[levels.length - 1], i: levels.length - 1 }
      ]
    : levels.map((r, i) => ({ r, i }))
  return (
    <nav aria-label='Investigation path' className='mx-1 min-w-0 flex-1'>
      <ol className='flex min-w-0 items-center gap-0.5 overflow-hidden text-[12px]'>
        {shown.map(({ r, i }, k) => {
          const current = i === index
          return (
            <li
              key={`${i}:${r.kind}:${r.id}`}
              className={cn('flex items-center', current ? 'shrink-0' : 'min-w-0')}
            >
              {k > 0 && <Sep />}
              {fold && k === 1 && (
                <>
                  <Popover open={moreOpen} onOpenChange={setMoreOpen}>
                    <PopoverTrigger asChild>
                      <button
                        type='button'
                        className={cn(CRUMB, 'shrink-0 text-[var(--tm-accent-ink)]')}
                        aria-label={`${hidden.length} more levels`}
                        data-tip={`${hidden.length} more levels`}
                        data-tm-inspect-crumb-more=''
                      >
                        …
                      </button>
                    </PopoverTrigger>
                    <PopoverContent
                      align='start'
                      className='traffic-map w-[260px] border-[var(--tm-line)] bg-[var(--tm-card)] p-1 text-[var(--tm-fg)]'
                    >
                      <ul className='grid' data-tm-inspect-crumb-list=''>
                        {hidden.map(({ r: h, i: hi }) => (
                          <li key={`${hi}:${h.kind}:${h.id}`}>
                            <button
                              type='button'
                              className='w-full truncate rounded px-2 py-1 text-left text-[12px] text-[var(--tm-accent-ink)] hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                              data-tm-inspect-crumb={hi}
                              onClick={() => {
                                setMoreOpen(false)
                                goTo(hi)
                              }}
                            >
                              {refTitle(h)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </PopoverContent>
                  </Popover>
                  <Sep />
                </>
              )}
              <Crumb refAt={r} i={i} current={current} />
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/** Width of the region the panel docks into (re-measured on resize); null before mount. */
function useAvailableWidth(el: HTMLElement | null): number | null {
  const [w, setW] = useState<number | null>(null)
  useEffect(() => {
    const parent = el?.parentElement
    if (!parent) return
    const measure = () => setW(parent.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [el])
  return w
}

export function InspectHost() {
  const s = useInspectStack()
  const hostRef = useRef<HTMLElement | null>(null)
  const [hostEl, setHostEl] = useState<HTMLElement | null>(null)
  const setHostRef = useCallback((el: HTMLElement | null) => {
    hostRef.current = el
    setHostEl(el)
  }, [])
  const isOpen = s.levels.length > 0
  const current = s.levels[s.index] ?? null
  const avail = useAvailableWidth(hostEl)
  // 0 = not laid out (or a test DOM): treat as roomy
  const roomForSplit = !avail || avail >= SPLIT_MIN_WIDTH
  const split = s.pinned != null && s.pinned !== s.index && roomForSplit ? s.pinned : null

  // Opening moves focus into the panel (an explicit action opened it) so its keys work; closing
  // gives focus back to whatever had it before.
  const wasOpen = useRef(false)
  const returnTo = useRef<Element | null>(null)
  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      returnTo.current = document.activeElement
      hostRef.current?.focus({ preventScroll: true })
    } else if (!isOpen && wasOpen.current) {
      const el = returnTo.current
      returnTo.current = null
      if (el instanceof HTMLElement && el.isConnected && el !== document.body)
        el.focus({ preventScroll: true })
    }
    wasOpen.current = isOpen
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      if (typingIn(e.target)) return
      const active = document.activeElement
      const inside = !!hostRef.current && !!active && hostRef.current.contains(active)
      const nothing = !active || active === document.body || active === document.documentElement
      if (!inside && !nothing) return
      const st = getInspectSnapshot()
      if (e.key === 'Escape') {
        e.preventDefault()
        if (st.index > 0) back()
        else closeInspect()
      } else if (e.key === '[') {
        e.preventDefault()
        back()
      } else if (e.key === ']') {
        e.preventDefault()
        forwardStep()
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault()
        togglePin()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen])

  if (!isOpen || !current) return null
  const headerProps: InspectPanelProps = {
    inspectRef: current,
    open: (ref) => openInspect(ref),
    anchor: s.anchor,
    windowSec: s.windowSec
  }
  const pinNoRoom = s.pinned != null && s.pinned !== s.index && !roomForSplit
  return (
    <aside
      ref={setHostRef}
      tabIndex={-1}
      aria-label='Investigation'
      data-tm-inspect-host=''
      data-tm-inspect-split={split != null ? '' : undefined}
      className={cn(
        'absolute inset-y-0 right-0 z-30 flex max-w-full flex-col border-l border-[var(--tm-line)] bg-[var(--tm-card)] text-[var(--tm-fg)] shadow-[-8px_0_24px_-12px_rgba(15,23,42,0.25)] outline-none',
        split != null ? 'w-[min(1040px,100%)]' : 'w-[min(600px,100%)]'
      )}
    >
      <header className='shrink-0 border-b border-[var(--tm-line-2)] px-3 py-2'>
        <div className='flex items-center gap-1'>
          <button
            type='button'
            className={ICON_BTN}
            onClick={back}
            disabled={s.index <= 0}
            aria-label='Back'
            data-tip='Back ( [ )'
            data-tm-inspect-back=''
          >
            <ArrowLeft className='h-4 w-4' aria-hidden='true' />
          </button>
          <button
            type='button'
            className={ICON_BTN}
            onClick={forwardStep}
            disabled={s.forward.length === 0}
            aria-label='Forward'
            data-tip='Forward ( ] )'
            data-tm-inspect-forward=''
          >
            <ArrowRight className='h-4 w-4' aria-hidden='true' />
          </button>
          <Crumbs levels={s.levels} index={s.index} />
          <button
            type='button'
            className={cn(
              ICON_BTN,
              s.pinned != null && 'bg-[var(--tm-card-2)] text-[var(--tm-fg)]'
            )}
            onClick={togglePin}
            aria-pressed={s.pinned != null}
            aria-label={s.pinned != null ? 'Unpin' : 'Pin this level and split'}
            data-tip={
              pinNoRoom
                ? 'Pinned — too narrow to show it beside this level. Unpin ( p )'
                : s.pinned != null
                  ? 'Unpin ( p )'
                  : 'Pin this level; the next one opens beside it ( p )'
            }
            data-tm-inspect-pin=''
            data-tm-inspect-pin-hidden={pinNoRoom ? '' : undefined}
          >
            <Columns2 className='h-4 w-4' aria-hidden='true' />
          </button>
          <button
            type='button'
            className={ICON_BTN}
            onClick={closeInspect}
            aria-label='Close investigation'
            data-tip='Close'
            data-tm-inspect-close=''
          >
            <X className='h-4 w-4' aria-hidden='true' />
          </button>
        </div>
        {/* The level's actions get their own row so a wide set never squeezes the breadcrumbs
            out of the 600px column; the row disappears when no action applies. */}
        <div className='mt-1 flex flex-wrap items-center justify-end gap-1 empty:hidden'>
          <InspectHeaderActions {...headerProps} />
        </div>
      </header>
      <div
        className={cn(
          'min-h-0 flex-1',
          split != null
            ? 'grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] divide-x divide-[var(--tm-line-2)]'
            : 'flex flex-col'
        )}
      >
        {split != null && (
          <Level inspectRef={s.levels[split]} anchor={s.anchor} windowSec={s.windowSec} heading />
        )}
        <Level
          inspectRef={current}
          anchor={s.anchor}
          windowSec={s.windowSec}
          heading={split != null}
        />
      </div>
    </aside>
  )
}
