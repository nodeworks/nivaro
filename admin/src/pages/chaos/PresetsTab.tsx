import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, Search, Trash2 } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { type ChaosStatus, chaosKeys, errText, fetchStatus } from './api'
import { builderKeys, type ChaosPreset, deletePreset, fetchPresets } from './builder/api'
import { builderHref, formatSeconds, targetWords } from './builder/model'
import { CHAOS_TABS } from './tabs'

/**
 * Presets (#2855): saved scenarios and the shipped ones, each with what it proves and the claims
 * (#2830) it tests. Run opens the builder pre-filled — nothing arms from this list. Saved presets
 * live in nivaro_chaos_presets and move between instances with config promotion.
 */

type Filter = 'all' | 'shipped' | 'saved'

const SOURCE: Record<string, { label: string; cls: string }> = {
  shipped: {
    label: 'Shipped',
    cls: 'bg-slate-100 text-slate-700 dark:bg-muted dark:text-muted-foreground'
  },
  saved: {
    label: 'Saved here',
    cls: 'bg-nvr-cyan/10 text-slate-800 dark:bg-nvr-cyan/15 dark:text-foreground'
  },
  override: {
    label: 'Shipped, edited',
    cls: 'bg-nvr-cyan/10 text-slate-800 dark:bg-nvr-cyan/15 dark:text-foreground'
  }
}

