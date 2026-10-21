import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, X } from 'lucide-react'
import { useApiFetchConfig, useNavigation } from '../../context'
import { cn } from '../../lib/utils'

/**
 * The first-week checklist an admin published for the person's role (#2472),
 * shown at the top of My Work for their first two weeks. Steps tick
 * themselves; the card hides when there is nothing to show.
 */

interface Step {
  id: string
  title: string
  detail: string | null
  kind: 'open' | 'video' | 'record'
  path: string | null
  done: boolean
}

interface FirstWeek {
  active: boolean
  role_name: string | null
  ends_at: string | null
  steps: Step[]
  done_count: number
}

export function FirstWeekCard({ onOpenPath }: { onOpenPath?: (path: string) => void }) {
  const { apiBase, authHeaders, credentials } = useApiFetchConfig()
  const nav = useNavigation()
  const qc = useQueryClient()
  const key = ['my-work-first-week']
  const q = useQuery<FirstWeek>({
    queryKey: key,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await fetch(`${apiBase}/my-work/first-week`, {
        headers: authHeaders,
        credentials
      })
      if (!res.ok) throw new Error('first-week failed')
      return ((await res.json()) as { data: FirstWeek }).data
    }
  })
  const post = (path: string, body?: unknown) =>
    fetch(`${apiBase}/my-work/first-week/${path}`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      credentials,
      body: JSON.stringify(body ?? {})
    })
  const dismiss = useMutation({
    mutationFn: () => post('dismiss'),
    onSuccess: () => qc.setQueryData(key, { active: false, steps: [], done_count: 0 })
  })
  const d = q.data
  if (!d?.active || !d.steps.length) return null

  const go = (s: Step) => {
    if (!s.path) return
    // Opening the link is what ticks an "open" step.
    if (s.kind === 'open')
      void post('opened', { step_id: s.id }).then(() => qc.invalidateQueries({ queryKey: key }))
    if (onOpenPath) onOpenPath(s.path)
    else nav.navigate(s.path)
  }
  const left = d.ends_at
    ? Math.max(0, Math.ceil((new Date(d.ends_at).getTime() - Date.now()) / 86_400_000))
    : null
  const total = d.steps.length
  const allDone = d.done_count >= total
  return (
    <section
      aria-label='Your first week'
      data-first-week
      className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
    >
      <div className='flex flex-wrap items-center gap-2'>
        <h2 className='text-[13px] font-semibold'>
          {allDone ? 'First week done' : 'Your first week'}
          {d.role_name && (
            <span className='font-normal text-muted-foreground'> · {d.role_name}</span>
          )}
        </h2>
        <span className='text-[11.5px] text-muted-foreground tabular-nums'>
          {d.done_count} of {total}
          {left !== null && !allDone && ` · ${left} day${left === 1 ? '' : 's'} left`}
        </span>
        <button
          type='button'
          onClick={() => dismiss.mutate()}
          aria-label='Hide the first-week checklist'
          data-tip='Hide this for good'
          className='ml-auto rounded p-1 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </div>
      <div
        className='mt-2 h-1 overflow-hidden rounded-full bg-slate-100 dark:bg-muted'
        role='progressbar'
        aria-label='First-week steps done'
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={d.done_count}
      >
        <div
          className='h-full rounded-full bg-nvr-cyan transition-[width] duration-300'
          style={{ width: `${(d.done_count / total) * 100}%` }}
        />
      </div>
      <ul className='mt-3 grid gap-1 md:grid-cols-2'>
        {d.steps.map((s) => (
          <li key={s.id}>
            <button
              type='button'
              onClick={() => go(s)}
              disabled={!s.path}
              className='flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-default disabled:hover:bg-transparent'
            >
              <span
                aria-hidden
                className={cn(
                  'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                  s.done
                    ? 'border-nvr-cyan bg-nvr-cyan text-white'
                    : 'border-slate-300 dark:border-slate-600'
                )}
              >
                {s.done && <Check className='h-3 w-3' />}
              </span>
              <span className='min-w-0'>
                <span
                  className={cn(
                    'block text-[12.5px]',
                    s.done && 'text-muted-foreground line-through'
                  )}
                >
                  {s.title}
                  <span className='sr-only'>{s.done ? ' (done)' : ' (to do)'}</span>
                </span>
                {s.detail && !s.done && (
                  <span className='block text-[11.5px] text-muted-foreground'>{s.detail}</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
