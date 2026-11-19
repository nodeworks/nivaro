import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatNumber, formatRelative } from '@/lib/utils'

/**
 * Missed live updates (realtime idea 14). After a reload, screens compare field hashes with what
 * they showed before it; a field that changed with no live event heard is a missed update. This
 * tab shows the daily aggregates: where updates go missing, why (delivery vs a write that never
 * announced), and how many reloads found nothing different at all.
 */

type Source = 'delivery' | 'procedure' | 'raw' | 'unknown'

interface MissedReport {
  available: boolean
  days: number
  reloads_compared: number
  clean_reloads: number
  stale_reloads: number
  misses: number
  by_source: Record<Source, number>
  lines: Array<{
    collection: string
    field: string
    source: Source
    writer: string
    hits: number
    gap_s_max: number
    gap_s_avg: number
    routes: string[]
    sample_item: string | null
    last_at: string | null
  }>
  daily: Array<{ day: string; clean: number; stale: number; misses: number }>
}

const SOURCE: Record<Source, { label: string; hint: string; tone: string }> = {
  delivery: {
    label: 'Not delivered',
    hint: 'The change was logged or broadcast, but this tab never got the event',
    tone: 'bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/30'
  },
  procedure: {
    label: 'Procedure, no announce',
    hint: 'A stored procedure or trigger writes this field and never calls nivaro_announce_writes',
    tone: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30'
  },
  raw: {
    label: 'Direct write',
    hint: 'Nothing logged or broadcast, and no procedure found that writes this field',
    tone: 'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-muted dark:text-muted-foreground dark:ring-border'
  },
  unknown: {
    label: 'Not checked',
    hint: 'The server could not look this one up (busy, or not SQL Server)',
    tone: 'bg-slate-100 text-slate-500 ring-slate-200 dark:bg-muted dark:text-muted-foreground dark:ring-border'
  }
}

function duration(s: number): string {
  if (s < 90) return `${s}s`
  if (s < 5400) return `${Math.round(s / 60)} min`
  return `${Math.round(s / 3600)} h`
}

