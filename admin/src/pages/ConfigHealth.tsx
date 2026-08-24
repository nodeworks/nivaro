import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Config Health — the nightly sweep over configuration itself: usage hygiene
 * (queues nobody opens, reports nobody views, flows that never fire, config
 * owned by suspended users, empty layouts) and schema lint (missing display
 * templates, corrupt relations, unhidden junctions). Findings link to the
 * surface that fixes them; dismiss what's intentional.
 */

interface Finding {
  id: number
  family: 'hygiene' | 'lint'
  code: string
  subject: string
  title: string
  detail: string | null
  severity: 'info' | 'warning'
  href: string | null
  status: 'open' | 'dismissed'
  first_seen: string
  last_seen: string
}

const CODE_LABEL: Record<string, string> = {
  'queue-unopened': 'Unopened queues',
  'report-unviewed': 'Unviewed reports',
  'flow-never-fires': 'Dormant flows',
  'view-suspended-owner': 'Orphaned saved views',
  'template-suspended-owner': 'Orphaned templates',
  'layout-empty': 'Empty layouts',
  'relation-missing-table': 'Relations to missing tables',
  'relation-one-field-id': 'Corrupt relations',
  'missing-display-template': 'Missing display templates',
  'junction-not-hidden': 'Unhidden junctions'
}

