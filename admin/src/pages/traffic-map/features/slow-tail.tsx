/**
 * #1121 — slow-tail drill: the slow requests this API process kept for the entity (the trace
 * ring, over the slow threshold), slowest first. Each opens its heaviest statements with the
 * existing Plan / explain button.
 */
import { useState } from 'react'
import { StatementList, type Trace } from '@/components/slow-traces'
import { useTrafficMap } from '../context'
import { fmtMs, fmtTime } from '../EventTicker'
import { Empty, type InspectorData, Section } from '../Inspector'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import type { Selection } from '../types'
import { entityOf, useEntityDetail } from './shared'

function SlowTailPanel({ sel, d }: { sel: Selection; d: InspectorData }) {
  const { win } = useTrafficMap()
  const e = entityOf(sel)
  const { data, loading } = useEntityDetail<{ traces?: Trace[] }>(e?.key ?? null, 'slow-tail', win)
  const [open, setOpen] = useState<string | null>(null)
  const traces = data?.traces ?? []
  return (
    <Section title={`Slow tail · p95 ${fmtMs(d.p95)}`}>
      {loading ? (
        <Empty>Reading kept traces…</Empty>
      ) : traces.length === 0 ? (
        <Empty>No request on this entity went over the slow threshold on this node.</Empty>
      ) : (
        <ul className='grid gap-1 text-[12px]' data-tm-slow-tail=''>
          {traces.map((t) => {
            const isOpen = open === t.id
            return (
              <li key={t.id} data-tm-slow-trace={t.id}>
                <button
                  type='button'
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : t.id)}
                  className='grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-2 rounded-sm text-left hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                >
                  <span className='font-mono text-[10.5px] tabular-nums text-[var(--tm-muted)]'>
                    {fmtTime(t.ts)}
                  </span>
                  <span className='min-w-0 truncate font-mono text-[11px]' title={t.url}>
                    {t.method} {t.route}
                  </span>
                  <span className='tabular-nums'>
                    <span className='font-medium'>{fmtMs(t.total_ms)}</span>
                    {t.sql_ms ? (
                      <span className='text-[var(--tm-muted)]'> · {fmtMs(t.sql_ms)} SQL</span>
                    ) : null}
                  </span>
                </button>
                {isOpen && (
                  <div className='mt-1 pl-2'>
                    {t.slowest_phase && (
                      <p className='text-[11.5px] text-[var(--tm-fg-2)]'>
                        Slowest phase: <span className='font-mono'>{t.slowest_phase}</span>
                      </p>
                    )}
                    {(t.top_sql ?? []).length ? (
                      <StatementList trace={t} />
                    ) : (
                      <Empty>No SQL was recorded for this request.</Empty>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}

register(inspectorPanels, {
  id: 'slow-tail',
  order: 40,
  applies: (sel) => {
    const e = entityOf(sel)
    return !!e && !e.entity.startsWith('__')
  },
  Component: SlowTailPanel
})
