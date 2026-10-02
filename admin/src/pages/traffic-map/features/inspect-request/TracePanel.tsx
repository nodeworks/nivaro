/**
 * #1191 — one call's kept trace: the phase waterfall, where the time went that nothing measured,
 * and the statements it ran (each opens its statement; any SELECT can show its plan inline).
 */
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { PlanViewer } from '@/components/plan-viewer'
import { cn } from '@/lib/utils'
import { inspectErrorOf, useInspectDetail } from '../../inspect/api'
import { fmtClock, shortId } from '../../inspect/format'
import { InspectLink } from '../../inspect/InspectLink'
import type { InspectPanelProps } from '../../registry/inspectables'
import { BTN, errorOf } from '../shared'
import {
  explainTraceStatement,
  type PlanResult,
  type TraceDetail,
  type TraceRecordWire
} from './api'
import { fmtMs, isWideStatement, layoutWaterfall, repeatOf } from './logic'
import { TraceNextControl } from './TraceNextControl'
import { Note, PanelSkeleton, Section, StatusPill, Tag } from './ui'

export function Waterfall({ trace }: { trace: TraceRecordWire }) {
  const rows = layoutWaterfall(trace.spans, trace.total_ms)
  if (rows.length === 0)
    return (
      <p className='text-[12px] text-[var(--tm-muted)]'>
        No phases were measured inside this call — all of its time is unaccounted.
      </p>
    )
  const slowest = rows.reduce((a, b) => (b.ms > a.ms ? b : a))
  return (
    <ul className='grid gap-0.5' data-tm-inspect-waterfall=''>
      {rows.map((r) => (
        <li
          key={r.seq}
          className='grid grid-cols-[minmax(0,42%)_minmax(0,1fr)_4.5rem] items-center gap-2 text-[11.5px]'
          data-tm-inspect-span={r.phase}
        >
          <span
            className='min-w-0 truncate text-[var(--tm-fg)]'
            style={{ paddingLeft: `${Math.min(r.depth, 6) * 10}px` }}
            data-tip={r.detail ? `${r.phase} — ${r.detail}` : r.phase}
          >
            {r.phase}
            {r.queries ? (
              <span className='ml-1 text-[var(--tm-muted)]'>· {r.queries} q</span>
            ) : null}
            {r.repeat ? (
              <span className='ml-1'>
                <Tag warn tip={`The same statement ran ${r.repeat.n} times inside this phase`}>
                  N+1 ×{r.repeat.n}
                </Tag>
              </span>
            ) : null}
          </span>
          <span className='relative h-3 rounded-sm bg-[var(--tm-card-2)]'>
            <span
              className={cn(
                'absolute inset-y-0 rounded-sm',
                r === slowest ? 'bg-[var(--tm-update)]' : 'bg-[var(--tm-accent)]'
              )}
              style={{ left: `${r.left}%`, width: `${r.width}%` }}
            />
          </span>
          <span className='text-right tabular-nums text-[var(--tm-fg-2)]'>{fmtMs(r.ms)}</span>
        </li>
      ))}
    </ul>
  )
}

function PlanBlock({ result }: { result: PlanResult }) {
  return (
    <div className='grid gap-1.5' data-tm-inspect-plan={result.source}>
      <p className='text-[11.5px] text-[var(--tm-fg-2)]'>
        {result.source === 'cache' && result.stats
          ? `From the plan cache — the plan this route really got: ${result.stats.execution_count} runs, avg ${result.stats.avg_elapsed_ms} ms, max ${result.stats.max_elapsed_ms} ms, ${result.stats.avg_logical_reads.toLocaleString()} logical reads on average.`
          : 'Estimated — the cached plan was evicted, so this is the optimizer’s answer over declared variables (no parameter sniffing). It can differ from what the route got.'}
      </p>
      {result.plan ? (
        <PlanViewer xml={result.plan} />
      ) : (
        <p className='text-[11.5px] text-[var(--tm-muted)]'>No plan came back.</p>
      )}
    </div>
  )
}

