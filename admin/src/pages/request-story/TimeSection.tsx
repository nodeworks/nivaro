/**
 * Where the time went: the top-level split (sign-in, access checks, hooks, other work, what no
 * phase measured) and the phase waterfall on one time axis. Every phase opens its leaf.
 */

import { useState } from 'react'
import { Link } from 'react-router'
import { cn, formatNumber } from '@/lib/utils'
import { axisTicks, fmtMs, type Leaf, pct, trafficMapPath } from './logic'
import type { PhaseCategory, Story, StoryTraceDetail } from './types'
import { Hint, LeafRow, Panel, Section } from './ui'

export const CATEGORY_SWATCH: Record<PhaseCategory | 'unmeasured', string> = {
  auth: 'bg-sky-500 dark:bg-sky-400',
  access: 'bg-violet-500 dark:bg-violet-400',
  hooks: 'bg-amber-500 dark:bg-amber-400',
  work: 'bg-nvr-cyan',
  unmeasured:
    'bg-[repeating-linear-gradient(135deg,rgb(148_163_184/0.55)_0_3px,transparent_3px_6px)] dark:bg-[repeating-linear-gradient(135deg,rgb(100_116_139/0.7)_0_3px,transparent_3px_6px)]'
}

export const CATEGORY_LABEL: Record<PhaseCategory, string> = {
  auth: 'Sign-in',
  access: 'Access checks',
  hooks: 'Hooks & rules',
  work: 'Work'
}

const SHOWN = 40

export function TimeSection({
  story,
  leaf,
  onOpen
}: {
  story: Story
  leaf: Leaf | null
  onOpen: (l: Leaf) => void
}) {
  const t = story.trace
  if (!t) {
    const why =
      story.missing.find((m) => /trac/i.test(m)) ??
      'No trace was kept for this request, so its phase timings are not known.'
    return (
      <Section id='time' title='Where the time went'>
        <Panel className='px-4 py-3'>
          <Hint>{why}</Hint>
          <Hint className='mt-1.5'>
            Slow requests are traced on the API process that served them.{' '}
            <Link
              to={trafficMapPath(story.request_id)}
              className='font-medium text-sky-700 underline-offset-2 hover:underline dark:text-nvr-cyan'
            >
              Trace the next call to this route in the Traffic Map
            </Link>
          </Hint>
        </Panel>
      </Section>
    )
  }
  return (
    <Section
      id='time'
      title='Where the time went'
      count={fmtMs(t.total_ms)}
      aside={
        <span className='text-slate-500 dark:text-muted-foreground'>
          SQL waited{' '}
          <span className='tabular-nums text-slate-800 dark:text-foreground'>
            {fmtMs(t.sql_ms)}
          </span>{' '}
          over {t.queries} {t.queries === 1 ? 'round trip' : 'round trips'}
        </span>
      }
    >
      <Panel>
        <Split trace={t} />
        <Waterfall trace={t} leaf={leaf} onOpen={onOpen} />
      </Panel>
    </Section>
  )
}

