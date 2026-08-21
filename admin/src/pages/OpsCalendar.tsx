import { useQuery } from '@tanstack/react-query'
import { CalendarClock, ChevronLeft, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Ops calendar (#6): everything time-scheduled on this instance in one
 * agenda — cron jobs, scheduled changes, scheduled reports, retention runs,
 * blackout dates, OOO windows, broadcast banner windows.
 */

interface OpsEvent {
  kind: string
  label: string
  at: string
  end?: string | null
  link?: string | null
  detail?: string | null
}

const KIND_META: Record<string, { label: string; cls: string }> = {
  cron: { label: 'Cron', cls: 'bg-slate-500/10 text-slate-600 dark:text-slate-300' },
  scheduled_change: { label: 'Change', cls: 'bg-nvr-cyan/15 text-nvr-navy dark:text-nvr-cyan' },
  report: { label: 'Report', cls: 'bg-violet-500/10 text-violet-600 dark:text-violet-400' },
  retention: { label: 'Retention', cls: 'bg-red-500/10 text-red-600 dark:text-red-400' },
  blackout: { label: 'Blackout', cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' },
  ooo: { label: 'OOO', cls: 'bg-orange-500/10 text-orange-600 dark:text-orange-400' },
  announcement: { label: 'Broadcast', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' }
}

const DAY = 86_400_000

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

export default function OpsCalendar() {
  const [offsetDays, setOffsetDays] = useState(0)
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set())
  const from = startOfDay(new Date(Date.now() + offsetDays * DAY))
  const to = new Date(from.getTime() + 7 * DAY)

  const { data, isLoading } = useQuery<{ events: OpsEvent[] }>({
    queryKey: ['ops-calendar', from.toISOString()],
    queryFn: () =>
      api
        .get('/ops-calendar', { params: { from: from.toISOString(), to: to.toISOString() } })
        .then((r) => r.data.data),
    staleTime: 60_000
  })

  const days = useMemo(() => {
    const out: Array<{ date: Date; events: OpsEvent[] }> = []
    for (let i = 0; i < 7; i++) {
      out.push({ date: new Date(from.getTime() + i * DAY), events: [] })
    }
    for (const e of data?.events ?? []) {
      if (hiddenKinds.has(e.kind)) continue
      const idx = Math.floor((new Date(e.at).getTime() - from.getTime()) / DAY)
      if (idx >= 0 && idx < 7) out[idx].events.push(e)
    }
    return out
    // biome-ignore lint/correctness/useExhaustiveDependencies: from is derived from offsetDays
  }, [data, hiddenKinds, offsetDays])

  const kindCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of data?.events ?? []) m.set(e.kind, (m.get(e.kind) ?? 0) + 1)
    return m
  }, [data])

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex flex-wrap items-center gap-3'>
          <CalendarClock className='h-5 w-5 text-muted-foreground' />
          <div className='min-w-0 flex-1'>
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
              Ops Calendar
            </h1>
            <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Everything scheduled on this instance — crons, changes, reports, retention,
              blackouts, OOO, broadcasts.
            </p>
          </div>
          <div className='flex items-center gap-1.5'>
            <button
              type='button'
              onClick={() => setOffsetDays((d) => d - 7)}
              className='flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-border dark:hover:bg-muted'
              aria-label='Previous week'
            >
              <ChevronLeft className='h-4 w-4' />
            </button>
            <button
              type='button'
              onClick={() => setOffsetDays(0)}
              className={cn(
                'h-8 rounded-md border px-3 text-[12.5px] font-medium',
                offsetDays === 0
                  ? 'border-nvr-cyan/50 bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                  : 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-border dark:hover:bg-muted'
              )}
            >
              This week
            </button>
            <button
              type='button'
              onClick={() => setOffsetDays((d) => d + 7)}
              className='flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-border dark:hover:bg-muted'
              aria-label='Next week'
            >
              <ChevronRight className='h-4 w-4' />
            </button>
          </div>
        </div>
        <div className='mt-3 flex flex-wrap gap-1.5'>
          {Object.entries(KIND_META).map(([kind, meta]) => (
            <button
              key={kind}
              type='button'
              onClick={() =>
                setHiddenKinds((prev) => {
                  const next = new Set(prev)
                  if (next.has(kind)) next.delete(kind)
                  else next.add(kind)
                  return next
                })
              }
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-opacity',
                meta.cls,
                hiddenKinds.has(kind) && 'opacity-30'
              )}
            >
              {meta.label}
              <span className='tabular-nums opacity-70'>{kindCounts.get(kind) ?? 0}</span>
            </button>
          ))}
        </div>
      </header>

      <div className='flex-1 overflow-y-auto p-4'>
        {isLoading ? (
          <p className='px-2 py-8 text-[13px] text-slate-400'>Loading schedule…</p>
        ) : (
          <div className='grid grid-cols-1 gap-3 lg:grid-cols-7'>
            {days.map((d) => {
              const isToday = startOfDay(new Date()).getTime() === startOfDay(d.date).getTime()
              return (
                <div
                  key={d.date.toISOString()}
                  className={cn(
                    'rounded-lg border bg-white dark:bg-card',
                    isToday ? 'border-nvr-cyan/50' : 'border-slate-200 dark:border-border'
                  )}
                >
                  <div
                    className={cn(
                      'border-b px-3 py-2 text-[12px] font-semibold',
                      isToday
                        ? 'border-nvr-cyan/30 text-nvr-navy dark:text-nvr-cyan'
                        : 'border-slate-100 text-slate-600 dark:border-border/60 dark:text-slate-300'
                    )}
                  >
                    {d.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                    {isToday && <span className='ml-1.5 text-[10px] font-medium uppercase'>today</span>}
                  </div>
                  <div className='max-h-[440px] space-y-1 overflow-y-auto p-2'>
                    {d.events.length === 0 && (
                      <p className='px-1 py-2 text-[11px] text-slate-300 dark:text-slate-600'>—</p>
                    )}
                    {d.events.map((e, i) => {
                      const meta = KIND_META[e.kind] ?? KIND_META.cron
                      const time = new Date(e.at).toLocaleTimeString([], {
                        hour: 'numeric',
                        minute: '2-digit'
                      })
                      const body = (
                        <>
                          <span className={cn('rounded px-1 py-px text-[9.5px] font-semibold uppercase', meta.cls)}>
                            {meta.label}
                          </span>
                          <span className='min-w-0 flex-1 truncate text-[11.5px] text-slate-700 dark:text-slate-200'>
                            {e.label}
                          </span>
                          <span className='shrink-0 text-[10.5px] tabular-nums text-slate-400'>{time}</span>
                        </>
                      )
                      const key = `${e.kind}-${e.label}-${e.at}-${i}`
                      return e.link ? (
                        <Link
                          key={key}
                          to={e.link}
                          className='flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-slate-50 dark:hover:bg-muted/50'
                          data-tip={e.detail ?? undefined}
                        >
                          {body}
                        </Link>
                      ) : (
                        <div key={key} className='flex items-center gap-1.5 rounded-md px-1.5 py-1' data-tip={e.detail ?? undefined}>
                          {body}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
