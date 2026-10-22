import { useQuery } from '@tanstack/react-query'
import { CalendarClock, EyeOff, Plus } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'
import type { ChaosRun } from './api'
import { GameDayDetail } from './GameDayDetail'
import {
  fetchGameday,
  fetchGamedays,
  fetchTemplate,
  fmtEastern,
  type GamedayPlan,
  gamedayKeys,
  planOf
} from './gameday-api'
import { PlanEditor } from './PlanEditor'
import { RunChip } from './RunsTab'

/**
 * Game days (#2816, #2852): planned exercises with roles and a timed list of injects. Left, the
 * calendar — running, then upcoming by date, then past; right, the selected day or the plan
 * editor. `?gameday=<id>` deep-links, `?gameday=new` opens a blank plan.
 */
export function GameDaysTab() {
  const [params, setParams] = useSearchParams()
  const selected = params.get('gameday')
  const editing = params.get('edit') === '1'
  const {
    data: days,
    isLoading,
    isError
  } = useQuery<ChaosRun[]>({
    queryKey: gamedayKeys.list,
    queryFn: fetchGamedays,
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running') ? 10_000 : 60_000)
  })
  const go = (id: string | null, edit = false) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p)
        if (id) next.set('gameday', id)
        else next.delete('gameday')
        if (edit) next.set('edit', '1')
        else next.delete('edit')
        return next
      },
      { replace: true }
    )

  const list = days ?? []
  const running = list.filter((r) => r.status === 'running')
  const upcoming = list
    .filter((r) => r.status === 'planned')
    .sort((a, b) => planOf(a).starts_at.localeCompare(planOf(b).starts_at))
  const past = list.filter((r) => !['running', 'planned'].includes(r.status))

  return (
    <div className='flex flex-1 min-h-0 overflow-hidden'>
      <aside
        aria-label='Game days'
        className='flex w-[288px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card'
      >
        <div className='shrink-0 border-b border-slate-100 p-3 dark:border-border/60'>
          <button
            type='button'
            onClick={() => go('new')}
            className='inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-medium text-white transition-colors duration-150 hover:bg-[#00b8e0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 dark:focus-visible:ring-offset-card'
          >
            <Plus className='h-3.5 w-3.5' aria-hidden /> Plan a game day
          </button>
        </div>
        <div className='flex-1 overflow-y-auto'>
          {isLoading ? (
            <div className='space-y-3 p-3'>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className='space-y-1.5'>
                  <Skeleton className='h-3.5 w-40' />
                  <Skeleton className='h-3 w-28' />
                </div>
              ))}
            </div>
          ) : isError ? (
            <p className='p-4 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              The game days did not load.
            </p>
          ) : list.length === 0 ? (
            <div className='p-4 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              <p className='font-medium text-slate-700 dark:text-foreground'>No game days yet</p>
              <p className='mt-1'>
                Plan one to practise a bad day on purpose: who leads, who takes notes, and which
                faults go in when.
              </p>
            </div>
          ) : (
            <>
              <Group title='Running now' days={running} selected={selected} onPick={go} />
              <Group title='Coming up' days={upcoming} selected={selected} onPick={go} />
              <Group title='Past' days={past} selected={selected} onPick={go} />
            </>
          )}
        </div>
      </aside>
      <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        {selected === 'new' ? (
          <NewPlan onDone={(id) => go(id)} />
        ) : selected && editing ? (
          <EditPlan id={selected} onDone={(id) => go(id)} />
        ) : selected ? (
          <GameDayDetail key={selected} id={selected} onEdit={() => go(selected, true)} />
        ) : (
          <div className='flex h-full flex-col items-center justify-center gap-2 p-8 text-center'>
            <CalendarClock className='h-5 w-5 text-slate-400' aria-hidden />
            <p className='max-w-[48ch] text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              {list.length
                ? 'Pick a game day on the left.'
                : 'A game day is a planned drill with roles and a timed list of faults. The monthly staging template is a good first one.'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function Group({
  title,
  days,
  selected,
  onPick
}: {
  title: string
  days: ChaosRun[]
  selected: string | null
  onPick: (id: string) => void
}) {
  if (!days.length) return null
  return (
    <section aria-label={title}>
      <h3 className='px-3 pt-3 pb-1 text-[11.5px] font-medium text-slate-500 dark:text-muted-foreground'>
        {title}
      </h3>
      <ul className='divide-y divide-slate-100 dark:divide-border/60'>
        {days.map((r) => {
          const plan = planOf(r)
          const on = r.id === selected
          return (
            <li key={r.id}>
              <button
                type='button'
                onClick={() => onPick(r.id)}
                aria-current={on ? 'true' : undefined}
                className={cn(
                  'block w-full px-3 py-2.5 text-left transition-colors duration-150 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan dark:hover:bg-muted',
                  on && 'bg-nvr-cyan/10 hover:bg-nvr-cyan/10 dark:bg-nvr-cyan/15'
                )}
              >
                <div className='flex items-center gap-2'>
                  {r.status === 'running' && (
                    <span className='relative flex h-2 w-2 shrink-0' aria-hidden>
                      <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75 motion-reduce:animate-none' />
                      <span className='relative inline-flex h-2 w-2 rounded-full bg-red-500' />
                    </span>
                  )}
                  <span className='min-w-0 flex-1 truncate text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
                    {plan.title}
                  </span>
                  {plan.blind && (
                    <EyeOff
                      className='h-3 w-3 shrink-0 text-slate-400'
                      aria-label='Blind'
                      data-tip='Blind'
                    />
                  )}
                  <RunChip run={r} />
                </div>
                <div className='mt-0.5 text-[11px] text-slate-500 tabular-nums dark:text-muted-foreground'>
                  {fmtEastern(r.started_at ?? plan.starts_at)}
                </div>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function blankPlan(lead: string): GamedayPlan {
  const at = new Date(Date.now() + 7 * 86_400_000)
  at.setUTCMinutes(0, 0, 0)
  return {
    title: '',
    starts_at: at.toISOString(),
    duration_min: 60,
    lead,
    scribe: null,
    responders: [],
    blind: false,
    auto_start: false,
    channel: true,
    reminders_min: [1440, 15],
    repeat: 'none',
    notes: '',
    injects: []
  }
}

function NewPlan({ onDone }: { onDone: (id: string | null) => void }) {
  const { user } = useAuth()
  const [base, setBase] = useState<GamedayPlan | null>(null)
  const [key, setKey] = useState(0)
  const template = useQuery({ queryKey: gamedayKeys.template, queryFn: fetchTemplate })
  const plan = base ?? blankPlan(String(user?.id ?? ''))
  return (
    <div>
      <div className='flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-6 py-3 text-[12.5px] dark:border-border dark:bg-card'>
        <span className='text-slate-600 dark:text-muted-foreground'>Start from</span>
        <button
          type='button'
          onClick={() => {
            setBase(null)
            setKey((k) => k + 1)
          }}
          className={cn(
            'rounded-md px-2.5 py-1 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
            !base
              ? 'bg-nvr-cyan/10 font-medium text-slate-900 dark:text-foreground'
              : 'text-slate-600 hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-muted'
          )}
        >
          A blank plan
        </button>
        <button
          type='button'
          disabled={!template.data}
          onClick={() => {
            if (!template.data) return
            setBase(template.data.plan)
            setKey((k) => k + 1)
          }}
          className={cn(
            'rounded-md px-2.5 py-1 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-40',
            base
              ? 'bg-nvr-cyan/10 font-medium text-slate-900 dark:text-foreground'
              : 'text-slate-600 hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-muted'
          )}
        >
          The monthly staging template
        </button>
        {base && template.data?.kill_task && (
          <span className='basis-full text-[11.5px] text-amber-800 dark:text-amber-300'>
            Kill a web task will be refused here: {template.data.kill_task}
          </span>
        )}
      </div>
      <PlanEditor key={key} initial={plan} onDone={onDone} />
    </div>
  )
}

function EditPlan({ id, onDone }: { id: string; onDone: (id: string | null) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: gamedayKeys.detail(id),
    queryFn: () => fetchGameday(id)
  })
  if (isLoading || !data)
    return (
      <div className='space-y-3 p-6'>
        <Skeleton className='h-5 w-48' />
        <Skeleton className='h-32 w-full' />
      </div>
    )
  if (data.run.status !== 'planned')
    return (
      <p className='p-6 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        Only a planned game day can be edited.
      </p>
    )
  return <PlanEditor initial={planOf(data.run)} id={id} onDone={onDone} />
}
