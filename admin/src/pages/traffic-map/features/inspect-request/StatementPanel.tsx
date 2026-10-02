/**
 * #1202 — one statement shape: its text, how it runs (plan cache), the routes that ran it and any
 * index the advisor would add for the tables it touches.
 */
import { PlanViewer } from '@/components/plan-viewer'
import { inspectErrorOf, useInspectDetail } from '../../inspect/api'
import { fmtClock, shortId } from '../../inspect/format'
import { InspectLink } from '../../inspect/InspectLink'
import type { InspectPanelProps } from '../../registry/inspectables'
import type { StatementDetail } from './api'
import { fmtMs } from './logic'
import { Code, CopyButton, Facts, Note, PanelSkeleton, Section } from './ui'

export function StatementPanel({ inspectRef, anchor, windowSec }: InspectPanelProps) {
  const q = useInspectDetail<StatementDetail>(inspectRef, anchor, windowSec)
  if (q.isLoading) return <PanelSkeleton />
  if (q.error) {
    const e = inspectErrorOf(q.error)
    return (
      <Note tone={e.status === 404 ? 'muted' : 'error'} hook='statement-missing'>
        {e.status === 404
          ? 'Not seen in a kept trace on this API process. Statement shapes are remembered from kept traces only (the last 500 shapes, per process) — a fast call is not traced, and a restart forgets them.'
          : e.message}
      </Note>
    )
  }
  const d = q.data
  if (!d) return <PanelSkeleton />
  const stats = d.plan?.stats
  return (
    <div className='grid gap-4' data-tm-inspect-statement={d.sha}>
      <Section title='Statement' hook='text' aside={<CopyButton text={d.text} hook='statement' />}>
        <Code text={d.text} hook='statement-text' max='max-h-48' />
        {d.truncated && (
          <Note tone='warn'>The text was cut at 600 characters when the trace captured it.</Note>
        )}
        {d.bindings.length > 0 && (
          <p className='font-mono text-[11px] text-[var(--tm-muted)]' data-tm-inspect-bindings=''>
            Last bindings:{' '}
            {d.bindings
              .slice(0, 12)
              .map((b, i) => `@p${i} = ${JSON.stringify(b)}`)
              .join(', ')}
            {d.bindings.length > 12 ? ' …' : ''}
          </p>
        )}
      </Section>

      <Section title='Seen in traces' hook='seen'>
        <Facts
          items={[
            ['Kept traces', String(d.traces)],
            ['Runs in them', String(d.calls)],
            ['Average per run', fmtMs(d.avg_ms)],
            ['Slowest run', fmtMs(d.max_ms)],
            ['Last seen', fmtClock(d.last_seen)],
            [
              'Last call',
              <InspectLink
                key='last'
                inspectRef={{
                  kind: 'trace',
                  id: d.last_rid,
                  label: `Trace ${shortId(d.last_rid)}`
                }}
              >
                trace {shortId(d.last_rid)}
              </InspectLink>
            ]
          ]}
        />
      </Section>

      <Section title='How SQL Server runs it' hook='plan'>
        {d.plan ? (
          <>
            {d.plan.source === 'cache' && stats ? (
              <Facts
                items={[
                  ['From', 'the plan cache — the plan the route really got'],
                  ['Executions', stats.execution_count.toLocaleString()],
                  ['Average', fmtMs(stats.avg_elapsed_ms)],
                  ['Last', fmtMs(stats.last_elapsed_ms)],
                  ['Slowest', fmtMs(stats.max_elapsed_ms)],
                  ['Logical reads (avg)', stats.avg_logical_reads.toLocaleString()],
                  stats.last_execution_time && [
                    'Last ran',
                    fmtClock(Date.parse(stats.last_execution_time))
                  ]
                ]}
              />
            ) : (
              <Note tone='warn' hook='plan-estimated'>
                Estimated — the cached plan was evicted, so this is the optimizer’s answer over
                declared variables. It can differ from the plan the route got.
              </Note>
            )}
            {d.plan.plan ? (
              <PlanViewer xml={d.plan.plan} />
            ) : (
              <p className='text-[12px] text-[var(--tm-muted)]'>No plan came back.</p>
            )}
          </>
        ) : (
          <Note hook='plan-none'>{d.plan_note ?? 'No plan available.'}</Note>
        )}
      </Section>

      <Section
        title='Index advice'
        hook='advice'
        aside={
          d.tables.length > 0 ? (
            <span className='text-[11px] text-[var(--tm-muted)]'>for {d.tables.join(', ')}</span>
          ) : null
        }
      >
        {d.advice == null ? (
          <Note>The index advisor could not be read just now.</Note>
        ) : d.advice.length === 0 ? (
          <p className='text-[12px] text-[var(--tm-muted)]'>
            The index advisor suggests nothing for the tables this statement touches (it looks at
            tables over 50,000 rows). The plan above lists any index SQL Server itself asked for.
          </p>
        ) : (
          <ul className='grid gap-2' data-tm-inspect-advice=''>
            {d.advice.map((a) => (
              <li key={`${a.table}.${a.column}`} className='grid gap-1 text-[12px]'>
                <span className='font-mono text-[var(--tm-fg)]'>
                  {a.table}.{a.column}{' '}
                  <span className='font-sans text-[var(--tm-muted)]'>
                    · {a.rows.toLocaleString()} rows
                  </span>
                </span>
                <span className='text-[var(--tm-fg-2)]'>{a.reasons.join('; ')}</span>
                <div className='flex items-center gap-2'>
                  <code className='min-w-0 truncate font-mono text-[11px] text-[var(--tm-fg-2)]'>
                    {a.create_sql}
                  </code>
                  <CopyButton text={a.create_sql} label='Copy' hook='create-index' />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title='Routes that ran it' hook='routes'>
        {d.routes.length === 0 ? (
          <p className='text-[12px] text-[var(--tm-muted)]'>No route recorded.</p>
        ) : (
          <ul className='grid gap-0.5 text-[12px]' data-tm-inspect-statement-routes=''>
            {d.routes.map((r) => (
              <li key={r.route} className='flex min-w-0 items-center gap-2'>
                {r.entity ? (
                  <InspectLink
                    inspectRef={{ kind: 'entity', id: r.entity }}
                    className='font-mono text-[11.5px]'
                  >
                    {r.route}
                  </InspectLink>
                ) : (
                  <span className='min-w-0 truncate font-mono text-[11.5px] text-[var(--tm-fg-2)]'>
                    {r.route}
                  </span>
                )}
                <span className='ml-auto shrink-0 tabular-nums text-[var(--tm-muted)]'>
                  {r.n} {r.n === 1 ? 'trace' : 'traces'} · {fmtClock(r.last_seen)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