export function MissedUpdatesTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['realtime-missed-updates', 7],
    queryFn: () =>
      api
        .get<{ data: MissedReport }>('/realtime/missed-updates', { params: { days: 7 } })
        .then((r) => r.data.data)
  })
  if (isLoading || !data)
    return (
      <div className='space-y-3'>
        <Skeleton className='h-20 w-full' />
        <Skeleton className='h-48 w-full' />
      </div>
    )
  if (!data.available)
    return (
      <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        Missed-update tracking starts once this database has migration 530.
      </p>
    )
  const trustPct =
    data.reloads_compared > 0
      ? Math.round((data.clean_reloads / data.reloads_compared) * 100)
      : null
  return (
    <div className='space-y-6' data-missed-updates='ready'>
      <p className='max-w-3xl text-[12px] leading-relaxed text-slate-500 dark:text-muted-foreground'>
        After someone reloads a record or list, the page checks whether what it showed before the
        reload was out of date. Only field names and record ids reach the server, never values. Last{' '}
        {data.days} days.
      </p>

      <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-4 dark:border-border dark:bg-border'>
        <Cell label='Reloads checked' value={data.reloads_compared.toLocaleString()} />
        <Cell
          label='Nothing had changed'
          value={trustPct == null ? '—' : `${trustPct}%`}
          note={`${data.clean_reloads.toLocaleString()} reloads`}
        />
        <Cell
          label='Showed something stale'
          value={data.stale_reloads.toLocaleString()}
          tone={data.stale_reloads > 0 ? 'text-amber-700 dark:text-amber-300' : undefined}
        />
        <Cell
          label='Missed field updates'
          value={data.misses.toLocaleString()}
          note={(['procedure', 'delivery', 'raw'] as Source[])
            .filter((s) => data.by_source[s] > 0)
            .map((s) => `${data.by_source[s]} ${SOURCE[s].label.toLowerCase()}`)
            .join(' · ')}
        />
      </div>

      <section>
        <h2 className='mb-2 text-[13px] font-semibold text-slate-800 dark:text-foreground'>
          Where updates go missing
        </h2>
        {data.lines.length === 0 ? (
          <p className='rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-[12.5px] text-slate-500 dark:border-border dark:text-muted-foreground'>
            {data.reloads_compared > 0
              ? 'No missed updates — every checked reload showed current data.'
              : 'No reloads checked yet. Numbers appear as people reload records and lists.'}
          </p>
        ) : (
          <div className='overflow-x-auto rounded-lg border border-slate-200 dark:border-border'>
            <table className='w-full text-[12px] tabular-nums'>
              <thead>
                <tr className='border-b border-slate-200 bg-slate-50 text-left text-[11px] font-semibold text-slate-500 dark:border-border dark:bg-muted/40 dark:text-muted-foreground'>
                  <th className='px-3 py-2'>Field</th>
                  <th className='px-3 py-2'>Why</th>
                  <th className='px-3 py-2 text-right'>Missed</th>
                  <th className='px-3 py-2 text-right'>Stale for (avg · max)</th>
                  <th className='px-3 py-2'>Pages</th>
                  <th className='px-3 py-2'>Latest</th>
                </tr>
              </thead>
              <tbody className='divide-y divide-slate-100 dark:divide-border/60'>
                {data.lines.map((l) => (
                  <tr key={`${l.collection}.${l.field}.${l.source}.${l.writer}`}>
                    <td className='px-3 py-1.5 font-mono text-[11.5px] text-slate-800 dark:text-foreground'>
                      {l.collection}.{l.field}
                    </td>
                    <td className='px-3 py-1.5'>
                      <span
                        data-tip={SOURCE[l.source].hint}
                        className={cn(
                          'inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset',
                          SOURCE[l.source].tone
                        )}
                      >
                        {SOURCE[l.source].label}
                      </span>
                      {l.writer && l.source === 'procedure' && (
                        <span className='ml-2 font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
                          {l.writer}
                        </span>
                      )}
                    </td>
                    <td className='px-3 py-1.5 text-right font-medium text-slate-800 dark:text-foreground'>
                      {l.hits.toLocaleString()}
                    </td>
                    <td className='px-3 py-1.5 text-right text-slate-600 dark:text-muted-foreground'>
                      {duration(l.gap_s_avg)} · {duration(l.gap_s_max)}
                    </td>
                    <td className='max-w-[260px] truncate px-3 py-1.5 font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
                      {l.routes.join(', ')}
                    </td>
                    <td className='whitespace-nowrap px-3 py-1.5 text-slate-500 dark:text-muted-foreground'>
                      {l.sample_item ? (
                        <Link
                          to={`/collections/${l.collection}/${encodeURIComponent(l.sample_item)}`}
                          className='text-nvr-cyan hover:underline'
                        >
                          #{l.sample_item}
                        </Link>
                      ) : null}
                      {l.last_at ? <span className='ml-2'>{formatRelative(l.last_at)}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.by_source.procedure > 0 && (
          <p className='mt-2 max-w-3xl text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            A procedure that writes records can tell open pages by calling{' '}
            <span className='font-mono'>EXEC nivaro_announce_writes @Collection, @Ids</span> after
            its update.
          </p>
        )}
      </section>

      {data.daily.length > 0 && (
        <section>
          <h2 className='mb-2 text-[13px] font-semibold text-slate-800 dark:text-foreground'>
            By day
          </h2>
          <div className='overflow-x-auto rounded-lg border border-slate-200 dark:border-border'>
            <table className='w-full text-[12px] tabular-nums'>
              <thead>
                <tr className='border-b border-slate-200 bg-slate-50 text-left text-[11px] font-semibold text-slate-500 dark:border-border dark:bg-muted/40 dark:text-muted-foreground'>
                  <th className='px-3 py-2'>Day (UTC)</th>
                  <th className='px-3 py-2 text-right'>Nothing changed</th>
                  <th className='px-3 py-2 text-right'>Showed something stale</th>
                  <th className='px-3 py-2 text-right'>Missed field updates</th>
                </tr>
              </thead>
              <tbody className='divide-y divide-slate-100 dark:divide-border/60'>
                {data.daily.map((d) => (
                  <tr key={d.day}>
                    <td className='px-3 py-1.5 text-slate-700 dark:text-foreground'>{d.day}</td>
                    <td className='px-3 py-1.5 text-right'>{formatNumber(d.clean)}</td>
                    <td className='px-3 py-1.5 text-right'>{formatNumber(d.stale)}</td>
                    <td className='px-3 py-1.5 text-right'>{formatNumber(d.misses)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

function Cell({
  label,
  value,
  note,
  tone
}: {
  label: string
  value: string
  note?: string
  tone?: string
}) {
  return (
    <div className='bg-white px-4 py-3 dark:bg-card'>
      <p className='text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>{label}</p>
      <p
        className={cn(
          'mt-0.5 text-[18px] font-semibold tabular-nums text-slate-900 dark:text-foreground',
          tone
        )}
      >
        {value}
      </p>
      {note ? (
        <p className='mt-0.5 truncate text-[11px] text-slate-400 dark:text-muted-foreground'>
          {note}
        </p>
      ) : null}
    </div>
  )
}
