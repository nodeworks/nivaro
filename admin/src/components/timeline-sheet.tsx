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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

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
  revision: { icon: FileEdit, color: '#00ceff', label: 'Change' },
  workflow: { icon: GitBranch, color: '#8b5cf6', label: 'Workflow' },
  comment: { icon: MessageSquare, color: '#f59e0b', label: 'Comment' },
  task: { icon: CheckSquare, color: '#10b981', label: 'Task' },
  addendum: { icon: Paperclip, color: '#ec4899', label: 'Addendum' },
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
  const { data: events = [], isLoading } = useQuery({
    queryKey: ['timeline', collection, item],
    queryFn: () =>
      api
        .get<{ data: TimelineEvent[] }>(`/timeline/${collection}/${item}`)
        .then((r) => r.data.data),
    enabled: open,
    staleTime: 15_000
  })

  const byDay = new Map<string, TimelineEvent[]>()
  for (const e of events) {
    const k = dayKey(e.timestamp)
    const list = byDay.get(k) ?? []
    list.push(e)
    byDay.set(k, list)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className='w-[440px] overflow-y-auto sm:max-w-[440px]'>
        <SheetHeader>
          <SheetTitle className='flex items-center gap-2 text-[15px]'>
            <History className='h-4 w-4 text-nvr-cyan' /> Timeline
          </SheetTitle>
        </SheetHeader>

        {isLoading ? (
          <div className='mt-6 space-y-3'>
            {[...Array(6)].map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
              <Skeleton key={i} className='h-10 w-full rounded-lg' />
            ))}
          </div>
        ) : events.length === 0 ? (
          <p className='mt-8 text-center text-[13px] text-slate-400'>No history for this record.</p>
        ) : (
          <div className='mt-4 space-y-5'>
            {[...byDay.entries()].map(([day, list]) => (
              <div key={day}>
                <p className='sticky top-0 z-10 mb-2 bg-background py-1 text-[11px] font-semibold text-slate-400'>
                  {day}
                </p>
                <div className='relative ml-2 space-y-3 border-l border-slate-200 pl-5 dark:border-border'>
                  {list.map((e) => {
                    const meta = TYPE_META[e.type]
                    const Icon = meta.icon
                    return (
                      <div key={e.id} className='relative'>
                        <span
                          className='absolute -left-[27px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full'
                          style={{ background: `${meta.color}22` }}
                        >
                          <Icon className='h-2.5 w-2.5' style={{ color: meta.color }} />
                        </span>
                        <div className='flex items-baseline justify-between gap-2'>
                          <p
                            className={cn(
                              'text-[12.5px] font-medium text-slate-800 dark:text-slate-200',
                              e.type === 'activity' && 'font-mono text-[11.5px]'
                            )}
                          >
                            {e.title}
                          </p>
                          <span
                            className='shrink-0 text-[10.5px] text-slate-400'
                            title={new Date(e.timestamp).toLocaleString()}
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
                          <p className='mt-0.5 text-[10.5px] text-slate-400'>{e.user.name}</p>
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
