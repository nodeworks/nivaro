import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Pencil } from 'lucide-react'
import { type ReactNode, useEffect, useId, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, patch } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Switch } from '../ui/switch'

/**
 * Per-import staleness — how often each staged import is expected to succeed
 * before it counts as stale. ONE store (the stale-import signal's settings:
 * `default_hours` and `cadence_hours:<import key>`, 0 = not monitored) and
 * ONE query key, so the Import Console and the Integrations console always
 * show the same value: an edit in either refreshes both.
 */

export interface ImportHealthRow {
  key: string
  label: string
  is_active: boolean
  last_status: string | null
  last_run_at: string | null
  last_ok_at: string | null
  failures7d: number
  /** Expected hours between successes; 0 when not monitored or dormant. */
  cadence_hours: number
  cadence_source: 'default' | 'override' | 'excluded' | 'dormant'
  stale: boolean
}

export interface ImportHealth {
  rows: ImportHealthRow[]
  default_hours: number
}

const STALE_SIGNAL = 'core:import-stale'
export const IMPORT_HEALTH_KEY = ['integration-partners', 'imports'] as const
const MIN_HOURS = 1
const MAX_HOURS = 2160

export function useImportHealth() {
  const client = useNivaroClient()
  return useQuery({
    queryKey: IMPORT_HEALTH_KEY,
    queryFn: () =>
      client
        .request<{ data: ImportHealthRow[]; default_hours: number }>(
          get('/integration-partners/imports')
        )
        .then((r): ImportHealth => ({ rows: r.data, default_hours: r.default_hours ?? 48 }))
  })
}

/** Write one staleness setting: a number of hours, 0 (not monitored) or null (back to default). */
export function useSetImportCadence() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, number | null>) =>
      client.request(patch(`/integration-signals/settings/${STALE_SIGNAL}`, body)),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: IMPORT_HEALTH_KEY })
      void qc.invalidateQueries({ queryKey: ['integration-signals'] })
    }
  })
}

/** Hours as the editor takes them — "48 h", "2160 h" — so display and input never disagree. */
export function hoursText(h: number): string {
  return `${h.toLocaleString('en-US')} h`
}

function errorText(err: unknown): string {
  const e = err as { response?: { error?: string }; message?: string }
  return e?.response?.error ?? e?.message ?? 'Could not save'
}

