import { useMemo, useState } from 'react'
import type { OpsReportListRow } from '../../lib/ops-report-types'
import { OPS_KPI_META } from '../../lib/ops-report-types'
import { cn } from '../../lib/utils'
import {
  formatKpi,
  goodClass,
  kpiMeta,
  NO_VERDICT_DOT,
  num,
  shortDay,
  VERDICT,
  weekday
} from './format'
import { Pick } from './ui'

function label(r: OpsReportListRow): string {
  return `${weekday(r.day)} ${shortDay(r.day)}${r.verdict ? ` · ${VERDICT[r.verdict].label}` : ''}${
    r.score != null ? ` · ${r.score}` : ''
  }`
}

function Headline({ r }: { r: OpsReportListRow | undefined }) {
  if (!r) return <div />
  return (
    <div className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'>
      <div className='flex items-center gap-2 text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
        <span
          aria-hidden
          className={cn(
            'h-2.5 w-2.5 rounded-full',
            r.verdict ? VERDICT[r.verdict].dot : NO_VERDICT_DOT
          )}
        />
        {weekday(r.day)} {shortDay(r.day)}
        {r.score != null && (
          <span className='ml-auto tabular-nums text-slate-500 dark:text-muted-foreground'>
            {r.score}
          </span>
        )}
      </div>
      <p className='mt-1 text-[12px] leading-snug text-slate-600 dark:text-muted-foreground'>
        {r.headline ?? 'No write-up for this day.'}
      </p>
    </div>
  )
}

/** Two days, every number side by side. Colour follows the good direction, never raw up/down. */
export function CompareTab({ rows }: { rows: OpsReportListRow[] }) {
  const [a, setA] = useState<string>(() => String(rows[1]?.id ?? rows[0]?.id ?? ''))
  const [b, setB] = useState<string>(() => String(rows[0]?.id ?? ''))
  const options = useMemo(() => rows.map((r) => ({ value: String(r.id), label: label(r) })), [rows])
  const ra = rows.find((r) => String(r.id) === a)
  const rb = rows.find((r) => String(r.id) === b)
  const keys = useMemo(() => {
    const present = new Set<string>()
    for (const r of [ra, rb])
      for (const [k, v] of Object.entries(r?.kpis ?? {})) if (v != null) present.add(k)
    const known = OPS_KPI_META.map((m) => m.key).filter((k) => present.has(k))
    const extra = [...present].filter((k) => !OPS_KPI_META.some((m) => m.key === k)).sort()
    return [...known, ...extra]
  }, [ra, rb])

  if (rows.length < 2)
    return (
      <p className='flex-1 p-10 text-center text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        Compare needs at least two days of reports.
      </p>
    )

  return (
    <div
      className='min-h-0 flex-1 overflow-y-auto bg-slate-50 p-4 dark:bg-background'
      data-ops-compare=''
    >
      <div className='mx-auto max-w-[1000px] space-y-3'>
        <div className='flex flex-wrap items-center gap-2'>
          <Pick
            ariaLabel='First day'
            value={a}
            onChange={setA}
            options={options}
            className='w-[260px]'
          />
          <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>against</span>
          <Pick
            ariaLabel='Second day'
            value={b}
            onChange={setB}
            options={options}
            className='w-[260px]'
          />
        </div>
        <div className='grid gap-3 sm:grid-cols-2'>
          <Headline r={ra} />
          <Headline r={rb} />
        </div>
        <div className='overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
          <table className='w-full text-[12px]'>
            <thead>
              <tr className='border-b border-slate-200 text-[10.5px] uppercase tracking-wide text-slate-500 dark:border-border dark:text-muted-foreground'>
                <th className='px-3 py-1.5 text-left font-medium'>Number</th>
                <th className='px-3 py-1.5 text-right font-medium'>{ra ? shortDay(ra.day) : ''}</th>
                <th className='px-3 py-1.5 text-right font-medium'>{rb ? shortDay(rb.day) : ''}</th>
                <th className='px-3 py-1.5 text-right font-medium'>Difference</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const m = kpiMeta(k)
                const x = ra?.kpis?.[k]
                const y = rb?.kpis?.[k]
                const diff = x != null && y != null ? y - x : null
                const good =
                  diff == null || diff === 0 || m.better == null
                    ? null
                    : m.better === 'down'
                      ? diff < 0
                      : diff > 0
                const pct = diff != null && x ? (diff / x) * 100 : null
                return (
                  <tr
                    key={k}
                    data-ops-compare-row={k}
                    className='border-b border-slate-100 last:border-0 dark:border-border/60'
                  >
                    <td className='px-3 py-1 text-slate-700 dark:text-foreground'>{m.label}</td>
                    <td className='px-3 py-1 text-right tabular-nums'>{formatKpi(x, m.unit)}</td>
                    <td className='px-3 py-1 text-right tabular-nums'>{formatKpi(y, m.unit)}</td>
                    <td className={cn('px-3 py-1 text-right tabular-nums', goodClass(good))}>
                      {diff == null
                        ? '–'
                        : diff === 0
                          ? 'same'
                          : `${diff > 0 ? '+' : '−'}${formatKpi(Math.abs(diff), m.unit)}${
                              pct != null
                                ? ` (${diff > 0 ? '+' : '−'}${num(Math.abs(pct), Math.abs(pct) < 10 ? 1 : 0)}%)`
                                : ''
                            }`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
