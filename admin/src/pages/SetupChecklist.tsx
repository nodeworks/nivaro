import { useQuery } from '@tanstack/react-query'
import { Check, Circle, Rocket } from 'lucide-react'
import { Link } from 'react-router'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/** Instance setup checklist (#34) — live done/not-done detection, no state
 *  to drift: each check reads what's actually configured. */

interface SetupCheck {
  id: string
  label: string
  done: boolean
  detail: string
  link: string
  optional?: boolean
}

export default function SetupChecklist() {
  const { data } = useQuery<{ checks: SetupCheck[]; done: number; total: number }>({
    queryKey: ['setup-status'],
    queryFn: () => api.get('/setup/status').then((r) => r.data.data),
    refetchInterval: 30_000
  })
  const pct = data ? Math.round((data.done / data.total) * 100) : 0

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-3'>
          <Rocket className='h-5 w-5 text-muted-foreground' />
          <div className='flex-1'>
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
              Setup Checklist
            </h1>
            <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Get this instance production-ready. Every check reads live configuration — finish
              one and it ticks itself.
            </p>
          </div>
          {data && (
            <div className='text-right'>
              <p className='text-[22px] font-bold tabular-nums text-slate-900 dark:text-foreground'>
                {data.done}/{data.total}
              </p>
              <p className='text-[11px] text-slate-400'>{pct}% complete</p>
            </div>
          )}
        </div>
        {data && (
          <div className='mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-muted'>
            <div
              className='h-full rounded-full bg-nvr-cyan transition-all duration-500'
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </header>

      <div className='flex-1 space-y-2 overflow-y-auto p-6'>
        {(data?.checks ?? []).map((c) => (
          <Link
            key={c.id}
            to={c.link}
            className={cn(
              'flex max-w-[720px] items-start gap-3 rounded-lg border bg-white px-4 py-3 transition-colors hover:border-slate-300 dark:bg-card dark:hover:border-slate-600',
              c.done ? 'border-slate-200 dark:border-border' : 'border-amber-200 dark:border-amber-500/30'
            )}
          >
            {c.done ? (
              <span className='mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-500/15'>
                <Check className='h-3 w-3 text-emerald-600 dark:text-emerald-400' strokeWidth={3} />
              </span>
            ) : (
              <Circle className='mt-0.5 h-5 w-5 shrink-0 text-slate-300 dark:text-slate-600' />
            )}
            <div className='min-w-0 flex-1'>
              <p
                className={cn(
                  'text-[13.5px] font-medium',
                  c.done
                    ? 'text-slate-500 line-through decoration-slate-300 dark:text-muted-foreground'
                    : 'text-slate-800 dark:text-foreground'
                )}
              >
                {c.label}
                {c.optional && (
                  <span className='ml-2 rounded-full bg-slate-100 px-1.5 py-px text-[10px] font-normal uppercase text-slate-400 no-underline dark:bg-muted'>
                    optional
                  </span>
                )}
              </p>
              <p className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>{c.detail}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