function Split({ trace: t }: { trace: StoryTraceDetail }) {
  const total = Math.max(1, t.total_ms)
  return (
    <div className='border-b border-slate-100 px-4 py-3 dark:border-border'>
      <div
        className='flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-muted'
        role='img'
        aria-label={t.split.map((s) => `${s.label} ${fmtMs(s.ms)}`).join(', ')}
      >
        {t.split.map((s) => (
          <span
            key={s.key}
            className={cn('h-full', CATEGORY_SWATCH[s.key])}
            style={{ width: `${pct(s.ms, total)}%` }}
          />
        ))}
      </div>
      <ul className='m-0 mt-2.5 flex list-none flex-wrap gap-x-5 gap-y-1.5 p-0 text-[12px]'>
        {t.split.map((s) => (
          <li key={s.key} className='flex items-center gap-1.5'>
            <span aria-hidden className={cn('h-2.5 w-2.5 rounded-sm', CATEGORY_SWATCH[s.key])} />
            <span className='text-slate-600 dark:text-muted-foreground'>{s.label}</span>
            <span className='tabular-nums font-medium text-slate-900 dark:text-foreground'>
              {fmtMs(s.ms)}
            </span>
            <span className='tabular-nums text-slate-400 dark:text-muted-foreground'>
              {Math.round((s.ms / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
      {t.sql_ms > t.total_ms && (
        <Hint className='mt-1.5'>
          SQL waited longer than the request took: statements ran side by side, so their times
          overlap.
        </Hint>
      )}
      {t.split.some((s) => s.key === 'unmeasured') && (
        <Hint className='mt-1.5'>
          Not measured is time no phase covered: the route’s own code, building the answer and
          waiting for the network.
        </Hint>
      )}
    </div>
  )
}

function Waterfall({
  trace: t,
  leaf,
  onOpen
}: {
  trace: StoryTraceDetail
  leaf: Leaf | null
  onOpen: (l: Leaf) => void
}) {
  const [all, setAll] = useState(false)
  const total = Math.max(1, t.total_ms, ...t.phases.map((p) => p.at + p.ms))
  const ticks = axisTicks(total)
  const rows = all ? t.phases : t.phases.slice(0, SHOWN)
  const slowest = t.phases.length > 0 ? t.phases.reduce((a, b) => (b.ms > a.ms ? b : a)).seq : null
  if (t.phases.length === 0)
    return (
      <Hint className='px-4 py-3'>
        No phase inside this request was measured — all of its time is “not measured”.
      </Hint>
    )
  return (
    <div>
      {/* Axis */}
      <div
        aria-hidden
        className='grid grid-cols-[minmax(0,38%)_minmax(0,1fr)_64px] gap-3 px-4 pb-1 pt-2 text-[10.5px] tabular-nums text-slate-400 dark:text-muted-foreground'
      >
        <span>Phase</span>
        <span className='relative h-3.5'>
          {ticks.map((tk) => (
            <span
              key={tk}
              className='absolute top-0 -translate-x-1/2 last:-translate-x-full first:translate-x-0'
              style={{ left: `${pct(tk, total)}%` }}
            >
              {fmtMs(tk)}
            </span>
          ))}
        </span>
        <span className='text-right'>Took</span>
      </div>
      <ol className='m-0 list-none p-0' aria-label='Phases in start order'>
        {rows.map((p) => {
          const selected = leaf?.type === 'phase' && leaf.seq === p.seq
          return (
            <li key={p.seq}>
              <LeafRow
                list='phase'
                selected={selected}
                onOpen={() => onOpen({ type: 'phase', seq: p.seq })}
                label={`${p.label}, starts at ${fmtMs(p.at)}, took ${fmtMs(p.ms)}`}
                className='grid grid-cols-[minmax(0,38%)_minmax(0,1fr)_64px] items-center gap-3 px-4 py-[5px] text-[12px]'
              >
                <span
                  className='flex min-w-0 items-center gap-1.5'
                  style={{ paddingLeft: `${Math.min(p.depth, 6) * 14}px` }}
                >
                  <span
                    aria-hidden
                    className={cn('h-2 w-2 shrink-0 rounded-sm', CATEGORY_SWATCH[p.category])}
                  />
                  <span className='truncate text-slate-800 dark:text-foreground'>{p.label}</span>
                  {p.repeat && (
                    <span className='shrink-0 rounded bg-amber-100 px-1 text-[10.5px] font-semibold text-amber-900 dark:bg-amber-500/15 dark:text-amber-300'>
                      N+1 ×{formatNumber(p.repeat.n)}
                    </span>
                  )}
                  {p.queries ? (
                    <span className='shrink-0 text-[11px] tabular-nums text-slate-400 dark:text-muted-foreground'>
                      {p.queries} q
                    </span>
                  ) : null}
                </span>
                <span className='relative h-3.5'>
                  {ticks.slice(1).map((tk) => (
                    <span
                      key={tk}
                      aria-hidden
                      className='absolute inset-y-0 w-px bg-slate-100 dark:bg-border/60'
                      style={{ left: `${pct(tk, total)}%` }}
                    />
                  ))}
                  <span
                    aria-hidden
                    className={cn(
                      'absolute top-0.5 bottom-0.5 min-w-[2px] rounded-sm',
                      CATEGORY_SWATCH[p.category],
                      p.seq === slowest ? 'opacity-100' : 'opacity-80'
                    )}
                    style={{
                      left: `${pct(p.at, total)}%`,
                      width: `${Math.max(0.3, pct(p.ms, total))}%`
                    }}
                  />
                </span>
                <span
                  className={cn(
                    'text-right tabular-nums',
                    p.seq === slowest
                      ? 'font-semibold text-slate-900 dark:text-foreground'
                      : 'text-slate-600 dark:text-muted-foreground'
                  )}
                >
                  {fmtMs(p.ms)}
                </span>
              </LeafRow>
            </li>
          )
        })}
      </ol>
      {t.phases.length > SHOWN && (
        <button
          type='button'
          onClick={() => setAll((v) => !v)}
          className='w-full border-t border-slate-100 px-4 py-2 text-left text-[12px] font-medium text-sky-700 hover:bg-slate-50 dark:border-border dark:text-nvr-cyan dark:hover:bg-muted/50'
        >
          {all ? 'Show the first 40' : `Show all ${t.phases.length} phases`}
        </button>
      )}
    </div>
  )
}
