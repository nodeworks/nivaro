/**
 * #1207 — two calls side by side: status, time, phase timings, statement shapes and query params.
 * "Compare with…" in a request panel's header picks the second call from the same route's
 * recent requests.
 */
import { GitCompare } from 'lucide-react'
import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { inspectErrorOf, useInspectDetail } from '../../inspect/api'
import { fmtClock, shortId } from '../../inspect/format'
import { InspectLink } from '../../inspect/InspectLink'
import type { InspectPanelProps } from '../../registry/inspectables'
import { BTN } from '../shared'
import { type CompareDetail, type CompareSideWire, useCompareCandidates } from './api'
import { compareBars, fmtDelta, fmtMs } from './logic'
import { Note, PanelSkeleton, Section, StatusPill, Tag } from './ui'

function SideHead({ side, name }: { side: CompareSideWire; name: 'A' | 'B' }) {
  const r = side.row
  return (
    <div className='grid min-w-0 gap-0.5' data-tm-inspect-compare-side={name}>
      <span className='text-[11px] text-[var(--tm-muted)]'>{name}</span>
      <InspectLink
        inspectRef={{
          kind: 'request',
          id: side.rid,
          label: r?.route ?? `Request ${shortId(side.rid)}`
        }}
        className='font-mono text-[11.5px]'
      >
        {r ? `${r.method} ${r.path}` : `Request ${shortId(side.rid)}`}
      </InspectLink>
      <span className='flex items-center gap-2 text-[11.5px] text-[var(--tm-fg-2)]'>
        <StatusPill status={r?.status ?? side.trace?.status ?? null} />
        {r?.created_at ? fmtClock(Date.parse(r.created_at)) : 'not in the log'}
        {r?.caller ? ` · ${r.caller.label}` : ''}
      </span>
    </div>
  )
}

function SqlList({
  title,
  rows,
  hook
}: {
  title: string
  rows: Array<{ sha: string; sql: string; text: string }>
  hook: string
}) {
  if (rows.length === 0) return null
  return (
    <div className='grid gap-0.5' data-tm-inspect-compare-sql={hook}>
      <span className='text-[11.5px] text-[var(--tm-muted)]'>{title}</span>
      {rows.map((s) => (
        <div key={s.sha} className='flex min-w-0 items-center gap-2 text-[11.5px]'>
          <span className='w-28 shrink-0 text-right tabular-nums text-[var(--tm-fg-2)]'>
            {s.text}
          </span>
          <InspectLink
            inspectRef={{ kind: 'statement', id: s.sha, label: s.sql.slice(0, 60) }}
            className='min-w-0 flex-1 font-mono text-[11px]'
          >
            {s.sql}
          </InspectLink>
        </div>
      ))}
    </div>
  )
}

