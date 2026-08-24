import { useQuery } from '@tanstack/react-query'
import {
  CheckSquare,
  FileEdit,
  GitBranch,
  History,
  MessageSquare,
  Paperclip,
  Zap
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Record timeline (#325 design pass): a real vertical timeline — event icons
 * sitting on the connector, day groups with counts, author initials, and
 * type filter chips. Data unchanged (GET /timeline/:collection/:item).
 */

interface TimelineEvent {
  id: string
  type: 'activity' | 'revision' | 'workflow' | 'comment' | 'task' | 'addendum'
  timestamp: string
  user: { id: string; name: string } | null
  title: string
  detail: string | null
}

const TYPE_META: Record<
  TimelineEvent['type'],
  { icon: typeof History; color: string; label: string }
> = {
  revision: { icon: FileEdit, color: '#00ceff', label: 'Changes' },
  workflow: { icon: GitBranch, color: '#8b5cf6', label: 'Workflow' },
  comment: { icon: MessageSquare, color: '#f59e0b', label: 'Comments' },
  task: { icon: CheckSquare, color: '#10b981', label: 'Tasks' },
  addendum: { icon: Paperclip, color: '#ec4899', label: 'Addendums' },
  activity: { icon: Zap, color: '#64748b', label: 'Activity' }
}

function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('')
}

export function TimelineSheet({
  collection,
  item,
  open,
  onOpenChange
}: {
  collection: string
  item: string
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const [hidden, setHidden] = useState<Set<TimelineEvent['type']>>(new Set())
  const { data: events = [], isLoading } = useQuery({
    queryKey: ['timeline', collection, item],
    queryFn: () =>
      api
        .get<{ data: TimelineEvent[] }>(`/timeline/${collection}/${item}`)
        .then((r) => r.data.data),
    enabled: open,
    staleTime: 15_000
  })

  const presentTypes = useMemo(
    () => [...new Set(events.map((e) => e.type))] as TimelineEvent['type'][],
    [events]
  )
  const visible = events.filter((e) => !hidden.has(e.type))
  const byDay = new Map<string, TimelineEvent[]>()
  for (const e of visible) {
    const k = dayKey(e.timestamp)
    const list = byDay.get(k) ?? []
    list.push(e)
    byDay.set(k, list)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className='w-[460px] overflow-y-auto sm:max-w-[460px]'>
        <SheetHeader>
          <SheetTitle className='flex items-center gap-2 text-[15px]'>
            <History className='h-4 w-4 text-nvr-cyan' /> Timeline
          </SheetTitle>
        </SheetHeader>

        {presentTypes.length > 1 && (
          <div className='mt-3 flex flex-wrap gap-1.5'>
            {presentTypes.map((t) => {
              const meta = TYPE_META[t]
              const off = hidden.has(t)
              return (
                <button
                  key={t}
                  type='button'
                  onClick={() =>
                    setHidden((prev) => {
                      const next = new Set(prev)
                      if (next.has(t)) next.delete(t)
                      else next.add(t)
                      return next
                    })
                  }
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors',
                    off
                      ? 'border-slate-200 text-slate-400 opacity-60 dark:border-border'
                      : 'border-transparent'
                  )}
                  style={off ? undefined : { background: `${meta.color}1a`, color: meta.color }}
                >
                  <span
                    className='h-1.5 w-1.5 rounded-full'
                    style={{ background: off ? '#cbd5e1' : meta.color }}
                  />
                  {meta.label}
                </button>
              )
            })}
          </div>
        )}

        {isLoading ? (
          <div className='mt-6 space-y-3'>
            {[...Array(6)].map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
              <Skeleton key={i} className='h-10 w-full rounded-lg' />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <p className='mt-8 text-center text-[13px] text-slate-400'>
            {events.length === 0
              ? 'No history for this record.'
              : 'Everything is filtered out — turn a type back on above.'}
          </p>
        ) : (
          <div className='mt-5 space-y-6'>
            {[...byDay.entries()].map(([day, list]) => (
              <div key={day}>
                <div className='sticky top-0 z-10 mb-2 flex items-baseline justify-between bg-background py-1'>
                  <p className='text-[11px] font-semibold uppercase tracking-wide text-slate-400'>
                    {day}
                  </p>
                  <span className='text-[10.5px] tabular-nums text-slate-300 dark:text-slate-500'>
                    {list.length} event{list.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className='relative ml-3 space-y-4 border-l-2 border-slate-100 pl-6 dark:border-border/70'>
                  {list.map((e) => {
                    const meta = TYPE_META[e.type]
                    const Icon = meta.icon
                    return (
                      <div key={e.id} className='nvr-rise-in relative'>
                        <span
                          className='absolute -left-[37px] top-0 flex h-6 w-6 items-center justify-center rounded-full ring-4 ring-white dark:ring-background'
                          style={{ background: `${meta.color}1f` }}
                        >
                          <Icon className='h-3 w-3' style={{ color: meta.color }} />
                        </span>
                        <div className='flex items-baseline justify-between gap-2'>
                          <p
                            className={cn(
                              'text-[12.5px] font-medium leading-snug text-slate-800 dark:text-slate-200',
                              e.type === 'activity' && 'font-mono text-[11.5px]'
                            )}
                          >
                            {e.title}
                          </p>
                          <span
                            className='shrink-0 text-[10.5px] text-slate-400'
                            data-tip={new Date(e.timestamp).toLocaleString()}
                          >
                            {formatRelative(e.timestamp)}
                          </span>
                        </div>
                        {e.detail && (
                          <p className='mt-0.5 break-words text-[11.5px] leading-snug text-slate-500 dark:text-muted-foreground'>
                            {e.detail}
                          </p>
                        )}
                        {e.user?.name && (
                          <p className='mt-1 flex items-center gap-1.5 text-[10.5px] text-slate-400'>
                            <span className='flex h-4 w-4 items-center justify-center rounded-full bg-[#00ceff33] text-[8.5px] font-semibold text-[#0e7490] dark:text-[#67e8f9]'>
                              {initials(e.user.name)}
                            </span>
                            {e.user.name}
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