function parseHours(raw: string): number | null {
  if (!raw.trim()) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function hoursProblem(raw: string): string | null {
  const n = parseHours(raw)
  if (n == null) return 'Enter a number of hours.'
  if (n < MIN_HOURS || n > MAX_HOURS)
    return `Between ${MIN_HOURS} and ${MAX_HOURS} hours (90 days).`
  return null
}

/** Days since the import's last run of any kind — what a dormant chip's tip
 *  names, so it reads as elapsed time, not a repeat of the fixed threshold. */
function daysSinceLastRun(row: ImportHealthRow): number | null {
  if (!row.last_run_at) return null
  return Math.max(0, Math.floor((Date.now() - new Date(row.last_run_at).getTime()) / 86_400_000))
}

function dormantTip(row: ImportHealthRow): string {
  const days = daysSinceLastRun(row)
  return `No run in ${days ?? 'many'} days — not watched. Run it or set a cadence to watch it again.`
}

/** The editor body — shared by the compact popover and the inline field. */
function CadenceEditor({
  row,
  defaultHours,
  onDone
}: {
  row: ImportHealthRow
  defaultHours: number
  onDone: () => void
}) {
  const set = useSetImportCadence()
  const excluded = row.cadence_source === 'excluded'
  // A dormant row's `cadence_hours` reads 0 too (it isn't watched right now,
  // same as excluded) — seed the input from the default instead, so opening
  // the editor never starts on an invalid "0 hours".
  const noStoredCadence = excluded || row.cadence_source === 'dormant'
  const [monitored, setMonitored] = useState(!excluded)
  const [hours, setHours] = useState(String(noStoredCadence ? defaultHours : row.cadence_hours))
  const inputId = useId()
  const switchId = useId()
  const problem = monitored ? hoursProblem(hours) : null

  const save = () => {
    if (problem) return
    const n = parseHours(hours) as number
    // Typing the default back in on an import that follows the default keeps
    // it following the default instead of pinning today's value.
    const value = !monitored
      ? 0
      : row.cadence_source !== 'override' && n === defaultHours
        ? null
        : n
    set.mutate({ [`cadence_hours:${row.key}`]: value }, { onSuccess: onDone })
  }

  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between gap-3'>
        <label htmlFor={switchId} className='text-[12.5px] font-medium text-foreground'>
          Monitor this import
        </label>
        <Switch
          id={switchId}
          checked={monitored}
          onCheckedChange={setMonitored}
          data-ic-import-monitor={row.key}
        />
      </div>
      {monitored ? (
        <div className='space-y-1'>
          <label htmlFor={inputId} className='text-[11.5px] text-muted-foreground'>
            Stale when no successful run for
          </label>
          <div className='flex items-center gap-2'>
            <Input
              id={inputId}
              value={hours}
              inputMode='decimal'
              onChange={(e) => setHours(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save()
              }}
              aria-invalid={!!problem}
              className={cn(
                'h-8 w-24 text-right text-[12.5px] tabular-nums',
                problem && 'border-[color:var(--nvr-role-negative,#dc2626)]'
              )}
            />
            <span className='text-[12px] text-muted-foreground'>hours</span>
          </div>
          <p
            className={cn(
              'text-[11px] leading-snug',
              problem
                ? 'text-[color:var(--nvr-role-negative,#dc2626)] dark:text-[color:var(--nvr-role-negative-dark,#e08383)]'
                : 'text-muted-foreground'
            )}
          >
            {problem ?? `The default for every import is ${hoursText(defaultHours)}.`}
          </p>
        </div>
      ) : (
        <p className='text-[11.5px] leading-snug text-muted-foreground'>
          It will never be reported as stale. Failed runs are still reported.
        </p>
      )}
      {set.isError && (
        <p className='text-[11.5px] text-[color:var(--nvr-role-negative,#dc2626)] dark:text-[color:var(--nvr-role-negative-dark,#e08383)]'>
          {errorText(set.error)}
        </p>
      )}
      <div className='flex items-center gap-2'>
        <Button
          size='sm'
          onClick={save}
          disabled={!!problem || set.isPending}
          className='h-7 bg-nvr-cyan px-3 text-[12px] text-white hover:bg-nvr-cyan/90'
        >
          {set.isPending && <Loader2 className='animate-spin' />}
          Save
        </Button>
        <Button variant='ghost' size='sm' onClick={onDone} className='h-7 px-2.5 text-[12px]'>
          Cancel
        </Button>
        {row.cadence_source === 'override' && (
          <button
            type='button'
            disabled={set.isPending}
            onClick={() =>
              set.mutate({ [`cadence_hours:${row.key}`]: null }, { onSuccess: onDone })
            }
            className='ml-auto text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline'
          >
            Use default
          </button>
        )}
      </div>
    </div>
  )
}

function stateText(row: ImportHealthRow, compact: boolean): ReactNode {
  if (row.cadence_source === 'dormant') {
    return compact ? (
      <span className='text-muted-foreground' data-tip={dormantTip(row)}>
        Dormant
      </span>
    ) : (
      <span
        className='rounded-full bg-muted px-2 py-px text-[11.5px] text-muted-foreground'
        data-tip={dormantTip(row)}
      >
        Dormant
      </span>
    )
  }
  if (row.cadence_source === 'excluded') {
    // Table cells sit under a "Stale after" header, where "Never" reads right;
    // the row's own "Not monitored" chip carries the state.
    return compact ? (
      <span className='text-muted-foreground'>Never</span>
    ) : (
      <span className='rounded-full bg-muted px-2 py-px text-[11.5px] text-muted-foreground'>
        Not monitored
      </span>
    )
  }
  return (
    <span className='text-foreground'>
      {compact ? '' : 'Expected every '}
      {hoursText(row.cadence_hours)}
      {row.cadence_source === 'default' && (
        <span className='text-muted-foreground'> · default</span>
      )}
    </span>
  )
}

