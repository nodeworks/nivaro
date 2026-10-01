// #1167 — the first-visit guide to reading the flow map. Shown once per browser (localStorage,
// guarded: a private window or blocked storage simply shows it again next time), reopened from
// the "How to read the map" button in the Flow header.
import { HelpCircle, X } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'

const SEEN_KEY = 'nvr_tm_legend_seen'
let open = false
const subs = new Set<() => void>()
function set(v: boolean) {
  open = v
  for (const fn of subs) fn()
}
export function openLegend(): void {
  set(true)
}
function useLegendOpen(): boolean {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn)
      return () => {
        subs.delete(fn)
      }
    },
    () => open,
    () => open
  )
}
export function legendSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return false
  }
}
function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {
    /* blocked storage: the guide shows again next visit */
  }
}

function Swatch({ children, label }: { children: ReactNode; label: string }) {
  return (
    <li className='flex items-start gap-2.5'>
      <span
        className='mt-[3px] flex h-3.5 w-9 shrink-0 items-center justify-center'
        aria-hidden='true'
      >
        {children}
      </span>
      <span className='min-w-0'>{label}</span>
    </li>
  )
}
const line = (color: string, dash?: string, w = 2.5) => (
  <svg width='36' height='10' viewBox='0 0 36 10' role='presentation'>
    <line
      x1='2'
      y1='5'
      x2='34'
      y2='5'
      stroke={color}
      strokeWidth={w}
      strokeDasharray={dash}
      strokeLinecap='round'
    />
  </svg>
)

const BTN =
  'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-[3px] text-[12px] font-medium leading-tight transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--tm-card)] border-[var(--tm-line)] bg-[var(--tm-card)] text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)]'

/** The "How to read the map" button (Flow header). */
export function LegendButton() {
  return (
    <button
      type='button'
      id='tm-legend-open'
      onClick={openLegend}
      className={BTN}
      aria-haspopup='dialog'
    >
      <HelpCircle className='h-3.5 w-3.5' aria-hidden='true' />
      How to read the map
    </button>
  )
}

