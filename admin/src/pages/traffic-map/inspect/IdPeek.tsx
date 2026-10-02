/**
 * Hover card for an id: after 300 ms over it (or as soon as the keyboard focuses it) a small
 * card shows what the server knows about the ref — title, a few lines — and an "Open" button
 * that pushes it onto the investigation stack. The peek is fetched only once the card opens.
 */
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { type ReactElement, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { PopoverContent } from '@/components/ui/popover'
import type { InspectRef } from '../registry/inspectables'
import { inspectErrorOf, useInspectPeek } from './api'
import { fmtClock, refTitle } from './format'
import { openInspect } from './stack'

export const PEEK_OPEN_DELAY_MS = 300
const PEEK_CLOSE_DELAY_MS = 150

function PeekBody({ inspectRef, onOpen }: { inspectRef: InspectRef; onOpen: () => void }) {
  const q = useInspectPeek(inspectRef, true)
  const err = q.isError ? inspectErrorOf(q.error) : null
  return (
    <div className='grid gap-1.5' data-tm-inspect-peek-card={`${inspectRef.kind}:${inspectRef.id}`}>
      {q.isLoading ? (
        <div className='grid gap-1.5' aria-hidden='true'>
          <div className='h-3.5 w-3/4 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none' />
          <div className='h-3 w-1/2 animate-pulse rounded bg-[var(--tm-skeleton)] motion-reduce:animate-none' />
        </div>
      ) : q.data ? (
        <>
          <p className='text-[12.5px] font-semibold text-[var(--tm-fg)]'>{q.data.title}</p>
          {q.data.lines.slice(0, 6).map((l, i) => (
            <p
              // biome-ignore lint/suspicious/noArrayIndexKey: the lines are a fixed server list
              key={i}
              className='text-[11.5px] leading-snug text-[var(--tm-fg-2)]'
            >
              {l}
            </p>
          ))}
          {q.data.at != null && (
            <p className='text-[11px] tabular-nums text-[var(--tm-muted)]'>{fmtClock(q.data.at)}</p>
          )}
        </>
      ) : (
        <>
          <p className='text-[12.5px] font-semibold text-[var(--tm-fg)]'>{refTitle(inspectRef)}</p>
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            {err?.code === 'INSPECT_KIND_UNKNOWN'
              ? `The server has no preview for a ${inspectRef.kind} yet.`
              : err?.status === 404
                ? 'Not found — it may be older than what this node keeps.'
                : err
                  ? `Preview failed: ${err.message}`
                  : 'No preview for this one.'}
          </p>
        </>
      )}
      <div className='pt-0.5'>
        <button
          type='button'
          data-tm-inspect-peek=''
          onClick={onOpen}
          className='rounded-md border border-[var(--tm-line)] bg-[var(--tm-card)] px-2 py-[3px] text-[12px] font-medium text-[var(--tm-accent-ink)] hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
        >
          Open
        </button>
      </div>
    </div>
  )
}

function isFocusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible')
  } catch {
    return true
  }
}

/**
 * Wraps one focusable element (the child must accept ref + pointer/focus handlers — a <button>
 * does). The child keeps its own click behaviour; the card never steals focus when it opens.
 */
export function IdPeek({
  inspectRef,
  children,
  root
}: {
  inspectRef: InspectRef
  children: ReactElement
  /** "Open" starts a new investigation instead of pushing a level. */
  root?: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  const openT = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeT = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clear = useCallback(() => {
    if (openT.current) clearTimeout(openT.current)
    if (closeT.current) clearTimeout(closeT.current)
    openT.current = null
    closeT.current = null
  }, [])
  useEffect(() => clear, [clear])
  const scheduleOpen = () => {
    clear()
    openT.current = setTimeout(() => setOpen(true), PEEK_OPEN_DELAY_MS)
  }
  const scheduleClose = () => {
    if (openT.current) clearTimeout(openT.current)
    openT.current = null
    if (closeT.current) clearTimeout(closeT.current)
    closeT.current = setTimeout(() => setOpen(false), PEEK_CLOSE_DELAY_MS)
  }
  const cardRef = useRef<HTMLDivElement | null>(null)
  const keep = () => {
    if (closeT.current) clearTimeout(closeT.current)
    closeT.current = null
  }
  const wrapper = (
    // biome-ignore lint/a11y/noStaticElementInteractions: a hover/focus wrapper; the focusable child is the control
    <span
      className='inline-flex min-w-0 max-w-full'
      onPointerEnter={scheduleOpen}
      onPointerLeave={scheduleClose}
      onPointerDown={() => {
        clear()
        setOpen(false)
      }}
      onFocus={(e) => {
        if (isFocusVisible(e.target)) {
          clear()
          setOpen(true)
        }
      }}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null
        if (next && cardRef.current?.contains(next)) return
        scheduleClose()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation()
          clear()
          setOpen(false)
        }
      }}
    >
      {children}
    </span>
  )
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Anchor asChild>{wrapper}</PopoverPrimitive.Anchor>
      {open && (
        <PopoverContent
          ref={cardRef}
          side='bottom'
          align='start'
          className='traffic-map w-[300px] border-[var(--tm-line)] bg-[var(--tm-card)] p-3 text-[var(--tm-fg)]'
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onPointerEnter={keep}
          onPointerLeave={scheduleClose}
        >
          <PeekBody
            inspectRef={inspectRef}
            onOpen={() => {
              clear()
              setOpen(false)
              openInspect(inspectRef, { root })
            }}
          />
        </PopoverContent>
      )}
    </PopoverPrimitive.Root>
  )
}
