import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Info } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { type Catalog, chaosKeys, fetchCatalog } from './api'
import { builderKeys, fetchPreset } from './builder/api'
import { ExperimentBuilder } from './builder/ExperimentBuilder'
import { parseSpecParam } from './builder/model'

/**
 * Builder tab (#2844): the experiment builder at full width. Deep links:
 *   ?tab=builder&fault=<key> · ?tab=builder&preset=<key> · ?tab=builder&spec=<json>
 * (presets "Run", the Traffic Map's "Inject fault here", the resilience matrix, Ask AI drafts).
 */
export function BuilderTab() {
  const [params] = useSearchParams()
  const presetKey = params.get('preset')
  const specRaw = params.get('spec')
  const spec = parseSpecParam(specRaw)
  const catalog = useQuery<Catalog>({ queryKey: chaosKeys.catalog, queryFn: fetchCatalog })
  const preset = useQuery({
    queryKey: builderKeys.preset(presetKey ?? '-'),
    queryFn: () => fetchPreset(presetKey as string),
    enabled: !!presetKey,
    retry: false
  })

  const wanted = params.get('fault') ?? spec?.fault_key ?? preset.data?.spec.fault_key ?? null
  const faults = catalog.data?.faults ?? []
  const fault =
    (wanted ? faults.find((f) => f.key === wanted) : null) ?? (wanted ? null : faults[0])

  let body: ReactNode
  if (catalog.isLoading || (presetKey && preset.isLoading)) {
    body = (
      <div className='grid gap-4 rounded-lg border border-slate-200 bg-white p-4 lg:grid-cols-[200px_minmax(0,1fr)_300px] dark:border-border dark:bg-card'>
        <div className='space-y-2'>
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <Skeleton key={i} className='h-6 w-full' />
          ))}
        </div>
        <div className='space-y-3'>
          <Skeleton className='h-5 w-48' />
          <Skeleton className='h-4 w-2/3' />
          <Skeleton className='h-8 w-80' />
        </div>
        <Skeleton className='h-40 w-full' />
      </div>
    )
  } else if (catalog.isError) {
    body = (
      <Notice>
        The fault catalog did not load (
        <span className='font-mono text-[12px]'>/api/chaos/catalog</span>).{' '}
        <button
          type='button'
          onClick={() => void catalog.refetch()}
          className='rounded-sm font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
        >
          Try again
        </button>
      </Notice>
    )
  } else if (presetKey && (preset.isError || !preset.data)) {
    body = (
      <Notice>
        No preset <span className='font-mono text-[12px]'>{presetKey}</span> here.{' '}
        <Link to='/chaos?tab=presets' className='font-medium underline underline-offset-2'>
          See every preset
        </Link>
        .
      </Notice>
    )
  } else if (!fault) {
    body = (
      <Notice>
        {wanted ? (
          <>
            This instance has no fault <span className='font-mono text-[12px]'>{wanted}</span>, so
            this experiment cannot run here.
          </>
        ) : (
          'No faults registered on this instance yet.'
        )}{' '}
        <Link to='/chaos' className='font-medium underline underline-offset-2'>
          See the faults
        </Link>
        .
      </Notice>
    )
  } else {
    body = (
      <ExperimentBuilder
        key={`${fault.key}|${presetKey ?? ''}|${specRaw ?? ''}`}
        fault={fault}
        preset={preset.data ?? null}
        initial={spec}
        variant='tab'
      />
    )
  }

  return (
    <div className='flex-1 overflow-y-auto px-4 pb-20 pt-5 sm:p-6'>
      <div className='mb-4'>
        <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>
          Build an experiment
        </h2>
        <p className='mt-0.5 max-w-[75ch] text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          Choose a fault, who it reaches, how hard and how long, and what must stay true. Run asks
          you to confirm; Save as preset keeps it for next time.
        </p>
      </div>
      {/* A drafted experiment (Ask AI's what-if #2860, the Traffic Map, the matrix) says so. */}
      {specRaw && fault && !catalog.isLoading && (
        <p
          role='status'
          className={cn(
            'mb-3 flex items-start gap-2 rounded-md border px-3 py-2 text-[12.5px]',
            spec
              ? 'border-slate-200 bg-white text-slate-700 dark:border-border dark:bg-card dark:text-foreground/90'
              : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200'
          )}
        >
          {spec ? (
            <Info className='mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70' aria-hidden />
          ) : (
            <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' aria-hidden />
          )}
          <span className='min-w-0'>
            {spec
              ? 'Opened from a drafted experiment. Nothing is armed: check each step, then Run and Confirm.'
              : 'The link’s experiment could not be read, so the builder starts from the fault’s defaults.'}
          </span>
        </p>
      )}
      {body}
    </div>
  )
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className='rounded-lg border border-slate-200 bg-white px-4 py-6 text-center text-[12.5px] text-slate-600 dark:border-border dark:bg-card dark:text-muted-foreground'>
      {children}
    </p>
  )
}
