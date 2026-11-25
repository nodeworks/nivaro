import { QueryErrorState } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, formatDateTime } from '@/lib/utils'
import { type FleetRow, fetchUptime, fleetKeys, pct } from './fleet-api'

/**
 * One environment's uptime: an hourly strip (green = every probe answered, amber = some did not,
 * red = none did), the recent failed probes and the stored monthly SLO rows.
 */
export function UptimeSheet({ row, onClose }: { row: FleetRow | null; onClose: () => void }) {
  const [days, setDays] = useState('7')
  const envId = row?.environment_id ?? 0
  const q = useQuery({
    queryKey: fleetKeys.uptime(envId, Number(days)),
    queryFn: () => fetchUptime(envId, Number(days)),
    enabled: row != null
  })
  return (
    <Sheet open={row != null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side='right' className='w-full overflow-y-auto sm:max-w-[560px]'>
        <SheetHeader>
          <SheetTitle>{row ? `${row.app_name} / ${row.env_key}` : 'Uptime'}</SheetTitle>
          <SheetDescription>
            One probe a minute of the public /api/version and /api/ready. Target{' '}
            {row?.slo.target ?? '—'} % a month.
          </SheetDescription>
        </SheetHeader>
        <div className='mt-4 space-y-5'>
          <SimpleSelect
            value={days}
            onChange={setDays}
            ariaLabel='Window'
            className='h-8 w-[140px] text-[12px]'
            options={[
              { value: '1', label: 'Last 24 hours' },
              { value: '7', label: 'Last 7 days' },
              { value: '30', label: 'Last 30 days' }
            ]}
          />
          {q.isPending ? (
            <Skeleton className='h-16 w-full' />
          ) : q.isError ? (
            <QueryErrorState error={q.error} what='the uptime' onRetry={() => void q.refetch()} />
          ) : (
            <>
              <section>
                <h4 className='m-0 mb-2 text-[12px] font-semibold text-slate-700 dark:text-foreground'>
                  Hour by hour
                </h4>
                {q.data.hours.length === 0 ? (
                  <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
                    No probes in this window.
                  </p>
                ) : (
                  <div className='flex h-10 items-end gap-px' role='img' aria-label='Hourly uptime'>
                    {q.data.hours.map((h) => {
                      const share = h.samples ? h.up / h.samples : 0
                      return (
                        <span
                          key={h.at}
                          data-tip={`${formatDateTime(h.at)} — ${h.up}/${h.samples} answered${h.ms != null ? `, ${h.ms} ms` : ''}`}
                          className={cn(
                            'h-full min-w-[2px] flex-1 rounded-[1px]',
                            share === 1
                              ? 'bg-emerald-500'
                              : share === 0
                                ? 'bg-red-500'
                                : 'bg-amber-500'
                          )}
                        />
                      )
                    })}
                  </div>
                )}
              </section>
              <section>
                <h4 className='m-0 mb-2 text-[12px] font-semibold text-slate-700 dark:text-foreground'>
                  Recent failed probes
                </h4>
                {q.data.incidents.length === 0 ? (
                  <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>None.</p>
                ) : (
                  <ul className='m-0 list-none space-y-1 p-0 text-[12px]'>
                    {[...q.data.incidents]
                      .reverse()
                      .slice(0, 20)
                      .map((i) => (
                        <li key={i.at} className='flex gap-3'>
                          <span className='tabular-nums text-slate-500 dark:text-muted-foreground'>
                            {formatDateTime(i.at)}
                          </span>
                          <code className='font-mono text-red-700 dark:text-red-300'>
                            {i.code ?? 'DOWN'}
                          </code>
                        </li>
                      ))}
                  </ul>
                )}
              </section>
              <section>
                <h4 className='m-0 mb-2 text-[12px] font-semibold text-slate-700 dark:text-foreground'>
                  Monthly reports
                </h4>
                {q.data.reports.length === 0 ? (
                  <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
                    The first report is made on the 1st of next month.
                  </p>
                ) : (
                  <table className='w-full text-[12px]'>
                    <tbody>
                      {q.data.reports.map((r) => (
                        <tr
                          key={r.month}
                          className='border-b border-slate-100 last:border-0 dark:border-border'
                        >
                          <td className='py-1 pr-3 tabular-nums'>{r.month}</td>
                          <td className='py-1 pr-3 tabular-nums'>{pct(r.uptime)}</td>
                          <td className='py-1 pr-3 text-slate-500 dark:text-muted-foreground'>
                            target {r.target} %
                          </td>
                          <td
                            className={cn(
                              'py-1',
                              r.met
                                ? 'text-emerald-700 dark:text-emerald-300'
                                : 'text-red-700 dark:text-red-300'
                            )}
                          >
                            {r.met == null ? '' : r.met ? 'Met' : 'Missed'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
