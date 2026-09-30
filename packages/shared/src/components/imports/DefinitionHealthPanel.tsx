import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Database, Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn, formatFileSize, formatNumber, formatRelative } from '../../lib/utils'
import { Button } from '../ui/button'
import { useImportHealth } from './ImportStalenessControl'
import { STATUS_STYLE } from './run-parts'
import {
  definitionTitle,
  type ImportDefinition,
  type ImportRunStatus,
  type StagingTableInfo
} from './types'

/**
 * #650 / #846 — one card per active definition on the Import Console home:
 * when it last ran and whether that is late for its cadence, its error rate
 * over the window, the row counts of its recent runs, and how much its
 * staging table holds (and when that empties). Clicking a card filters the
 * runs below to that import.
 */

interface DefinitionHealth {
  key: string
  runs: number
  finished: number
  errors: number
  error_rate: number | null
  observed_gap_hours: number | null
  recent: Array<{
    id: number
    status: string
    row_count: number | null
    duration: number | null
    at: string
  }>
}

const HEALTH_DAYS = 30
const OPEN_KEY = 'nvr_import_health_open'

function hoursText(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`
  if (h < 48) return `${Math.round(h)} h`
  return `${Math.round(h / 24)} days`
}

/** Bars of the recent runs' row counts; failed runs are red stubs. */
function RowTrend({ recent }: { recent: DefinitionHealth['recent'] }) {
  if (recent.length === 0) {
    return <p className='text-[11px] text-muted-foreground'>No runs in {HEALTH_DAYS} days</p>
  }
  const max = Math.max(1, ...recent.map((r) => r.row_count ?? 0))
  return (
    <div className='flex h-7 items-end gap-[3px]' data-health-trend>
      {recent.map((r) => {
        const failed = r.status === 'error'
        const h = failed ? 20 : Math.max(8, Math.round(((r.row_count ?? 0) / max) * 100))
        return (
          <span
            key={r.id}
            data-tip={`Run #${r.id} · ${STATUS_STYLE[r.status as ImportRunStatus]?.label ?? r.status}${
              r.row_count != null ? ` · ${formatNumber(r.row_count)} rows` : ''
            } · ${formatRelative(r.at)}`}
            className={cn(
              'w-[6px] rounded-sm',
              failed ? 'bg-red-500' : r.status === 'completed' ? 'bg-nvr-cyan/70' : 'bg-slate-300'
            )}
            style={{ height: `${h}%` }}
          />
        )
      })}
    </div>
  )
}

export function DefinitionHealthPanel({
  definitions,
  selectedKey,
  onSelectKey
}: {
  definitions: ImportDefinition[]
  selectedKey: string
  onSelectKey: (key: string) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== '0'
    } catch {
      return true
    }
  })
  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(OPEN_KEY, o ? '0' : '1')
      } catch {
        /* per-browser convenience only */
      }
      return !o
    })
  }

  const healthQuery = useQuery({
    queryKey: ['staged-import-definition-health', HEALTH_DAYS],
    queryFn: () =>
      client
        .request<{ data: DefinitionHealth[] }>(
          get('/staged-imports/definition-health', { days: HEALTH_DAYS })
        )
        .then((r) => r.data),
    enabled: open,
    staleTime: 60_000
  })
  const stagingQuery = useQuery({
    queryKey: ['staged-import-staging-tables'],
    queryFn: () =>
      client
        .request<{ data: StagingTableInfo[] }>(get('/staged-imports/staging-tables'))
        .then((r) => r.data),
    enabled: open,
    staleTime: 60_000
  })
  const stale = useImportHealth()

  const purge = useMutation({
    mutationFn: (defId: number) =>
      client.request(post(`/staged-imports/definitions/${defId}/purge-staging`)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['staged-import-staging-tables'] })
      setConfirm(null)
    }
  })
  const [confirm, setConfirm] = useState<string | null>(null)

  const cards = useMemo(() => {
    const health = new Map((healthQuery.data ?? []).map((h) => [h.key.toLowerCase(), h]))
    const staleness = new Map((stale.data?.rows ?? []).map((r) => [r.key.toLowerCase(), r]))
    const staging = stagingQuery.data ?? []
    return definitions
      .filter((d) => d.is_active)
      .map((d) => {
        const table = (d.staging_table || `staging_${d.key}`).toLowerCase()
        return {
          def: d,
          health: health.get(d.key.toLowerCase()) ?? null,
          stale: staleness.get(d.key.toLowerCase()) ?? null,
          staging: staging.find((t) => t.table.toLowerCase() === table) ?? null
        }
      })
      .sort(
        (a, b) =>
          Number(b.stale?.stale ?? false) - Number(a.stale?.stale ?? false) ||
          (b.health?.errors ?? 0) - (a.health?.errors ?? 0) ||
          definitionTitle(a.def).localeCompare(definitionTitle(b.def))
      )
  }, [definitions, healthQuery.data, stale.data, stagingQuery.data])

  const attention = cards.filter((c) => c.stale?.stale || (c.health?.errors ?? 0) > 0).length

  return (
    <section
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-import-health
    >
      <button
        type='button'
        onClick={toggle}
        aria-expanded={open}
        className='flex w-full items-center gap-2 px-3.5 py-2 text-left'
      >
        <ChevronDown
          className={cn('h-3.5 w-3.5 text-slate-400 transition-transform', !open && '-rotate-90')}
        />
        <span className='text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
          Import health
        </span>
        <span className='text-[11.5px] text-muted-foreground'>
          {cards.length} active
          {attention > 0 ? ` · ${attention} need a look` : ''} · last {HEALTH_DAYS} days
        </span>
      </button>
      {open && (
        <div className='grid gap-2 border-t border-slate-200 p-2.5 sm:grid-cols-2 xl:grid-cols-3 dark:border-border'>
          {cards.length === 0 && (
            <p className='px-1 py-2 text-[12px] text-muted-foreground'>No active imports.</p>
          )}
          {cards.map(({ def, health, stale: st, staging }) => {
            const selected = selectedKey === def.key
            const lastRun = st?.last_run_at ?? health?.recent.at(-1)?.at ?? null
            const lastOk = st?.last_ok_at ?? null
            const sinceOk = lastOk ? (Date.now() - new Date(lastOk).getTime()) / 3_600_000 : null
            const cadence = st && st.cadence_hours > 0 ? st.cadence_hours : null
            const late = cadence != null && sinceOk != null ? sinceOk - cadence : null
            const errRate = health?.error_rate
            return (
              <div
                key={def.id}
                data-import-health-card={def.key}
                className={cn(
                  'flex flex-col gap-1.5 rounded-md border px-3 py-2.5 transition-colors',
                  selected
                    ? 'border-nvr-cyan bg-nvr-cyan/5'
                    : 'border-slate-200 hover:border-slate-300 dark:border-border',
                  st?.stale && !selected && 'border-amber-300 dark:border-amber-500/50'
                )}
              >
                <button
                  type='button'
                  onClick={() => onSelectKey(selected ? '' : def.key)}
                  aria-pressed={selected}
                  className='flex items-start justify-between gap-2 text-left'
                >
                  <span className='min-w-0'>
                    <span className='block truncate text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
                      {definitionTitle(def)}
                    </span>
                    <span className='block text-[11px] text-muted-foreground'>
                      {lastRun ? `Last run ${formatRelative(lastRun)}` : 'Never run'}
                      {st?.last_status && st.last_status in STATUS_STYLE && (
                        <span
                          className={cn(
                            'ml-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle',
                            STATUS_STYLE[st.last_status as ImportRunStatus].dot
                          )}
                        />
                      )}
                    </span>
                  </span>
                  <RowTrend recent={health?.recent ?? []} />
                </button>
                <dl className='grid grid-cols-3 gap-1 text-[11px]'>
                  <div>
                    <dt className='text-muted-foreground'>Cadence</dt>
                    <dd
                      className={cn(
                        'font-medium tabular-nums',
                        st?.stale
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-slate-700 dark:text-foreground'
                      )}
                      data-health-cadence
                      data-tip={
                        cadence == null
                          ? 'Not monitored for staleness'
                          : `Expected every ${hoursText(cadence)}${
                              health?.observed_gap_hours != null
                                ? `; runs have landed about every ${hoursText(health.observed_gap_hours)}`
                                : ''
                            }`
                      }
                    >
                      {cadence == null
                        ? health?.observed_gap_hours != null
                          ? `~${hoursText(health.observed_gap_hours)}`
                          : '—'
                        : st?.stale && late != null && late > 0
                          ? `${hoursText(late)} late`
                          : `every ${hoursText(cadence)}`}
                    </dd>
                  </div>
                  <div>
                    <dt className='text-muted-foreground'>Errors</dt>
                    <dd
                      className={cn(
                        'font-medium tabular-nums',
                        (health?.errors ?? 0) > 0
                          ? 'text-red-700 dark:text-red-400'
                          : 'text-slate-700 dark:text-foreground'
                      )}
                    >
                      {errRate == null
                        ? '—'
                        : `${Math.round(errRate * 100)}% · ${health?.errors}/${health?.finished}`}
                    </dd>
                  </div>
                  <div>
                    <dt className='text-muted-foreground'>Staging</dt>
                    <dd
                      className='truncate font-medium tabular-nums text-slate-700 dark:text-foreground'
                      data-health-staging={staging?.table ?? ''}
                      data-tip={
                        staging
                          ? `${staging.table}: ${formatNumber(staging.rows)} rows. ${staging.reason}`
                          : 'No staging table'
                      }
                    >
                      {staging?.exists
                        ? staging.rows > 0
                          ? formatFileSize(staging.size_kb * 1024)
                          : 'empty'
                        : '—'}
                    </dd>
                  </div>
                </dl>
                {staging?.exists && staging.rows > 0 && (
                  <div className='flex items-center gap-2 text-[11px] text-muted-foreground'>
                    <Database className='h-3 w-3 shrink-0' />
                    <span className='min-w-0 flex-1 truncate'>
                      {formatNumber(staging.rows)} rows · {staging.reason}
                    </span>
                    {confirm === def.key ? (
                      <Button
                        size='sm'
                        variant='destructive'
                        className='h-6 px-2 text-[11px]'
                        disabled={purge.isPending || staging.busy}
                        onClick={() => purge.mutate(def.id)}
                        onBlur={() => setConfirm(null)}
                        data-health-purge-confirm
                      >
                        {purge.isPending && <Loader2 className='h-3 w-3 animate-spin' />}
                        Empty {staging.table}
                      </Button>
                    ) : (
                      <Button
                        size='sm'
                        variant='ghost'
                        className='h-6 px-2 text-[11px]'
                        disabled={staging.busy}
                        onClick={() => setConfirm(def.key)}
                        data-health-purge
                      >
                        Empty now
                      </Button>
                    )}
                  </div>
                )}
                {purge.isError && confirm === def.key && (
                  <p className='text-[11px] text-red-700 dark:text-red-400'>
                    {(purge.error as { response?: { error?: string }; message?: string })?.response
                      ?.error ?? (purge.error as Error).message}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