/** The guide itself, over the map card. Opens by itself on the first visit. */
export function LegendGuide({ ready }: { ready: boolean }) {
  const isOpen = useLegendOpen()
  const [first, setFirst] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (ready && !legendSeen()) {
      setFirst(true)
      openLegend()
    }
  }, [ready])
  useEffect(() => {
    if (isOpen) closeRef.current?.focus()
  }, [isOpen])
  if (!isOpen) return null
  const close = () => {
    markSeen()
    setFirst(false)
    set(false)
    document.getElementById('tm-legend-open')?.focus()
  }
  return (
    <div
      role='dialog'
      aria-modal='false'
      aria-labelledby='tm-legend-title'
      id='tm-legend'
      className='absolute inset-x-3 top-3 z-20 max-h-[calc(100%-24px)] overflow-y-auto rounded-lg border border-[var(--tm-line)] bg-[var(--tm-card)] p-4 text-[12.5px] text-[var(--tm-fg)] shadow-lg min-[900px]:left-auto min-[900px]:w-[520px]'
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          close()
        }
      }}
    >
      <div className='flex items-start justify-between gap-3'>
        <div>
          <h3 id='tm-legend-title' className='text-[14px] font-semibold'>
            How to read the map
          </h3>
          <p className='mt-0.5 text-[12px] text-[var(--tm-muted)]'>
            {first
              ? 'A one-time guide. It is always one click away under “How to read the map”.'
              : 'What every shape and colour on the flow map means.'}
          </p>
        </div>
        <button
          ref={closeRef}
          type='button'
          onClick={close}
          className={cn(BTN, 'px-1.5')}
          aria-label='Close the guide'
          id='tm-legend-close'
        >
          <X className='h-3.5 w-3.5' aria-hidden='true' />
        </button>
      </div>
      <div className='mt-3 grid gap-4 min-[620px]:grid-cols-2'>
        <section>
          <h4 className='text-[12.5px] font-semibold'>Columns</h4>
          <ul className='mt-1.5 grid gap-1.5 text-[var(--tm-fg-2)]'>
            <li>
              <b className='font-semibold text-[var(--tm-fg)]'>Callers</b> on the left: people, API
              keys and integration accounts. <b className='font-semibold'>Sources</b> under them are
              work with no request behind it: cron jobs, flows, imports, socket events.
            </li>
            <li>
              <b className='font-semibold text-[var(--tm-fg)]'>API lanes</b> in the middle group
              requests by what they reach (collections, widgets, pages, queries, GraphQL, files,
              system tables, sockets); each row is one entity with its requests per second.
            </li>
            <li>
              <b className='font-semibold text-[var(--tm-fg)]'>Data and partners</b> on the right:
              the database, cache, file storage, partner APIs, notification channels and AI.
              Partners have a dashed outline.
            </li>
          </ul>
        </section>
        <section>
          <h4 className='text-[12.5px] font-semibold'>Edges</h4>
          <ul className='mt-1.5 grid gap-1.5 text-[var(--tm-fg-2)]'>
            <Swatch label='Traffic: thicker means more requests per second (switch to log or linear in the Flow header).'>
              {line('var(--tm-edge)', undefined, 4)}
            </Swatch>
            <Swatch label='The selected node’s traffic. Selecting a caller traces its whole path and fades the rest.'>
              {line('var(--tm-accent)')}
            </Swatch>
            <Swatch label='Acting as someone (masquerade or a simulated key).'>
              {line('var(--tm-update)', '2 4')}
            </Swatch>
            <Swatch label='A retry storm: the same caller repeating a failing request.'>
              {line('var(--tm-error)', '5 4')}
            </Swatch>
            <Swatch label='Inferred: two entities that keep rising together, with how closely (r).'>
              {line('var(--tm-inferred)', '4 4', 1.8)}
            </Swatch>
            <Swatch label='Partner calls coloured by why they fail: transient, rate limited, auth, not found, validation.'>
              <span className='flex gap-0.5'>
                {['transient', 'rate-limited', 'auth', 'not-found', 'validation'].map((c) => (
                  <span
                    key={c}
                    className='h-2.5 w-1.5 rounded-sm'
                    style={{ background: `var(--tm-ec-${c})` }}
                  />
                ))}
              </span>
            </Swatch>
          </ul>
        </section>
        <section>
          <h4 className='text-[12.5px] font-semibold'>Dots, halos and flashes</h4>
          <ul className='mt-1.5 grid gap-1.5 text-[var(--tm-fg-2)]'>
            <Swatch label='Moving dots are requests, coloured by kind: read, create, update, delete, error.'>
              <span className='flex gap-1'>
                {['read', 'create', 'update', 'delete', 'error'].map((k) => (
                  <span
                    key={k}
                    className='h-2 w-2 rounded-full'
                    style={{ background: `var(--tm-${k})` }}
                  />
                ))}
              </span>
            </Swatch>
            <Swatch label='A ring pulses on a row when it is written to; a row or lane header flashes red on an error.'>
              <span className='h-3 w-3 rounded-full border-[1.5px] border-[var(--tm-update)]' />
            </Swatch>
            <Swatch label='A green arc around a row’s dot is its cache hit ratio.'>
              <span className='h-3 w-3 rounded-full border-2 border-[var(--tm-create)] border-l-[var(--tm-line)]' />
            </Swatch>
            <Swatch label='A dashed outline on a row: rehearsed writes (dry runs, flow tests) that were thrown away.'>
              <span className='h-3 w-8 rounded border border-dashed border-[var(--tm-read)]' />
            </Swatch>
          </ul>
        </section>
        <section>
          <h4 className='text-[12.5px] font-semibold'>Badges and controls</h4>
          <ul className='mt-1.5 grid gap-1.5 text-[var(--tm-fg-2)]'>
            <Swatch label='Pills on a row or node flag something to look at: duplicate requests, N+1 queries, write conflicts, pool pressure, a failing job.'>
              <span className='rounded-full border border-[var(--tm-update)] px-1 text-[9px] font-semibold text-[var(--tm-update)]'>
                2×
              </span>
            </Swatch>
            <li>
              Zoom out to see lanes only, or in for each entity’s busiest route and every caller’s
              own edges (+ and − on the map, or Ctrl and the scroll wheel).
            </li>
            <li>
              Pause turns the window into a timeline you can drag back through the last 15 minutes;
              Live returns to the present.
            </li>
          </ul>
        </section>
      </div>
    </div>
  )
}