export interface ImportStalenessControlProps {
  /** The import definition's key; absent for a definition that isn't saved yet. */
  importKey?: string | null
  label?: string
  /** Table-cell size: the state opens its editor in a popover beside it. */
  compact?: boolean
  className?: string
}

export function ImportStalenessControl({
  importKey,
  label,
  compact = false,
  className
}: ImportStalenessControlProps) {
  const health = useImportHealth()
  const set = useSetImportCadence()
  const [open, setOpen] = useState(false)
  const row = importKey ? health.data?.rows.find((r) => r.key === importKey) : undefined
  const defaultHours = health.data?.default_hours ?? 48
  const name = label ?? row?.label ?? importKey ?? 'this import'

  // A key edited away underneath an open editor closes it.
  useEffect(() => {
    if (!row) setOpen(false)
  }, [row])

  if (!importKey) {
    return (
      <p className={cn('text-[12px] text-muted-foreground', className)}>
        Available after the import is saved.
      </p>
    )
  }
  if (health.isLoading) {
    return (
      <span
        aria-busy
        className={cn(
          'inline-block h-4 w-24 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]',
          className
        )}
      />
    )
  }
  if (!row) {
    return (
      <p className={cn('text-[12px] text-muted-foreground', className)}>
        {health.isError ? 'Could not load staleness.' : 'Available after the import is saved.'}
      </p>
    )
  }

  if (compact) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            data-ic-import-cadence={row.key}
            data-cadence-source={row.cadence_source}
            aria-label={`Staleness for ${name}: ${
              row.cadence_source === 'excluded'
                ? 'not monitored'
                : `every ${hoursText(row.cadence_hours)}`
            }. Change`}
            className={cn(
              'group -mx-1.5 inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[12.5px] transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              className
            )}
          >
            {stateText(row, true)}
            <Pencil className='h-3 w-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100' />
          </button>
        </PopoverTrigger>
        <PopoverContent align='end' className='w-72 p-3.5'>
          <p className='mb-3 truncate text-[12.5px] font-semibold text-foreground'>{name}</p>
          <CadenceEditor row={row} defaultHours={defaultHours} onDone={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <div className={cn('space-y-2', className)} data-ic-import-cadence={row.key}>
      {open ? (
        <div className='max-w-[340px] rounded-md border border-border bg-card p-3'>
          <CadenceEditor row={row} defaultHours={defaultHours} onDone={() => setOpen(false)} />
        </div>
      ) : (
        <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]'>
          <button
            type='button'
            onClick={() => setOpen(true)}
            data-cadence-source={row.cadence_source}
            className='inline-flex items-center gap-1.5 rounded text-left hover:underline hover:decoration-muted-foreground hover:underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          >
            {stateText(row, false)}
          </button>
          <button
            type='button'
            onClick={() => setOpen(true)}
            className='text-[12px] text-muted-foreground hover:text-foreground'
          >
            Change
          </button>
          {row.cadence_source === 'override' && (
            <button
              type='button'
              disabled={set.isPending}
              onClick={() => set.mutate({ [`cadence_hours:${row.key}`]: null })}
              className='text-[12px] text-muted-foreground hover:text-foreground'
            >
              Use default
            </button>
          )}
          {row.cadence_source === 'excluded' && (
            <button
              type='button'
              disabled={set.isPending}
              onClick={() => set.mutate({ [`cadence_hours:${row.key}`]: null })}
              className='text-[12px] text-muted-foreground hover:text-foreground'
            >
              Monitor again
            </button>
          )}
          {set.isPending && <Loader2 className='h-3.5 w-3.5 animate-spin text-muted-foreground' />}
          {set.isError && (
            <span className='text-[12px] text-[color:var(--nvr-role-negative,#dc2626)] dark:text-[color:var(--nvr-role-negative-dark,#e08383)]'>
              {errorText(set.error)}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/** The chip a definitions list shows beside each import. */
export function ImportStalenessChip({ importKey }: { importKey: string }) {
  const health = useImportHealth()
  const row = health.data?.rows.find((r) => r.key === importKey)
  if (!row) return null
  if (row.cadence_source === 'dormant')
    return (
      <span
        className='shrink-0 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground'
        data-tip={dormantTip(row)}
      >
        Dormant
      </span>
    )
  if (row.cadence_source === 'excluded')
    return (
      <span className='shrink-0 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground'>
        Not monitored
      </span>
    )
  if (row.stale)
    return (
      <span className='shrink-0 rounded-full bg-[color:color-mix(in_srgb,var(--nvr-role-warning,#b45309)_9%,transparent)] px-1.5 text-[10px] font-medium text-[color:var(--nvr-role-warning,#b45309)] dark:bg-[color:color-mix(in_srgb,var(--nvr-role-warning-dark,#d4936a)_14%,transparent)] dark:text-[color:var(--nvr-role-warning-dark,#d4936a)]'>
        Stale
      </span>
    )
  if (row.cadence_source === 'override')
    return (
      <span className='shrink-0 text-[10px] tabular-nums text-muted-foreground'>
        every {hoursText(row.cadence_hours)}
      </span>
    )
  return null
}

/** The instance-wide default cadence — header of the imports table. */
export function ImportDefaultCadenceControl({ className }: { className?: string }) {
  const health = useImportHealth()
  const set = useSetImportCadence()
  const [open, setOpen] = useState(false)
  const defaultHours = health.data?.default_hours ?? 48
  const [draft, setDraft] = useState(String(defaultHours))
  const inputId = useId()
  const problem = hoursProblem(draft)

  useEffect(() => {
    if (open) setDraft(String(defaultHours))
  }, [open, defaultHours])

  const save = () => {
    if (problem) return
    set.mutate({ default_hours: parseHours(draft) as number }, { onSuccess: () => setOpen(false) })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-ic-import-default-cadence
          disabled={health.isLoading}
          className={cn(
            'group inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className
          )}
        >
          Default: stale after{' '}
          <span className='font-medium text-foreground'>{hoursText(defaultHours)}</span>
          <Pencil className='h-3 w-3 opacity-60 group-hover:opacity-100' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-72 space-y-3 p-3.5'>
        <div className='space-y-1'>
          <label htmlFor={inputId} className='text-[12.5px] font-semibold text-foreground'>
            Default staleness
          </label>
          <p className='text-[11.5px] leading-snug text-muted-foreground'>
            Every import without its own setting is stale when its newest successful run is older
            than this.
          </p>
        </div>
        <div className='flex items-center gap-2'>
          <Input
            id={inputId}
            value={draft}
            inputMode='decimal'
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
            aria-invalid={!!problem}
            className='h-8 w-24 text-right text-[12.5px] tabular-nums'
          />
          <span className='text-[12px] text-muted-foreground'>hours</span>
        </div>
        {(problem || set.isError) && (
          <p className='text-[11px] text-[color:var(--nvr-role-negative,#dc2626)] dark:text-[color:var(--nvr-role-negative-dark,#e08383)]'>
            {problem ?? errorText(set.error)}
          </p>
        )}
        <div className='flex items-center gap-2'>
          <Button
            size='sm'
            onClick={save}
            disabled={!!problem || set.isPending}
            className='h-7 bg-nvr-cyan px-3 text-[12px] text-white hover:bg-nvr-cyan/90'
          >
            {set.isPending && <Loader2 className='animate-spin' />}
            Save
          </Button>
          <Button
            variant='ghost'
            size='sm'
            onClick={() => setOpen(false)}
            className='h-7 px-2.5 text-[12px]'
          >
            Cancel
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
