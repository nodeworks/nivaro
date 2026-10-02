/**
 * The Investigation panel: a docked, non-modal column on the right edge of the map region (the
 * map stays live and clickable) showing the current level of the investigation stack, with
 * breadcrumbs, back / forward, pin-to-split and the registered header actions and footers.
 *
 * Keys (when focus is inside the panel, or nothing is focused): Escape back (close at the root),
 * [ back, ] forward, p pin / split. Never while typing in a field.
 */
import { ArrowLeft, ArrowRight, ChevronRight, Columns2, X } from 'lucide-react'
import { Suspense, useEffect, useRef, useSyncExternalStore } from 'react'
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

export function InspectHost() {
  const s = useInspectStack()
  const hostRef = useRef<HTMLElement | null>(null)
  const isOpen = s.levels.length > 0
  const current = s.levels[s.index] ?? null
  const split = s.pinned != null && s.pinned !== s.index ? s.pinned : null

  // Move focus into the panel when it opens (an explicit action opened it), so its keys work.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (isOpen && !wasOpen.current) hostRef.current?.focus({ preventScroll: true })
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
  return (
    <aside
      ref={hostRef}
      tabIndex={-1}
      aria-label='Investigation'
      data-tm-inspect-host=''
      data-tm-inspect-split={split != null ? '' : undefined}
      className={cn(
        'absolute inset-y-0 right-0 z-30 flex max-w-full flex-col border-l border-[var(--tm-line)] bg-[var(--tm-card)] text-[var(--tm-fg)] shadow-[-8px_0_24px_-12px_rgba(15,23,42,0.25)] outline-none',
        split != null ? 'w-[1040px]' : 'w-[600px]'
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
          <nav aria-label='Investigation path' className='mx-1 min-w-0 flex-1'>
            <ol className='flex min-w-0 items-center gap-0.5 overflow-hidden text-[12px]'>
              {s.levels.map((ref, i) => {
                const title = refTitle(ref)
                const isCur = i === s.index
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the same ref may sit at two depths
                  <li key={`${i}:${ref.kind}:${ref.id}`} className='flex min-w-0 items-center'>
                    {i > 0 && (
                      <ChevronRight
                        className='mx-0.5 h-3 w-3 shrink-0 text-[var(--tm-muted)]'
                        aria-hidden='true'
                      />
                    )}
                    <button
                      type='button'
                      onClick={() => goTo(i)}
                      aria-current={isCur ? 'page' : undefined}
                      data-tip={title}
                      data-tm-inspect-crumb={i}
                      className={cn(
                        'max-w-[180px] truncate rounded-sm px-1 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                        isCur
                          ? 'font-semibold text-[var(--tm-fg)]'
                          : 'text-[var(--tm-accent-ink)] hover:underline'
                      )}
                    >
                      {title}
                    </button>
                  </li>
                )
              })}
            </ol>
          </nav>
          <InspectHeaderActions {...headerProps} />
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
              s.pinned != null
                ? 'Unpin ( p )'
                : 'Pin this level; the next one opens beside it ( p )'
            }
            data-tm-inspect-pin=''
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
      </header>
      <div
        className={cn(
          'min-h-0 flex-1',
          split != null
            ? 'grid grid-cols-[520px_520px] divide-x divide-[var(--tm-line-2)]'
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