export default function ConfigHealth() {
  const qc = useQueryClient()
  const [family, setFamily] = useState<'' | 'hygiene' | 'lint'>('')
  const [showDismissed, setShowDismissed] = useState(false)
  const [codeFilter, setCodeFilter] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['config-health', family, showDismissed],
    queryFn: () =>
      api
        .get('/config-health', {
          params: { family: family || undefined, include_dismissed: showDismissed || undefined }
        })
        .then((r) => r.data)
  })
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['config-health'] })

  const run = useMutation({
    mutationFn: () => api.post('/config-health/run'),
    onSuccess: (r) => {
      toast.success(`Sweep complete — ${r.data.data.outcome}`)
      invalidate()
    },
    onError: () => toast.error('Sweep failed')
  })
  // One-click junction registration (#119): the finding's fix.
  const fixJunction = useMutation({
    mutationFn: (table: string) =>
      api
        .post<{ data: { registered: boolean; alias: string; alias_on: string } }>(
          '/config-health/fix-junction',
          { table }
        )
        .then((r) => r.data.data),
    onSuccess: (d) => {
      toast.success(`Registered — alias "${d.alias}" added on ${d.alias_on}`)
      void qc.invalidateQueries({ queryKey: ['config-health'] })
    },
    onError: (e: unknown) =>
      toast.error(
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Registration failed'
      )
  })
  const dismiss = useMutation({
    mutationFn: (id: number) => api.post(`/config-health/${id}/dismiss`),
    onSuccess: invalidate
  })

  const rows: Finding[] = (data?.data ?? []).filter(
    (f: Finding) => !codeFilter || f.code === codeFilter
  )
  const all: Finding[] = data?.data ?? []
  const byCode = new Map<string, number>()
  for (const f of all) byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1)
  const warnings = all.filter((f) => f.severity === 'warning' && f.status === 'open').length

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2.5'>
            <Sparkles className='h-5 w-5 text-muted-foreground' />
            <div>
              <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
                Config Health
              </h1>
              <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
                Configuration nobody uses and configuration that breaks its own conventions — swept
                nightly, each finding linking to the surface that fixes it.
              </p>
            </div>
          </div>
          <button
            type='button'
            disabled={run.isPending}
            onClick={() => run.mutate()}
            className='h-8 rounded-md bg-nvr-cyan px-4 text-[12.5px] font-medium text-white disabled:opacity-50'
          >
            {run.isPending ? 'Sweeping…' : 'Run sweep now'}
          </button>
        </div>
      </header>

      <div className='flex-1 space-y-3 overflow-y-auto p-6'>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='flex rounded-md border border-slate-200 p-0.5 dark:border-border'>
            {(
              [
                { value: '', label: 'All' },
                { value: 'hygiene', label: 'Usage hygiene' },
                { value: 'lint', label: 'Schema lint' }
              ] as const
            ).map((t) => (
              <button
                key={t.value}
                type='button'
                onClick={() => {
                  setFamily(t.value)
                  setCodeFilter(null)
                }}
                className={cn(
                  'rounded px-2.5 py-1 text-[12px] font-medium',
                  family === t.value
                    ? 'bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                    : 'text-slate-400 hover:text-slate-600'
                )}
              >
                {t.label}
              </button>
            ))}
          </span>
          {warnings > 0 && (
            <span className='rounded-full bg-amber-500/10 px-2.5 py-0.5 text-[11.5px] font-medium text-amber-700 dark:text-amber-400'>
              {warnings} warning{warnings === 1 ? '' : 's'}
            </span>
          )}
          <label className='ml-auto flex cursor-pointer items-center gap-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
            <input
              type='checkbox'
              checked={showDismissed}
              onChange={(e) => setShowDismissed(e.target.checked)}
              className='h-3.5 w-3.5'
            />
            Show dismissed
          </label>
        </div>

        <div className='flex flex-wrap gap-1.5'>
          {[...byCode.entries()]
            .sort((a, z) => z[1] - a[1])
            .map(([code, count]) => (
              <button
                key={code}
                type='button'
                onClick={() => setCodeFilter(codeFilter === code ? null : code)}
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-[11.5px]',
                  codeFilter === code
                    ? 'border-nvr-cyan/50 bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                    : 'border-slate-200 text-slate-500 hover:text-slate-700 dark:border-border dark:text-muted-foreground'
                )}
              >
                {CODE_LABEL[code] ?? code} <span className='font-medium'>{count}</span>
              </button>
            ))}
        </div>

        {isLoading && <p className='text-[12px] text-slate-400'>Loading…</p>}
        {!isLoading && rows.length === 0 && (
          <div className='rounded-lg border border-dashed border-slate-300 p-8 text-center dark:border-border'>
            <p className='text-[13px] font-medium text-emerald-600 dark:text-emerald-400'>
              {all.length === 0
                ? 'No findings — run the sweep to check.'
                : 'Nothing matches this filter.'}
            </p>
          </div>
        )}
        <div className='space-y-1.5'>
          {rows.map((f) => (
            <div
              key={f.id}
              className={cn(
                'flex items-start gap-3 rounded-lg border bg-white px-4 py-2.5 dark:bg-card',
                f.severity === 'warning' && f.status === 'open'
                  ? 'border-amber-200 dark:border-amber-500/30'
                  : 'border-slate-200 dark:border-border',
                f.status === 'dismissed' && 'opacity-50'
              )}
            >
              <span
                className={cn(
                  'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                  f.severity === 'warning' ? 'bg-amber-500' : 'bg-slate-300'
                )}
              />
              <div className='min-w-0 flex-1'>
                <p className='text-[12.5px] text-slate-800 dark:text-foreground'>
                  {f.href ? (
                    <Link to={f.href} className='underline decoration-dotted underline-offset-2 hover:text-nvr-cyan'>
                      {f.title}
                    </Link>
                  ) : (
                    f.title
                  )}
                </p>
                {f.detail && <p className='mt-0.5 text-[11.5px] text-slate-400'>{f.detail}</p>}
                <p className='mt-0.5 text-[10.5px] text-slate-300 dark:text-slate-500'>
                  first seen {new Date(f.first_seen).toLocaleDateString()}
                </p>
              </div>
              {f.code === 'junction-unregistered' && f.status === 'open' && (
                <button
                  type='button'
                  disabled={fixJunction.isPending}
                  onClick={() => fixJunction.mutate(f.subject.replace(/^table:/, ''))}
                  className='shrink-0 rounded-md border border-[#00ceff66] bg-[#00ceff0d] px-2 py-1 text-[11.5px] font-medium text-[#007a99] disabled:opacity-50 dark:text-nvr-cyan'
                >
                  {fixJunction.isPending ? 'Registering…' : 'Register junction'}
                </button>
              )}
              <button
                type='button'
                onClick={() => dismiss.mutate(f.id)}
                className='shrink-0 text-[11.5px] text-slate-400 underline decoration-dotted underline-offset-2 hover:text-slate-600'
              >
                {f.status === 'dismissed' ? 'Reopen' : 'Dismiss'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