export function StatementList({ rid, trace }: { rid: string; trace: TraceRecordWire }) {
  const [open, setOpen] = useState<number | null>(null)
  const explain = useMutation({
    mutationFn: (index: number) => explainTraceStatement(rid, index),
    onMutate: (index) => setOpen(index)
  })
  if (trace.top_sql.length === 0)
    return <p className='text-[12px] text-[var(--tm-muted)]'>This call ran no SQL.</p>
  return (
    <ul className='grid gap-1' data-tm-inspect-statements=''>
      {trace.top_sql.map((s) => {
        const repeat = repeatOf(s.sql, trace.spans)
        const wide = isWideStatement(s.sql, trace.wide)
        return (
          <li key={s.index} className='grid gap-1' data-tm-inspect-statement-row={s.sha}>
            <div className='flex min-w-0 items-center gap-2 text-[11.5px]'>
              <span className='w-14 shrink-0 text-right tabular-nums text-[var(--tm-fg)]'>
                {fmtMs(s.ms)}
              </span>
              <span className='w-8 shrink-0 text-right tabular-nums text-[var(--tm-muted)]'>
                {s.n > 1 ? `×${s.n}` : ''}
              </span>
              <InspectLink
                inspectRef={{ kind: 'statement', id: s.sha, label: s.sql.slice(0, 60) }}
                className='min-w-0 flex-1 font-mono text-[11px]'
              >
                {s.sql}
              </InspectLink>
              {repeat != null && (
                <Tag warn tip={`Ran ${repeat} times inside one phase — an N+1`}>
                  N+1
                </Tag>
              )}
              {wide && (
                <Tag
                  warn
                  tip='select * on a table with a long-text column drags it all over the wire'
                >
                  wide
                </Tag>
              )}
              {s.select && !s.truncated ? (
                <button
                  type='button'
                  className={BTN}
                  disabled={explain.isPending && open === s.index}
                  onClick={() => (open === s.index ? setOpen(null) : explain.mutate(s.index))}
                  data-tm-inspect-plan-btn={s.index}
                >
                  {open === s.index ? 'Hide plan' : 'Plan'}
                </button>
              ) : (
                <span
                  className='shrink-0 text-[10.5px] text-[var(--tm-muted)]'
                  data-tip={
                    s.truncated
                      ? 'The statement was cut when captured — too long to replay for a plan'
                      : 'Plans are shown for SELECT statements only'
                  }
                >
                  no plan
                </span>
              )}
            </div>
            {open === s.index && (
              <div className='pl-24'>
                {explain.isPending ? (
                  <PanelSkeleton rows={3} />
                ) : explain.error ? (
                  <Note tone='error'>{errorOf(explain.error)}</Note>
                ) : explain.data ? (
                  <PlanBlock result={explain.data} />
                ) : null}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function TracePanel({ inspectRef, anchor, windowSec }: InspectPanelProps) {
  const q = useInspectDetail<TraceDetail>(inspectRef, anchor, windowSec)
  if (q.isLoading) return <PanelSkeleton />
  if (q.error) return <Note tone='error'>{inspectErrorOf(q.error).message}</Note>
  const d = q.data
  if (!d) return <PanelSkeleton />
  if (!d.kept || !d.trace) {
    return (
      <div className='grid gap-3' data-tm-inspect-trace={d.rid}>
        <Note hook={`trace-${d.code ?? 'unknown'}`}>{d.reason}</Note>
        {d.route ? (
          <TraceNextControl
            route={d.route}
            caller={d.caller && d.caller.key !== 'anon' ? d.caller.key : null}
          />
        ) : (
          <p className='text-[12px] text-[var(--tm-muted)]'>
            The request is not in the API log either, so its route is unknown here.
          </p>
        )}
        <p className='text-[12px]'>
          <InspectLink
            inspectRef={{ kind: 'request', id: d.rid, label: `Request ${shortId(d.rid)}` }}
          >
            Open the request
          </InspectLink>
        </p>
      </div>
    )
  }
  const t = d.trace
  return (
    <div className='grid gap-4' data-tm-inspect-trace={d.rid}>
      <div className='grid gap-1'>
        <div className='flex flex-wrap items-center gap-2'>
          <StatusPill status={t.status} />
          <span className='min-w-0 truncate font-mono text-[12.5px] font-semibold text-[var(--tm-fg)]'>
            {t.method} {t.route}
          </span>
        </div>
        <div className='flex flex-wrap gap-x-3 text-[12px] text-[var(--tm-fg-2)]'>
          <span className='tabular-nums'>{fmtMs(t.total_ms)} total</span>
          <span>{t.queries} queries</span>
          <span>{fmtMs(t.sql_ms)} in SQL</span>
          <span>{fmtClock(Date.parse(t.ts))}</span>
          <span data-tip='Traces live in the memory of the API process that served the call'>
            process {d.node}
          </span>
        </div>
        <p className='text-[12px]'>
          <InspectLink
            inspectRef={{ kind: 'request', id: d.rid, label: `Request ${shortId(d.rid)}` }}
          >
            Open the request
          </InspectLink>
        </p>
      </div>
      <Section
        title='Where the time went'
        hook='waterfall'
        aside={
          <span
            className='text-[11px] text-[var(--tm-muted)]'
            data-tm-inspect-unaccounted={t.unaccounted_ms}
            data-tip='Time inside the call that no phase measured — where the next span belongs'
          >
            unaccounted {fmtMs(t.unaccounted_ms)}
          </span>
        }
      >
        <Waterfall trace={t} />
      </Section>
      <Section title='Heaviest statements' hook='top-sql'>
        <StatementList rid={d.rid} trace={t} />
      </Section>
    </div>
  )
}