export function PresetsTab() {
  const { data, isLoading, isError } = useQuery({
    queryKey: builderKeys.presets,
    queryFn: fetchPresets
  })
  const { data: status } = useQuery<ChaosStatus>({
    queryKey: chaosKeys.status,
    queryFn: fetchStatus
  })
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const presets = (data?.presets ?? []).filter((p) => {
    if (filter === 'shipped' && p.source !== 'shipped') return false
    if (filter === 'saved' && p.source !== 'saved') return false
    if (!q.trim()) return true
    const hay = `${p.label} ${p.key} ${p.description ?? ''} ${p.proves ?? ''} ${p.claim_keys.join(' ')} ${p.fault.label}`
    return hay.toLowerCase().includes(q.trim().toLowerCase())
  })
  const claimTab = CHAOS_TABS.find((t) => t.id === 'scorecard' || t.id === 'matrix')?.id ?? null

  return (
    <div className='flex-1 overflow-y-auto px-4 py-5 sm:p-6'>
      <div className='mb-4 flex flex-wrap items-end justify-between gap-3'>
        <div className='min-w-0'>
          <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>Presets</h2>
          <p className='mt-0.5 max-w-[75ch] text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            Ready-made experiments, one per claim worth proving. Run opens it in the builder to
            check and confirm; save your own from the builder.
          </p>
        </div>
        {data && (
          <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            saved presets kept in{' '}
            <span className='font-mono text-[11px]'>
              {data.store === 'db'
                ? 'the database'
                : data.store === 'redis'
                  ? 'Redis (until the 497 tables exist)'
                  : 'memory (lost on restart)'}
            </span>
          </span>
        )}
      </div>

      <div className='mb-3 flex flex-wrap items-center gap-2'>
        <div
          role='radiogroup'
          aria-label='Show'
          className='inline-flex gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'
        >
          {(['all', 'shipped', 'saved'] as Filter[]).map((f) => (
            // biome-ignore lint/a11y/useSemanticElements: a segmented control of buttons, same pattern as SecurityCenter
            <button
              key={f}
              type='button'
              role='radio'
              aria-checked={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                'h-7 px-2.5 text-[12px] font-medium capitalize transition-colors duration-150 focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan',
                filter === f
                  ? 'bg-nvr-cyan/10 text-slate-900 dark:bg-nvr-cyan/15 dark:text-foreground'
                  : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-card dark:text-muted-foreground dark:hover:bg-muted'
              )}
            >
              {f}
            </button>
          ))}
        </div>
        <label className='relative min-w-[200px] flex-1 sm:max-w-xs'>
          <span className='sr-only'>Search presets</span>
          <Search
            className='pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400'
            aria-hidden
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder='Search presets, claims, faults'
            className='h-7 w-full rounded-md border border-slate-200 bg-white pl-7 pr-2 text-[12.5px] placeholder:text-slate-500 focus:border-nvr-cyan focus:outline-none dark:border-border dark:bg-card dark:placeholder:text-muted-foreground'
          />
        </label>
      </div>

      {isLoading ? (
        <div className='divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card'>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className='space-y-2 px-4 py-3.5'>
              <Skeleton className='h-4 w-56' />
              <Skeleton className='h-3.5 w-full max-w-xl' />
              <Skeleton className='h-3.5 w-40' />
            </div>
          ))}
        </div>
      ) : isError || !data ? (
        <Empty>The presets did not answer. Reload, or check /api/chaos/presets.</Empty>
      ) : presets.length === 0 ? (
        <Empty>
          {filter === 'saved' && !q
            ? 'No saved presets yet. Build an experiment and press Save as preset.'
            : 'No preset matches.'}
        </Empty>
      ) : (
        <ul className='divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card'>
          {presets.map((p) => (
            <PresetRow
              key={p.key}
              p={p}
              allowed={status?.allowed ?? true}
              refusal={status?.reason ?? null}
              claimTab={claimTab}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className='rounded-lg border border-slate-200 bg-white px-4 py-6 text-center text-[12.5px] text-slate-600 dark:border-border dark:bg-card dark:text-muted-foreground'>
      {children}
    </p>
  )
}

function PresetRow({
  p,
  allowed,
  refusal,
  claimTab
}: {
  p: ChaosPreset
  allowed: boolean
  refusal: string | null
  claimTab: string | null
}) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const del = useMutation({
    mutationFn: () => deletePreset(p.key),
    onSuccess: (r) => {
      toast.success(r.restored ? `Restored the shipped “${p.label}”` : `Deleted “${p.label}”`)
      void qc.invalidateQueries({ queryKey: builderKeys.presets })
    },
    onError: (e) => toast.error(errText(e, 'The preset was not deleted'))
  })
  const source = p.source === 'shipped' ? 'shipped' : p.overrides_shipped ? 'override' : 'saved'
  const runnable = p.fault.installed && allowed
  const spec = p.spec
  const shape = [
    p.fault.label,
    spec.target ? targetWords(spec.target) : null,
    spec.seconds ? formatSeconds(spec.seconds) : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <li className='flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3.5'>
      <div className='min-w-0 flex-1 basis-72'>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
            {p.label}
          </span>
          <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', SOURCE[source].cls)}>
            {SOURCE[source].label}
          </span>
          {!p.fault.installed && (
            <span className='rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950/50 dark:text-amber-300'>
              Fault not on this instance
            </span>
          )}
        </div>
        <p className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
          {shape}
          {p.description ? ` — ${p.description}` : ''}
        </p>
        {p.proves && (
          <p className='mt-1.5 max-w-[80ch] text-[12.5px] text-slate-700 dark:text-foreground/90'>
            <span className='font-medium'>Proves:</span> {p.proves}
          </p>
        )}
        {p.claim_keys.length > 0 && (
          <div className='mt-1.5 flex flex-wrap items-center gap-1.5'>
            <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              Claim{p.claim_keys.length === 1 ? '' : 's'}
            </span>
            {p.claim_keys.map((c) =>
              claimTab ? (
                <Link
                  key={c}
                  to={`/chaos?tab=${claimTab}&claim=${encodeURIComponent(c)}`}
                  className='rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 hover:bg-slate-200 dark:bg-muted dark:text-foreground/90 dark:hover:bg-muted/70'
                >
                  {c}
                </Link>
              ) : (
                <span
                  key={c}
                  className='rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 dark:bg-muted dark:text-foreground/90'
                >
                  {c}
                </span>
              )
            )}
          </div>
        )}
      </div>
      <div className='flex shrink-0 items-center gap-2 self-center'>
        {p.source === 'saved' &&
          (confirmDelete ? (
            <button
              type='button'
              disabled={del.isPending}
              onClick={() => del.mutate()}
              className='inline-flex h-8 items-center gap-1.5 rounded-md bg-red-600 px-3 text-[12.5px] font-medium text-white hover:bg-red-700 disabled:opacity-60'
            >
              {p.overrides_shipped ? 'Restore shipped' : 'Delete preset'}
            </button>
          ) : (
            <button
              type='button'
              aria-label={
                p.overrides_shipped ? `Restore the shipped ${p.label}` : `Delete ${p.label}`
              }
              data-tip={
                p.overrides_shipped ? 'Drop your edits, restore the shipped preset' : 'Delete'
              }
              onClick={() => {
                setConfirmDelete(true)
                if (timer.current) clearTimeout(timer.current)
                timer.current = setTimeout(() => setConfirmDelete(false), 5000)
              }}
              className='rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground'
            >
              <Trash2 className='h-3.5 w-3.5' aria-hidden />
            </button>
          ))}
        <button
          type='button'
          disabled={!runnable}
          data-tip={
            !p.fault.installed
              ? 'This instance does not have this fault'
              : allowed
                ? undefined
                : (refusal ?? 'Refused here')
          }
          onClick={() => navigate(builderHref({ preset: p.key }))}
          className='inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-medium text-white transition-colors duration-150 hover:bg-[#00b8e0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40 dark:focus-visible:ring-offset-card'
        >
          <Play className='h-3.5 w-3.5' aria-hidden />
          Run
        </button>
      </div>
    </li>
  )
}
