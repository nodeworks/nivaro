import { useBackgroundArm, useLiveFade, useLiveJobs, useSettledRows } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { HubToolbar } from '@/components/hub-page'
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

// `bar`: the 3 px edge each entry carries — the chips above are the legend, so rows never
// repeat a type badge (it ate half the row and cut names to ~9 characters, rt3 review).
const KIND_META: Record<string, { label: string; cls: string; bar: string }> = {
  cron: {
    label: 'Cron',
    cls: 'bg-slate-500/10 text-slate-600 dark:text-slate-300',
    bar: 'bg-slate-400 dark:bg-slate-500'
  },
  scheduled_change: {
    label: 'Change',
    cls: 'bg-nvr-cyan/15 text-nvr-navy dark:text-nvr-cyan',
    bar: 'bg-nvr-cyan'
  },
  report: {
    label: 'Report',
    cls: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
    bar: 'bg-violet-500'
  },
  retention: {
    label: 'Retention',
    cls: 'bg-red-500/10 text-red-600 dark:text-red-400',
    bar: 'bg-red-500'
  },
  blackout: {
    label: 'Blackout',
    cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
    bar: 'bg-amber-500'
  },
  ooo: {
    label: 'OOO',
    cls: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
    bar: 'bg-orange-500'
  },
  announcement: {
    label: 'Broadcast',
    cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    bar: 'bg-emerald-500'
  }
}

/** Entries a day shows before "+N more". */
const DAY_LIMIT = 10

const DAY = 86_400_000

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

export default function OpsCalendar() {
  const [offsetDays, setOffsetDays] = useState(0)
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set())
  const [openDays, setOpenDays] = useState<Set<string>>(new Set())
  const from = startOfDay(new Date(Date.now() + offsetDays * DAY))
  const to = new Date(from.getTime() + 7 * DAY)

  // A run finishing re-reads the week once per quiet window (what ran, what is next); the
  // slow poll is the net for schedules edited elsewhere.
  const live = useLiveJobs({ keys: [['ops-calendar']] })
  const { data, isLoading, dataUpdatedAt } = useQuery<{ events: OpsEvent[] }>({
    queryKey: ['ops-calendar', from.toISOString()],
    queryFn: () =>
      api
        .get('/ops-calendar', { params: { from: from.toISOString(), to: to.toISOString() } })
        .then((r) => r.data.data),
    staleTime: 60_000,
    refetchInterval: live ? 5 * 60_000 : 60_000
  })
  // Entries never shift under the pointer (a re-read waits for the person to move on); the
  // changed ones fade in.
  const weekKey = from.toISOString()
  const settled = useSettledRows(data?.events, (e) => `${e.kind}|${e.label}|${e.at}`, {
    resetKey: weekKey
  })
  const departed = useMemo(
    () => new Set(settled.rows.filter((r) => r.state === 'departed').map((r) => r.key)),
    [settled.rows]
  )
  const fadeRef = useLiveFade(useBackgroundArm(dataUpdatedAt, weekKey))
  const gridRef = useCallback(
    (el: HTMLElement | null) => {
      settled.containerRef(el)
      fadeRef(el)
    },
    [settled.containerRef, fadeRef]
  )

  // `from` is a new Date each render but derived from offsetDays: its time value is the key.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const days = useMemo(() => {
    const out: Array<{ date: Date; events: OpsEvent[] }> = []
    for (let i = 0; i < 7; i++) {
      out.push({ date: new Date(from.getTime() + i * DAY), events: [] })
    }
    for (const { row: e } of settled.rows) {
      if (hiddenKinds.has(e.kind)) continue
      const idx = Math.floor((new Date(e.at).getTime() - from.getTime()) / DAY)
      if (idx >= 0 && idx < 7) out[idx].events.push(e)
    }
    return out
  }, [settled.rows, hiddenKinds, weekKey])

  const kindCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of data?.events ?? []) m.set(e.kind, (m.get(e.kind) ?? 0) + 1)
    return m
  }, [data])

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar
        description='Everything scheduled on this instance — crons, changes, reports, retention, blackouts, OOO, broadcasts.'
        actions={
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
                'h-8 whitespace-nowrap rounded-md border px-3 text-[12.5px] font-medium',
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
        }
      >
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
      </HubToolbar>

      <div className='flex-1 overflow-y-auto p-4 sm:p-6' ref={gridRef}>
        {isLoading ? (
          <p className='px-2 py-8 text-[13px] text-slate-400'>Loading schedule…</p>
        ) : (
          <div className='grid grid-cols-1 gap-3 lg:grid-cols-7'>
            {days.map((d) => {
              const isToday = startOfDay(new Date()).getTime() === startOfDay(d.date).getTime()
              const dayKey = d.date.toISOString()
              const showAll = openDays.has(dayKey) || d.events.length <= DAY_LIMIT + 1
              const shown = showAll ? d.events : d.events.slice(0, DAY_LIMIT)
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
                    {d.date.toLocaleDateString(undefined, {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric'
                    })}
                    {isToday && (
                      <span className='ml-1.5 text-[10px] font-medium uppercase'>today</span>
                    )}
                  </div>
                  <div
                    className={cn(
                      'space-y-1 p-2',
                      // Collapsed days end on "+N more" (never cut by a scroll box); an opened day scrolls.
                      openDays.has(dayKey) && 'max-h-[560px] overflow-y-auto'
                    )}
                  >
                    {d.events.length === 0 && (
                      <p className='px-1 py-2 text-[11px] text-slate-300 dark:text-slate-600'>—</p>
                    )}
                    {shown.map((e, i) => {
                      const meta = KIND_META[e.kind] ?? KIND_META.cron
                      const time = new Date(e.at).toLocaleTimeString([], {
                        hour: 'numeric',
                        minute: '2-digit'
                      })
                      const key = `${e.kind}-${e.label}-${e.at}-${i}`
                      const gone = departed.has(`${e.kind}|${e.label}|${e.at}`)
                      const tip = [`${meta.label} · ${e.label}`, e.detail, gone ? 'Moved' : null]
                        .filter(Boolean)
                        .join(' — ')
                      const body = (
                        <>
                          <span
                            className={cn('w-[3px] shrink-0 self-stretch rounded-full', meta.bar)}
                            aria-hidden
                          />
                          <span className='sr-only'>{meta.label}: </span>
                          <span className='min-w-0 flex-1 text-[11.5px] leading-snug text-slate-700 [overflow-wrap:anywhere] dark:text-slate-200'>
                            {e.label}
                          </span>
                          <span className='shrink-0 pt-px text-[10.5px] tabular-nums text-slate-500 dark:text-slate-400'>
                            {time}
                          </span>
                        </>
                      )
                      const row = cn(
                        'relative flex items-start gap-1.5 rounded-md px-1.5 py-1',
                        gone && 'opacity-50'
                      )
                      return e.link ? (
                        <Link
                          key={key}
                          to={e.link}
                          className={cn(
                            row,
                            'hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-muted/50'
                          )}
                          data-tip={tip}
                        >
                          {body}
                        </Link>
                      ) : (
                        <div key={key} className={row} data-tip={tip}>
                          {body}
                        </div>
                      )
                    })}
                    {d.events.length > shown.length && (
                      <button
                        type='button'
                        onClick={() => setOpenDays((prev) => new Set(prev).add(dayKey))}
                        className='w-full rounded-md px-1.5 py-1 text-left text-[11.5px] font-medium text-nvr-navy hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-nvr-cyan dark:hover:bg-muted/50'
                      >
                        +{d.events.length - shown.length} more
                      </button>
                    )}
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
