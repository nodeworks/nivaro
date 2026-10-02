/**
 * Live tail (#1214): a header action on `entity`, `caller` and `request` levels that toggles a
 * strip at the top of the panel listing the newest 50 live events for that entity / caller /
 * route. It reads the page's own live events (the Traffic Map model the ticker reads — no second
 * socket subscription) and each row opens the most specific level the event names.
 */
import { useQueryClient } from '@tanstack/react-query'
import { Radio, X } from 'lucide-react'
import { useContext, useLayoutEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { TrafficMapContext } from '../../context'
import { callerLabel, fmtMs, KindPill } from '../../EventTicker'
import { fmtClock, refForEvent } from '../../inspect/format'
import type { InspectPanelProps, InspectRef } from '../../registry/inspectables'
import { cachedDetail } from './context'
import { tailEvents, tailMatcher } from './logic'
import { ICON_BTN, ICON_BTN_ON, MUTED, useInspectStack } from './ui'

export const TAIL_KINDS = new Set(['entity', 'caller', 'request'])
const TAIL_MAX = 50

function refKey(r: InspectRef): string {
  return `${r.kind}:${r.id}`
}

/** The panel element of `key` on screen (the last one when split shows two). */
function useLevelHost(key: string, on: boolean): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!on) {
      setEl(null)
      return
    }
    const all = document.querySelectorAll<HTMLElement>('[data-tm-inspect-level]')
    let found: HTMLElement | null = null
    for (const n of all) if (n.getAttribute('data-tm-inspect-level') === key) found = n
    setEl(found)
  }, [key, on])
  return el
}

function TailStrip({
  inspectRef,
  open,
  onClose
}: {
  inspectRef: InspectRef
  open(ref: InspectRef): void
  onClose(): void
}) {
  const ctx = useContext(TrafficMapContext)
  const qc = useQueryClient()
  const s = useInspectStack()
  const detail = cachedDetail(qc, inspectRef, s.anchor)
  const matcher = useMemo(() => tailMatcher(inspectRef, detail), [inspectRef, detail])
  // ctx.tick changes once per applied frame — re-read the model's events then
  const tick = ctx?.tick ?? 0
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick marks a new frame in the mutable model
  const rows = useMemo(
    () => (ctx && matcher ? tailEvents(ctx.model.events, matcher, TAIL_MAX) : []),
    [ctx, matcher, tick]
  )
  return (
    <section
      className='order-first grid gap-1.5 rounded-md border border-[var(--tm-line)] bg-[var(--tm-card-2)] p-2'
      data-tm-inspect-tail={refKey(inspectRef)}
      aria-label='Live tail'
    >
      <div className='flex items-center gap-2'>
        <span className='relative flex h-2 w-2' aria-hidden='true'>
          <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--tm-create)] opacity-60 motion-reduce:animate-none' />
          <span className='relative inline-flex h-2 w-2 rounded-full bg-[var(--tm-create)]' />
        </span>
        <p className='min-w-0 flex-1 truncate text-[12px] font-semibold'>
          Live · {matcher?.label ?? inspectRef.id}
          <span className='ml-1.5 font-normal text-[var(--tm-muted)]'>
            {rows.length === TAIL_MAX ? `newest ${TAIL_MAX}` : `${rows.length} seen`}
          </span>
        </p>
        <button
          type='button'
          className='inline-flex h-6 w-6 items-center justify-center rounded text-[var(--tm-fg-2)] hover:bg-[var(--tm-card)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
          onClick={onClose}
          aria-label='Stop the live tail'
          data-tm-inspect-tail-close=''
        >
          <X className='h-3.5 w-3.5' aria-hidden='true' />
        </button>
      </div>
      {!ctx ? (
        <p className={MUTED}>Live events are only available on the Traffic Map page.</p>
      ) : !matcher ? (
        <p className={MUTED}>
          This request's route is not known yet, so there is nothing to follow. Wait for the request
          to load and try again.
        </p>
      ) : rows.length === 0 ? (
        <p className={MUTED} data-tm-inspect-tail-empty=''>
          {ctx.paused
            ? 'The map is paused — new events show here when it runs again.'
            : `Waiting for traffic on ${matcher.label}. Only events this node streams to the page show here.`}
        </p>
      ) : (
        <ul className='grid max-h-48 overflow-auto' data-tm-inspect-tail-rows=''>
          {rows.map((ev, i) => {
            const target = refForEvent(ev)
            return (
              <li key={`${ev.t}-${ev.rid ?? ''}-${i}`}>
                <button
                  type='button'
                  onClick={() => open(target)}
                  data-tm-inspect-tail-row={`${target.kind}:${target.id}`}
                  data-tip={`Open this ${target.kind}`}
                  className='grid w-full grid-cols-[56px_76px_minmax(0,1fr)_auto] items-center gap-2 rounded px-1 py-0.5 text-left text-[11.5px] hover:bg-[var(--tm-card)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                >
                  <span className='tabular-nums text-[var(--tm-muted)]'>{fmtClock(ev.t)}</span>
                  <KindPill kind={ev.kind} />
                  <span className='truncate text-[var(--tm-fg)]'>
                    {inspectRef.kind === 'request' ? callerLabel(ctx.catalog, ev.caller) : ev.route}
                  </span>
                  <span className='tabular-nums text-[var(--tm-fg-2)]'>
                    {ev.status ? `${ev.status} · ` : ''}
                    {fmtMs(ev.ms ?? 0)}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export function LiveTailAction({ inspectRef, open }: InspectPanelProps) {
  const key = refKey(inspectRef)
  const [tailKey, setTailKey] = useState<string | null>(null)
  const on = tailKey === key
  const host = useLevelHost(key, on)
  return (
    <>
      <button
        type='button'
        className={cn(ICON_BTN, on && ICON_BTN_ON)}
        aria-pressed={on}
        aria-label={on ? 'Stop the live tail' : 'Live tail'}
        data-tip={on ? 'Stop the live tail' : `Follow this ${inspectRef.kind}'s live events here`}
        data-tm-inspect-tail-toggle=''
        onClick={() => setTailKey(on ? null : key)}
      >
        <Radio className='h-4 w-4' aria-hidden='true' />
      </button>
      {on &&
        host &&
        createPortal(
          <TailStrip inspectRef={inspectRef} open={open} onClose={() => setTailKey(null)} />,
          host
        )}
    </>
  )
}