export function ComparePanel({ inspectRef, anchor, windowSec }: InspectPanelProps) {
  const q = useInspectDetail<CompareDetail>(inspectRef, anchor, windowSec)
  if (q.isLoading) return <PanelSkeleton />
  if (q.error) {
    const e = inspectErrorOf(q.error)
    return (
      <Note tone={e.status === 404 ? 'muted' : 'error'}>
        {e.status === 404
          ? 'Neither call is in the API log or held as a trace on this API process.'
          : e.message}
      </Note>
    )
  }
  const d = q.data
  if (!d) return <PanelSkeleton />
  const diff = d.diff
  const bars = compareBars(diff.phases)
  const sqlChanged =
    diff.sql.added.length +
    diff.sql.removed.length +
    diff.sql.slower.length +
    diff.sql.faster.length
  const params = diff.params.filter((p) => p.change !== 'same')
  return (
    <div className='grid gap-4' data-tm-inspect-compare={inspectRef.id}>
      <div className='grid grid-cols-2 gap-3'>
        <SideHead side={d.a} name='A' />
        <SideHead side={d.b} name='B' />
      </div>

      <Section title='Outcome' hook='compare-outcome'>
        <p
          className='text-[12px] text-[var(--tm-fg)]'
          data-tm-inspect-compare-ms={diff.ms.delta ?? ''}
        >
          {diff.status.same
            ? `Both answered ${diff.status.a ?? '—'}. `
            : `Status ${diff.status.a ?? '—'} → ${diff.status.b ?? '—'}. `}
          B took {fmtMs(diff.ms.b)} against A’s {fmtMs(diff.ms.a)}
          {diff.ms.delta != null
            ? ` (${fmtDelta(diff.ms.delta)}${diff.ms.pct != null ? `, ${diff.ms.pct > 0 ? '+' : ''}${diff.ms.pct}%` : ''})`
            : ''}
          .
        </p>
      </Section>

      <Section title='Phases' hook='compare-phases'>
        {d.a.trace && d.b.trace ? (
          <ul className='grid gap-1' data-tm-inspect-compare-phases=''>
            {diff.phases.map((p, i) => (
              <li
                key={p.phase}
                className='grid grid-cols-[minmax(0,34%)_minmax(0,1fr)_4.5rem] items-center gap-2 text-[11.5px]'
              >
                <span className='min-w-0 truncate text-[var(--tm-fg)]' data-tip={p.phase}>
                  {p.phase}
                </span>
                <span className='grid gap-[2px]'>
                  <span className='h-2 rounded-sm bg-[var(--tm-card-2)]'>
                    <span
                      className='block h-2 rounded-sm bg-[var(--tm-fg-2)]'
                      style={{ width: `${bars[i].a}%` }}
                      data-tip={`A: ${fmtMs(p.a)}`}
                    />
                  </span>
                  <span className='h-2 rounded-sm bg-[var(--tm-card-2)]'>
                    <span
                      className='block h-2 rounded-sm bg-[var(--tm-accent)]'
                      style={{ width: `${bars[i].b}%` }}
                      data-tip={`B: ${fmtMs(p.b)}`}
                    />
                  </span>
                </span>
                <span
                  className={cn(
                    'text-right tabular-nums',
                    (p.delta ?? 0) > 0 ? 'text-[var(--tm-error-ink)]' : 'text-[var(--tm-fg-2)]'
                  )}
                >
                  {p.delta == null ? (p.a == null ? 'only B' : 'only A') : fmtDelta(p.delta)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Note hook='compare-no-trace'>
            {!d.a.trace && d.a.absence ? `A: ${d.a.absence.reason} ` : ''}
            {!d.b.trace && d.b.absence ? `B: ${d.b.absence.reason}` : ''}
          </Note>
        )}
        {d.a.trace && d.b.trace && (
          <p className='text-[11px] text-[var(--tm-muted)]'>
            Grey is A, accent is B; each phase’s time is summed over every span of that name.
          </p>
        )}
      </Section>

      <Section title='Statements' hook='compare-sql'>
        {!diff.sql.comparable ? (
          <p className='text-[12px] text-[var(--tm-muted)]'>
            Statements compare only when both calls kept a trace.
          </p>
        ) : sqlChanged === 0 ? (
          <p className='text-[12px] text-[var(--tm-muted)]'>
            The same statement shapes, at about the same speed.
          </p>
        ) : (
          <div className='grid gap-2'>
            <SqlList
              title='Slower in B'
              hook='slower'
              rows={diff.sql.slower.map((s) => ({
                ...s,
                text: `${fmtMs(s.a_ms)} → ${fmtMs(s.b_ms)}`
              }))}
            />
            <SqlList
              title='Only in B'
              hook='added'
              rows={diff.sql.added.map((s) => ({ ...s, text: `${fmtMs(s.ms)} ×${s.n}` }))}
            />
            <SqlList
              title='Only in A'
              hook='removed'
              rows={diff.sql.removed.map((s) => ({ ...s, text: `${fmtMs(s.ms)} ×${s.n}` }))}
            />
            <SqlList
              title='Faster in B'
              hook='faster'
              rows={diff.sql.faster.map((s) => ({
                ...s,
                text: `${fmtMs(s.a_ms)} → ${fmtMs(s.b_ms)}`
              }))}
            />
          </div>
        )}
      </Section>

      <Section title='Query params' hook='compare-params'>
        {params.length === 0 ? (
          <p className='text-[12px] text-[var(--tm-muted)]'>
            {diff.params.length === 0
              ? 'Neither call had a query string.'
              : 'Identical query strings.'}
          </p>
        ) : (
          <table className='w-full text-left text-[11.5px]' data-tm-inspect-compare-params=''>
            <thead>
              <tr className='text-[var(--tm-muted)]'>
                <th className='py-0.5 font-normal'>Name</th>
                <th className='py-0.5 font-normal'>A</th>
                <th className='py-0.5 font-normal'>B</th>
              </tr>
            </thead>
            <tbody className='font-mono'>
              {params.map((p) => (
                <tr key={p.name} data-tm-inspect-param-change={p.change}>
                  <td className='py-0.5 pr-2 text-[var(--tm-fg)]'>{p.name}</td>
                  <td className='break-all py-0.5 pr-2 text-[var(--tm-fg-2)]'>{p.a ?? '—'}</td>
                  <td className='break-all py-0.5 text-[var(--tm-fg)]'>{p.b ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  )
}

/** Header action on a request panel: pick another call of the same route to compare with. */
export function CompareAction({ inspectRef, anchor, open: openRef }: InspectPanelProps) {
  const [open, setOpen] = useState(false)
  const at = inspectRef.at ?? anchor ?? null
  const q = useCompareCandidates(inspectRef.id, at, open)
  const err = q.error ? inspectErrorOf(q.error) : null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={BTN}
          data-tm-inspect-compare-with=''
          data-tip='Compare this call with another call of the same route'
        >
          <GitCompare className='h-3.5 w-3.5' aria-hidden='true' />
          Compare with…
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[340px] p-2'>
        <div className='traffic-map grid gap-1.5' data-tm-inspect-compare-picker=''>
          <span className='text-[12px] font-medium text-[var(--tm-fg)]'>
            {q.data ? `${q.data.route}, within an hour` : 'Same route, within an hour'}
          </span>
          {q.isLoading ? (
            <PanelSkeleton rows={4} />
          ) : err ? (
            <p className='text-[11.5px] text-[var(--tm-muted)]'>{err.message}</p>
          ) : (q.data?.candidates.length ?? 0) === 0 ? (
            <p className='text-[11.5px] text-[var(--tm-muted)]'>
              No other call of this route within an hour of this one.
            </p>
          ) : (
            <ul className='grid max-h-72 gap-0.5 overflow-auto'>
              {q.data?.candidates.map((c) => (
                <li key={c.request_id}>
                  <button
                    type='button'
                    className='flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[11.5px] hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                    data-tm-inspect-compare-pick={c.request_id}
                    onClick={() => {
                      setOpen(false)
                      openRef({
                        kind: 'compare',
                        id: `${inspectRef.id},${c.request_id}`,
                        label: `Compare ${shortId(inspectRef.id)} · ${shortId(c.request_id)}`
                      })
                    }}
                  >
                    <span className='tabular-nums text-[var(--tm-fg-2)]'>
                      {c.created_at ? fmtClock(Date.parse(c.created_at)) : '—'}
                    </span>
                    <StatusPill status={c.status} />
                    <span className='tabular-nums text-[var(--tm-fg)]'>{fmtMs(c.latency_ms)}</span>
                    <span className='ml-auto flex gap-1'>
                      {c.traced && (
                        <Tag tip='This call’s trace is held — phases and SQL will compare'>
                          traced
                        </Tag>
                      )}
                      {c.same_caller && <Tag tip='Made by the same caller'>same caller</Tag>}
                      {c.by_chain && (
                        <Tag tip='A root /graphql call, logged without a request id — named by its chain'>
                          by chain
                        </Tag>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
