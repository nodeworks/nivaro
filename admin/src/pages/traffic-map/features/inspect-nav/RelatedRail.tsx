/**
 * Related rail (#1204), under every investigation level: what else shares this level's chain,
 * record, caller, error or page load — each a collapsible group of links that drill in place.
 * Plus a one-line "Page load" link for request levels whose page load this API process still holds.
 */
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { inspectErrorOf } from '../../inspect/api'
import { fmtClock } from '../../inspect/format'
import { InspectLink } from '../../inspect/InspectLink'
import type { InspectPanelProps } from '../../registry/inspectables'
import { type RelatedGroup, useRelated } from './api'
import { windowText } from './logic'
import { PanelSkeleton } from './parts'

function Group({ g, defaultOpen }: { g: RelatedGroup; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const id = `tm-related-${g.key}`
  return (
    <li data-tm-inspect-related-group={g.key}>
      <button
        type='button'
        className='flex w-full items-center gap-1 rounded-sm py-0.5 text-left text-[12px] font-medium text-[var(--tm-fg-2)] hover:text-[var(--tm-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        data-tm-inspect-related-toggle={g.key}
      >
        {open ? (
          <ChevronDown className='h-3.5 w-3.5 shrink-0' aria-hidden='true' />
        ) : (
          <ChevronRight className='h-3.5 w-3.5 shrink-0' aria-hidden='true' />
        )}
        <span className='min-w-0 truncate'>{g.label}</span>
        <span className='ml-auto shrink-0 tabular-nums text-[11px] text-[var(--tm-muted)]'>
          {g.refs.length + (g.more ?? 0)}
        </span>
      </button>
      {open && (
        <ul id={id} className='ml-[18px] grid gap-0.5 pb-1'>
          {g.refs.map((r) => (
            <li
              key={`${r.kind}:${r.id}`}
              className='flex min-w-0 items-baseline gap-2 text-[12px]'
              data-tm-inspect-related-item={`${r.kind}:${r.id}`}
            >
              <span className='w-[64px] shrink-0 text-[11px] text-[var(--tm-muted)]'>{r.kind}</span>
              <InspectLink inspectRef={r} className='flex-1'>
                {r.label ?? r.id}
              </InspectLink>
              {r.at != null && (
                <span className='shrink-0 font-mono text-[10.5px] tabular-nums text-[var(--tm-muted)]'>
                  {fmtClock(r.at)}
                </span>
              )}
            </li>
          ))}
          {g.more ? (
            <li
              className='text-[11.5px] text-[var(--tm-muted)]'
              data-tm-inspect-related-more={g.more}
            >
              and {g.more.toLocaleString()} more not shown
            </li>
          ) : null}
        </ul>
      )}
    </li>
  )
}

export function RelatedRail({ inspectRef, anchor, windowSec }: InspectPanelProps) {
  const q = useRelated(inspectRef, anchor, windowSec)
  return (
    <section aria-label='Related' className='grid gap-1.5' data-tm-inspect-related=''>
      <h3 className='flex items-baseline gap-2 text-[12px] font-semibold text-[var(--tm-fg-2)]'>
        Related
        <span className='text-[11px] font-normal text-[var(--tm-muted)]'>
          {windowText(windowSec)} around {fmtClock(inspectRef.at ?? anchor ?? Date.now())}
        </span>
      </h3>
      {q.isLoading ? (
        <PanelSkeleton rows={[70, 55, 62]} />
      ) : q.isError ? (
        <p className='text-[12px] text-[var(--tm-muted)]' data-tm-inspect-related-error=''>
          {inspectErrorOf(q.error).status === 400
            ? 'Nothing can be related to this level (its id is not one the Related rail understands).'
            : `Could not read related items: ${inspectErrorOf(q.error).message}`}
        </p>
      ) : (
        <>
          {q.data && q.data.groups.length > 0 ? (
            <ul className='grid gap-0.5'>
              {q.data.groups.map((g, i) => (
                <Group key={g.key} g={g} defaultOpen={i < 2} />
              ))}
            </ul>
          ) : null}
          {(q.data?.notes ?? []).map((n) => (
            <p
              key={n}
              className='text-[11.5px] text-[var(--tm-muted)]'
              data-tm-inspect-related-note=''
            >
              {n}
            </p>
          ))}
        </>
      )}
    </section>
  )
}

const LOAD_KINDS = new Set(['request', 'trace', 'ai'])

/** "Page load · /collections/:collection · 23 calls" for a request level, when still held. */
export function PageLoadLink({ inspectRef, anchor, windowSec }: InspectPanelProps) {
  const q = useRelated(inspectRef, anchor, windowSec)
  const load = q.data?.load
  if (!load) return null
  return (
    <p
      className='flex min-w-0 items-baseline gap-2 text-[12px]'
      data-tm-inspect-page-load={load.id}
    >
      <span className='shrink-0 font-medium text-[var(--tm-fg-2)]'>Page load</span>
      <InspectLink inspectRef={{ kind: 'load', id: load.id, label: `Page load · ${load.page}` }}>
        {load.page} · {load.calls} {load.calls === 1 ? 'call' : 'calls'}
      </InspectLink>
    </p>
  )
}

export const pageLoadApplies = (ref: { kind: string }) => LOAD_KINDS.has(ref.kind)
