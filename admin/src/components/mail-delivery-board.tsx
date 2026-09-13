import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Inbox } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Mail delivery board (#9): the outbound log rolled up over a window — sent /
 * failed / dropped / deferred per day, per template (with the mail type's
 * label), the busiest recipients, addresses whose latest attempt failed, and
 * SMTP errors grouped by their stable head. Read-only over GET /mail-log/stats;
 * clicking a template row narrows the log tab to it.
 */

interface StatusCounts {
  sent: number
  failed: number
  dropped: number
  deferred: number
}
interface MailStats {
  days: number
  totals: StatusCounts & { total: number; success_rate: number | null }
  series: Array<{ day: string } & StatusCounts>
  by_template: Array<
    {
      template: string
      label: string | null
      total: number
      failure_rate: number | null
      last_failure_at: string | null
      last_error: string | null
    } & StatusCounts
  >
  top_recipients: Array<{ email: string; total: number; failed: number }>
  failures: Array<{ error: string; count: number; last_at: string; recipients: string[] }>
  bounces: Array<{ email: string; failures: number; last_error: string | null; last_at: string }>
}

const STATUS_COLOR: Record<keyof StatusCounts, string> = {
  sent: '#00ceff',
  failed: '#dc2626',
  dropped: '#d97706',
  deferred: '#6366f1'
}

const num = (n: number) => n.toLocaleString()

export function MailDeliveryBoard({
  days,
  onOpenTemplate,
  onOpenStatus
}: {
  days: number
  onOpenTemplate: (template: string) => void
  onOpenStatus: (status: keyof StatusCounts) => void
}) {
  const { data, isLoading } = useQuery<{ data: MailStats }>({
    queryKey: ['mail-log-stats', days],
    queryFn: () => api.get('/mail-log/stats', { params: { days } }).then((r) => r.data),
    staleTime: 60_000
  })
  const s = data?.data

  if (isLoading || !s) {
    return (
      <div className='space-y-4'>
        <div className='h-[72px] animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]' />
        <div className='h-[220px] animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]' />
        <div className='h-[200px] animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]' />
      </div>
    )
  }

  if (s.totals.total === 0) {
    return (
      <div className='flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-200 py-16 text-center dark:border-border'>
        <Inbox className='h-6 w-6 text-slate-300' />
        <p className='mt-2 text-[13px] font-medium text-slate-600 dark:text-foreground'>
          Nothing sent in the last {days} days
        </p>
        <p className='mt-1 text-[12px] text-slate-400'>
          Every send attempt lands here the moment it happens — try a wider window.
        </p>
      </div>
    )
  }

  const chart = s.series.map((p) => ({
    ...p,
    label: new Date(`${p.day}T12:00:00Z`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric'
    })
  }))

  return (
    <div className='space-y-5'>
      {/* Stat strip */}
      <div className='grid grid-cols-5 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'>
        {(['sent', 'failed', 'dropped', 'deferred'] as const).map((k) => (
          <button
            key={k}
            type='button'
            onClick={() => onOpenStatus(k)}
            className='bg-white px-4 py-3 text-left hover:bg-slate-50 dark:bg-card dark:hover:bg-muted/40'
            title={`Open the log filtered to ${k}`}
          >
            <p className='flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
              <span
                className='inline-block h-2 w-2 rounded-full'
                style={{ backgroundColor: STATUS_COLOR[k] }}
              />
              {k}
            </p>
            <p className='mt-1 text-[20px] font-semibold tabular-nums text-slate-900 dark:text-foreground'>
              {num(s.totals[k])}
            </p>
          </button>
        ))}
        <div className='bg-white px-4 py-3 dark:bg-card'>
          <p className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
            Success rate
          </p>
          <p
            className={cn(
              'mt-1 text-[20px] font-semibold tabular-nums',
              s.totals.success_rate == null
                ? 'text-slate-400'
                : s.totals.success_rate >= 98
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : s.totals.success_rate >= 90
                    ? 'text-amber-700 dark:text-amber-400'
                    : 'text-red-700 dark:text-red-400'
            )}
          >
            {s.totals.success_rate == null ? '—' : `${s.totals.success_rate}%`}
          </p>
          <p className='text-[11px] text-slate-400'>sent ÷ (sent + failed)</p>
        </div>
      </div>

      {/* Per-day chart */}
      <section className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
        <div className='mb-2 flex items-baseline justify-between'>
          <h2 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>Per day</h2>
          <p className='text-[11px] text-slate-400'>{num(s.totals.total)} attempts in the window</p>
        </div>
        <ResponsiveContainer width='100%' height={200}>
          <BarChart data={chart} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray='3 3' stroke='rgba(148,163,184,0.25)' vertical={false} />
            <XAxis dataKey='label' tick={{ fontSize: 10.5 }} tickLine={false} axisLine={false} />
            <YAxis
              tick={{ fontSize: 10.5 }}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
            />
            <Tooltip
              cursor={{ fill: 'rgba(148,163,184,0.12)' }}
              contentStyle={{
                backgroundColor: '#0f172a',
                border: 'none',
                borderRadius: 6,
                fontSize: 12,
                color: '#f8fafc'
              }}
              labelStyle={{ color: '#cbd5e1' }}
              itemStyle={{ color: '#f8fafc' }}
            />
            <Bar dataKey='sent' stackId='a' fill={STATUS_COLOR.sent} />
            <Bar dataKey='failed' stackId='a' fill={STATUS_COLOR.failed} />
            <Bar dataKey='dropped' stackId='a' fill={STATUS_COLOR.dropped} />
            <Bar
              dataKey='deferred'
              stackId='a'
              fill={STATUS_COLOR.deferred}
              radius={[3, 3, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </section>

      {/* By template */}
      <section className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
        <div className='flex items-baseline justify-between border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
          <h2 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
            By template
          </h2>
          <p className='text-[11px] text-slate-400'>Click a row to open the log for it</p>
        </div>
        <table className='w-full text-[12px] tabular-nums'>
          <thead>
            <tr className='text-left text-[10.5px] uppercase tracking-wide text-slate-400'>
              <th className='px-4 py-2 font-semibold'>Template</th>
              <th className='px-3 py-2 text-right font-semibold'>Sent</th>
              <th className='px-3 py-2 text-right font-semibold'>Failed</th>
              <th className='px-3 py-2 text-right font-semibold'>Dropped</th>
              <th className='px-3 py-2 text-right font-semibold'>Deferred</th>
              <th className='px-3 py-2 text-right font-semibold'>Fail rate</th>
              <th className='px-4 py-2 font-semibold'>Last failure</th>
            </tr>
          </thead>
          <tbody className='divide-y divide-slate-50 dark:divide-border/40'>
            {s.by_template.map((t) => (
              <tr
                key={t.template}
                onClick={() => onOpenTemplate(t.template)}
                className='cursor-pointer hover:bg-slate-50 dark:hover:bg-muted/40'
              >
                <td className='px-4 py-2'>
                  <p className='font-medium text-slate-700 dark:text-foreground'>
                    {t.label ?? (t.template === '(untemplated)' ? 'Untemplated sends' : t.template)}
                  </p>
                  {t.label && (
                    <p className='font-mono text-[10.5px] text-slate-400'>{t.template}</p>
                  )}
                  {!t.label && t.template === '(untemplated)' && (
                    <p className='text-[10.5px] text-slate-400'>
                      raw sends from before templates were logged
                    </p>
                  )}
                </td>
                <td className='px-3 py-2 text-right text-slate-700 dark:text-foreground'>
                  {num(t.sent)}
                </td>
                <td
                  className={cn(
                    'px-3 py-2 text-right',
                    t.failed > 0 ? 'font-medium text-red-700 dark:text-red-400' : 'text-slate-400'
                  )}
                >
                  {num(t.failed)}
                </td>
                <td className='px-3 py-2 text-right text-slate-500'>{num(t.dropped)}</td>
                <td className='px-3 py-2 text-right text-slate-500'>{num(t.deferred)}</td>
                <td className='px-3 py-2 text-right text-slate-600 dark:text-muted-foreground'>
                  {t.failure_rate == null ? '—' : `${t.failure_rate}%`}
                </td>
                <td className='max-w-[320px] px-4 py-2 text-slate-500'>
                  {t.last_failure_at ? (
                    <span className='block truncate' title={t.last_error ?? undefined}>
                      <span className='text-slate-400'>{formatRelative(t.last_failure_at)}</span>
                      {t.last_error ? ` · ${t.last_error}` : ''}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className='grid grid-cols-2 gap-5'>
        {/* Top recipients */}
        <section className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
          <div className='border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
            <h2 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
              Busiest recipients
            </h2>
          </div>
          <table className='w-full text-[12px] tabular-nums'>
            <tbody className='divide-y divide-slate-50 dark:divide-border/40'>
              {s.top_recipients.map((r) => (
                <tr key={r.email}>
                  <td className='max-w-[260px] truncate px-4 py-1.5 text-slate-700 dark:text-foreground'>
                    {r.email}
                  </td>
                  <td className='px-3 py-1.5 text-right text-slate-600 dark:text-muted-foreground'>
                    {num(r.total)}
                  </td>
                  <td className='px-4 py-1.5 text-right'>
                    {r.failed > 0 ? (
                      <span className='text-red-700 dark:text-red-400'>{num(r.failed)} failed</span>
                    ) : (
                      <span className='text-slate-300 dark:text-slate-600'>—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Bounces */}
        <section className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
          <div className='border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
            <h2 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
              Not reaching
            </h2>
            <p className='text-[11px] text-slate-400'>
              Addresses whose latest attempt failed — check them before they miss an approval.
            </p>
          </div>
          {s.bounces.length === 0 ? (
            <p className='px-4 py-6 text-center text-[12px] text-slate-400'>
              Every address reached on its latest attempt.
            </p>
          ) : (
            <ul className='divide-y divide-slate-50 dark:divide-border/40'>
              {s.bounces.map((b) => (
                <li key={b.email} className='px-4 py-2'>
                  <div className='flex items-baseline justify-between gap-3'>
                    <span className='truncate text-[12px] font-medium text-slate-700 dark:text-foreground'>
                      {b.email}
                    </span>
                    <span className='shrink-0 text-[11px] text-slate-400'>
                      {b.failures} failed · {formatRelative(b.last_at)}
                    </span>
                  </div>
                  {b.last_error && (
                    <p
                      className='mt-0.5 truncate text-[11px] text-red-700/80 dark:text-red-400/80'
                      title={b.last_error}
                    >
                      {b.last_error}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Failure reasons */}
      <section className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
        <div className='border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
          <h2 className='flex items-center gap-1.5 text-[13px] font-semibold text-slate-800 dark:text-foreground'>
            <AlertTriangle className='h-3.5 w-3.5 text-amber-500' />
            Failure reasons
          </h2>
          <p className='text-[11px] text-slate-400'>
            SMTP errors grouped by their stable text — addresses and ids collapsed.
          </p>
        </div>
        {s.failures.length === 0 ? (
          <p className='px-4 py-6 text-center text-[12px] text-slate-400'>
            No failures in the window.
          </p>
        ) : (
          <ul className='divide-y divide-slate-50 dark:divide-border/40'>
            {s.failures.map((f) => (
              <li key={f.error} className='px-4 py-2.5'>
                <div className='flex items-baseline gap-3'>
                  <span className='w-12 shrink-0 text-right text-[13px] font-semibold tabular-nums text-slate-800 dark:text-foreground'>
                    {num(f.count)}
                  </span>
                  <div className='min-w-0 flex-1'>
                    <p className='font-mono text-[11.5px] text-slate-700 dark:text-foreground'>
                      {f.error}
                    </p>
                    <p className='mt-0.5 text-[11px] text-slate-400'>
                      last {formatRelative(f.last_at)}
                      {f.recipients.length > 0 ? ` · ${f.recipients.join(', ')}` : ''}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
