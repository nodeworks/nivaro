import {
  LIVE_MODE_HINTS,
  LIVE_MODE_LABELS,
  LIVE_MODES,
  parseLiveMode,
  toastError
} from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Realtime round 3 #24 — the role's Live updates default: what people with this role get until
 * they choose for themselves in Profile → Display. Normal = no default stored.
 */
export function RoleLiveDefault({ roleId }: { roleId: string }) {
  const qc = useQueryClient()
  const { data: map } = useQuery({
    queryKey: ['live-preference-roles'],
    queryFn: () =>
      api.get<{ data: Record<string, string> }>('/live-preference/roles').then((r) => r.data.data),
    staleTime: 30_000
  })
  const current = parseLiveMode(map?.[roleId.toUpperCase()]) ?? 'normal'
  const save = useMutation({
    mutationFn: (mode: string) =>
      api.put(`/live-preference/roles/${roleId}`, { mode: mode === 'normal' ? null : mode }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['live-preference-roles'] })
      void qc.invalidateQueries({ queryKey: ['live-preference-default'] })
    },
    onError: (e) => toastError(e, 'Could not save the live updates default')
  })
  const shown = save.isPending && save.variables ? parseLiveMode(save.variables) : current
  return (
    <div
      data-role-live-default
      className='mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'
    >
      <div className='min-w-0'>
        <p className='text-[13px] font-medium text-slate-800 dark:text-slate-100'>Live updates</p>
        <p className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
          The default for this role. People can choose their own in Profile → Display.{' '}
          {LIVE_MODE_HINTS[shown ?? 'normal']}
        </p>
      </div>
      <fieldset
        aria-label='Live updates default'
        className='m-0 inline-flex shrink-0 rounded-md border border-slate-200 bg-slate-50 p-0.5 dark:border-border dark:bg-white/[0.03]'
      >
        {LIVE_MODES.map((m) => {
          const on = shown === m
          return (
            <button
              key={m}
              type='button'
              aria-pressed={on}
              data-live-default={m}
              disabled={save.isPending}
              onClick={() => {
                if (!on) save.mutate(m)
              }}
              className={cn(
                'h-7 rounded px-3 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                on
                  ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200 dark:bg-white/[0.14] dark:text-white dark:ring-white/15'
                  : 'text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
              )}
            >
              {LIVE_MODE_LABELS[m]}
            </button>
          )
        })}
      </fieldset>
    </div>
  )
}
