import { useContext, useEffect, useMemo, useState } from 'react'
import { RechartsGate } from '../charts/RechartsGate'
import { COLOR_ROLES } from '../QueryTable'
import { Skeleton } from '../ui/skeleton'
import type { DaCell, DaSummary } from './types'
import { DrillContext } from './ui'
import { bucketLabel, fmtInt } from './url'

const readDark = () =>
  typeof document !== 'undefined' && document.documentElement.classList.contains('dark')

function useIsDark(): boolean {
  const [dark, setDark] = useState(readDark)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const obs = new MutationObserver(() => setDark(readDark()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  return dark
}

const role = (name: keyof typeof COLOR_ROLES, dark: boolean) =>
  (COLOR_ROLES[name] as [string, string])[dark ? 1 : 0]

interface Series {
  key: string
  label: string
  color: string
  /** The drill behind one bar segment, by bucket index. */
  cells: DaCell[]
  drillLabel: (bucket: string) => string
}

/**
 * Stacked bars per hour / day. Every segment opens its rows; the legend
 * names the parts so colour is never the only key.
 */
export function TrendBars({
  summary,
  kind,
  height = 168
}: {
  summary: DaSummary
  kind: 'notifications' | 'email'
  height?: number
}) {
  const dark = useIsDark()
  const open = useContext(DrillContext)
  const bucket = summary.window.bucket
  const series: Series[] = useMemo(() => {
    const s = summary.series
    if (kind === 'notifications')
      return [
        {
          key: 'read',
          label: 'Read',
          color: 'rgb(var(--nvr-cyan-rgb))',
          cells: s.map((b) => b.read),
          drillLabel: (k) => `Read · ${bucketLabel(k, bucket)}`
        },
        {
          key: 'unread',
          label: 'Not read',
          color: dark ? 'rgb(var(--nvr-cyan-rgb) / 0.32)' : 'rgb(var(--nvr-cyan-rgb) / 0.3)',
          // Unread = sent minus read: the read dimension splits every row in two.
          cells: s.map((b) => ({
            n: b.sent.n - b.read.n,
            s: 'n' as const,
            w: [...b.sent.w, ['read', ['unread']] as [string, string[]]]
          })),
          drillLabel: (k) => `Not read · ${bucketLabel(k, bucket)}`
        }
      ]
    return [
      {
        key: 'delivered',
        label: 'Sent',
        color: role('info', dark),
        cells: s.map((b) => b.email_delivered),
        drillLabel: (k) => `Emails sent · ${bucketLabel(k, bucket)}`
      },
      {
        key: 'failed',
        label: 'Failed',
        color: role('negative', dark),
        cells: s.map((b) => b.email_failed),
        drillLabel: (k) => `Emails failed · ${bucketLabel(k, bucket)}`
      }
    ]
  }, [summary.series, kind, dark, bucket])
  const data = useMemo(
    () =>
      summary.series.map((b, i) => ({
        bucket: b.bucket,
        label: bucketLabel(b.bucket, bucket),
        ...Object.fromEntries(series.map((s) => [s.key, s.cells[i]?.n ?? 0]))
      })),
    [summary.series, series, bucket]
  )
  const empty = data.every((d) => series.every((s) => (d as Record<string, unknown>)[s.key] === 0))
  const axis = dark ? '#94a3b8' : '#64748b'
  return (
    <div>
      <ul className='mb-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-slate-600 dark:text-muted-foreground'>
        {series.map((s) => (
          <li key={s.key} className='inline-flex items-center gap-1.5'>
            <span className='h-2 w-2 rounded-sm' style={{ background: s.color }} aria-hidden />
            {s.label}
            <span className='tabular-nums text-slate-400 dark:text-muted-foreground/70'>
              {fmtInt(s.cells.reduce((t, c) => t + c.n, 0))}
            </span>
          </li>
        ))}
      </ul>
      {empty ? (
        <p
          className='flex items-center justify-center text-[12px] text-slate-500 dark:text-muted-foreground'
          style={{ height }}
        >
          {kind === 'notifications'
            ? 'No notifications in this window.'
            : 'No email in this window.'}
        </p>
      ) : (
        <div style={{ height }} role='img' aria-label={`${kind} per ${bucket}`}>
          <RechartsGate fallback={<Skeleton className='h-full w-full' aria-busy='true' />}>
            {(r) => (
              <r.ResponsiveContainer width='100%' height='100%'>
                <r.BarChart
                  data={data}
                  margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
                  barCategoryGap='18%'
                >
                  <r.CartesianGrid vertical={false} stroke={dark ? '#1e293b' : '#eef2f6'} />
                  <r.XAxis
                    dataKey='label'
                    tick={{ fontSize: 10.5, fill: axis }}
                    tickLine={false}
                    axisLine={false}
                    interval='preserveStartEnd'
                    minTickGap={18}
                  />
                  <r.YAxis
                    tick={{ fontSize: 10.5, fill: axis }}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                    width={44}
                  />
                  <r.Tooltip
                    cursor={{ fill: dark ? 'rgba(148,163,184,0.08)' : 'rgba(15,23,42,0.04)' }}
                    contentStyle={{
                      fontSize: 12,
                      borderRadius: 6,
                      border: `1px solid ${dark ? '#334155' : '#e2e8f0'}`,
                      background: dark ? '#0f172a' : '#ffffff',
                      color: dark ? '#e2e8f0' : '#0f172a'
                    }}
                    formatter={(v: unknown, name: unknown) => [
                      fmtInt(Number(v)),
                      series.find((s) => s.key === name)?.label ?? String(name)
                    ]}
                  />
                  {series.map((s, si) => (
                    <r.Bar
                      key={s.key}
                      dataKey={s.key}
                      stackId='a'
                      fill={s.color}
                      radius={si === series.length - 1 ? [2, 2, 0, 0] : 0}
                      cursor={open ? 'pointer' : 'default'}
                      isAnimationActive={false}
                      onClick={(_: unknown, index: number) => {
                        const c = s.cells[index]
                        const b = summary.series[index]
                        if (open && c && c.n > 0 && b) open(c, s.drillLabel(b.bucket))
                      }}
                    />
                  ))}
                </r.BarChart>
              </r.ResponsiveContainer>
            )}
          </RechartsGate>
        </div>
      )}
    </div>
  )
}
