import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  Download,
  FileSpreadsheet,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Upload
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useItemEditAuth, useItemNavigation, useNavigation, useNivaroClient } from '../../context'
import { useDebounced } from '../../hooks/useDebounced'
import { get, post } from '../../lib/commands'
import { cn, formatDateTime, formatFileSize, formatNumber, formatRelative } from '../../lib/utils'
import { type Column, DataTable } from '../DataTable'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Sheet, SheetContent } from '../ui/sheet'
import { CollectionImportPanel } from './CollectionImportPanel'
import { DefinitionsPanel } from './DefinitionsPanel'
import { NewImportDialog } from './NewImportDialog'
import { RunDetailSheet } from './RunDetailSheet'
import { LIVE_POLL_MS, STATUS_STYLE, StatusPill, useElapsed } from './run-parts'
import {
  type ImportDefinition,
  type ImportProgressEvent,
  type ImportRealtimeAdapter,
  type ImportRun,
  type ImportRunStatus,
  type ImportStats,
  RUN_STATUSES,
  definitionTitle,
  formatDuration,
  runnerName,
  importMode
} from './types'

export type { ImportProgressEvent, ImportRealtimeAdapter, ImportRun } from './types'

const PAGE_SIZE = 25
const IDLE_POLL_MS = 30_000

const WINDOWS = [
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
  { value: '0', label: 'All' }
]

// ─── Props ──────────────────────────────────────────────────────────────────

export interface ImportConsoleProps {
  /**
   * Live `import:progress` events. Hosts own the socket; without an adapter the
   * console still tracks state on its poll, just up to 5s later.
   */
  realtime?: ImportRealtimeAdapter
  /** Which section to open on. `definitions` is admin-only. */
  defaultTab?: ConsoleTab
  /** Deep link into a collection-import job's detail (admin /imports/:id). */
  initialJobId?: string | null
  /** Fires when a collection-import job's detail opens or closes, so a host
   *  can keep its own URL in step. */
  onJobOpen?: (id: string | null) => void
  /** Deep link into a staged run's detail (admin /imports?run=9801). */
  initialRunId?: number | null
  /** Fires when a staged run's detail opens or closes. */
  onRunOpen?: (id: number | null) => void
}

export type ConsoleTab = 'runs' | 'collection' | 'definitions'

const TAB_LABELS: Record<ConsoleTab, string> = {
  runs: 'Staged imports',
  collection: 'Collection imports',
  definitions: 'Definitions'
}

// ─── Small parts ────────────────────────────────────────────────────────────

function InsightTile({
  label,
  value,
  sub
}: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
}) {
  return (
    <div className='px-3.5 py-2'>
      <p className='text-[10.5px] font-medium text-slate-400 dark:text-muted-foreground'>{label}</p>
      <p className='mt-0.5 text-[15px] font-semibold leading-none tabular-nums text-slate-900 dark:text-foreground'>
        {value}
      </p>
      {sub && <p className='mt-1 text-[10.5px] leading-none text-slate-400'>{sub}</p>}
    </div>
  )
}

function StatusSegment({
  label,
  count,
  status,
  active,
  onClick
}: {
  label: string
  count: number | null
  status?: ImportRunStatus
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-slate-50 dark:hover:bg-muted/40',
        active && 'bg-nvr-cyan/10 ring-1 ring-inset ring-nvr-cyan dark:bg-nvr-cyan/15',
        !active && count === 0 && 'opacity-45'
      )}
    >
      {status && (
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_STYLE[status].dot)} />
      )}
      <span className='text-[14px] font-semibold leading-none tabular-nums text-slate-900 dark:text-foreground'>
        {count == null ? '—' : formatNumber(count)}
      </span>
      <span className='text-[11px] font-medium leading-none text-slate-400 dark:text-muted-foreground'>
        {label}
      </span>
    </button>
  )
}

/**
 * The one run that matters right now. A banner rather than a tile because it's
 * only true some of the time — a permanent "0 running" tile teaches nothing,
 * and this needs room for the stage, the elapsed clock and a way out.
 */
function LiveRunBanner({
  run,
  queuedCount,
  stage,
  canManage,
  onOpen,
  onCancel
}: {
  run: ImportStats['active'][number]
  queuedCount: number
  stage: string | null
  canManage: boolean
  onOpen: () => void
  onCancel: () => void
}) {
  const running = run.status === 'running'
  const elapsed = useElapsed(run.started_at ?? run.created_at, running)
  return (
    <div className='flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-[#7ad9f2] bg-nvr-cyan/10 px-3.5 py-2.5 dark:border-[#0e5c72] dark:bg-nvr-cyan/10'>
      <StatusPill status={running ? 'running' : 'queued'} />
      <button
        type='button'
        onClick={onOpen}
        className='font-mono text-[12px] font-medium text-slate-900 underline-offset-2 hover:underline dark:text-foreground'
      >
        {run.import_key}
      </button>
      {running && elapsed != null && (
        <span className='font-mono text-[12px] tabular-nums text-slate-600 dark:text-muted-foreground'>
          {formatDuration(elapsed)} elapsed
        </span>
      )}
      {stage && (
        <span className='text-[12px] text-slate-600 dark:text-muted-foreground'>{stage}</span>
      )}
      {run.row_count != null && (
        <span className='text-[12px] tabular-nums text-slate-500 dark:text-muted-foreground'>
          {formatNumber(run.row_count)} rows
        </span>
      )}
      {queuedCount > 0 && (
        <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          · {queuedCount} more queued
        </span>
      )}
      {canManage && (
        <Button variant='ghost' size='sm' className='ml-auto h-7 px-2' onClick={onCancel}>
          <Ban className='h-3.5 w-3.5' />
          Stop
        </Button>
      )}
    </div>
  )
}

// ─── Console ────────────────────────────────────────────────────────────────

export function ImportConsole({
  realtime,
  defaultTab = 'runs',
  initialJobId,
  onJobOpen,
  initialRunId = null,
  onRunOpen
}: ImportConsoleProps) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { isAdmin } = useItemEditAuth()
  const nav = useNavigation()
  const { open: openItem } = useItemNavigation()
  const canLinkUsers = !!nav.itemUrl || !!nav.openItem

  const [tab, setTab] = useState<ConsoleTab>(() => {
    if (initialJobId) return 'collection'
    return defaultTab !== 'runs' && !isAdmin ? 'runs' : defaultTab
  })
  const [status, setStatus] = useState<ImportRunStatus | 'all'>('all')
  const [importKey, setImportKey] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [windowDays, setWindowDays] = useState('30')
  const [openRunId, setOpenRunIdState] = useState<number | null>(initialRunId)
  const setOpenRunId = (id: number | null) => {
    setOpenRunIdState(id)
    onRunOpen?.(id)
  }
  const [newOpen, setNewOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  /** Latest socket stage per run — instant feedback the poll then confirms. */
  const [stages, setStages] = useState<Record<number, string>>({})

  const debouncedSearch = useDebounced(search, 300)
  useEffect(() => setPage(1), [status, importKey, debouncedSearch, windowDays])

  const definitionsQuery = useQuery({
    queryKey: ['staged-import-definitions'],
    queryFn: () =>
      client.request(get<{ data: ImportDefinition[] }>('/staged-imports/definitions', { all: true }))
  })
  const definitions = useMemo(
    () => definitionsQuery.data?.data ?? [],
    [definitionsQuery.data?.data]
  )

  const statsQuery = useQuery({
    queryKey: ['staged-import-stats', windowDays],
    queryFn: () =>
      client.request(get<{ data: ImportStats }>('/staged-imports/stats', { days: windowDays }))
  })
  const stats = statsQuery.data?.data

  // Poll fast only while something is actually in flight.
  const hasActive = (stats?.active.length ?? 0) > 0
  const pollMs = hasActive ? LIVE_POLL_MS : IDLE_POLL_MS

  const runsQuery = useQuery({
    queryKey: ['staged-import-runs', status, importKey, debouncedSearch, page, windowDays],
    queryFn: () =>
      client.request(
        get<{ data: ImportRun[]; total: number }>('/staged-imports', {
          page,
          limit: PAGE_SIZE,
          days: windowDays,
          ...(status === 'all' ? {} : { status }),
          ...(importKey ? { key: importKey } : {}),
          ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {})
        })
      ),
    refetchInterval: pollMs,
    // Refetching must not blank the table out from under someone reading it.
    placeholderData: (prev) => prev
  })
  const runs = runsQuery.data?.data ?? []

  function refreshAll() {
    void qc.invalidateQueries({ queryKey: ['staged-import-runs'] })
    void qc.invalidateQueries({ queryKey: ['staged-import-stats'] })
    void qc.invalidateQueries({ queryKey: ['collection-import-jobs'] })
  }
  const refreshRef = useRef(refreshAll)
  refreshRef.current = refreshAll

  // Live stage changes. The event only carries a stage, so it drives the label
  // and triggers a refetch; the row data itself still comes from the API.
  useEffect(() => {
    if (!realtime) return
    return realtime.subscribe((e: ImportProgressEvent) => {
      setStages((prev) => ({
        ...prev,
        [e.id]:
          e.stage === 'row_count'
            ? `${formatNumber(e.row_count ?? 0)} rows read`
            : e.stage === 'preparing'
              ? 'Preparing the staging table'
              : e.stage === 'importing'
                ? 'Importing the rows'
                : e.stage === 'completed'
                  ? 'Completed'
                  : (e.error ?? 'Failed')
      }))
      refreshRef.current()
    })
  }, [realtime])

  const statsTiles = stats?.by_status ?? {}
  const activeStatuses = stats?.active ?? []
  const leadRun = activeStatuses.find((a) => a.status === 'running') ?? activeStatuses[0]
  const queuedCount = activeStatuses.filter((a) => a.id !== leadRun?.id).length

  // All-time per-key counts from the stats endpoint — counting the current
  // page would report "1" for an import with a thousand runs behind it.
  const runCounts = stats?.by_key ?? {}

  // ── Mutations ────────────────────────────────────────────────────────────

  const requeue = useMutation({
    mutationFn: (id: number) => client.request(post(`/staged-imports/${id}/requeue`)),
    onSuccess: () => {
      setActionError(null)
      refreshAll()
    },
    onError: (err: Error) => setActionError(err.message)
  })
  const cancel = useMutation({
    mutationFn: (id: number) => client.request(post(`/staged-imports/${id}/cancel`)),
    onSuccess: () => {
      setActionError(null)
      refreshAll()
    },
    onError: (err: Error) => setActionError(err.message)
  })

  // ── Table ────────────────────────────────────────────────────────────────

  const columns: Column<ImportRun>[] = [
    {
      key: 'status',
      header: 'Status',
      className: 'w-[110px]',
      render: (r) => <StatusPill status={r.status} />
    },
    {
      key: 'import',
      header: 'Import',
      render: (r) => (
        <div className='min-w-0'>
          <p className='truncate text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
            {r.definition_label?.trim() || r.import_key}
          </p>
          <p className='truncate font-mono text-[10.5px] text-slate-400'>{r.import_key}</p>
        </div>
      )
    },
    {
      key: 'file',
      header: 'File',
      className: 'max-w-[220px]',
      render: (r) =>
        r.file_name ? (
          <span
            className='block truncate font-mono text-[11.5px] text-slate-600 dark:text-muted-foreground'
            title={r.file_name}
          >
            {r.file_name}
          </span>
        ) : (
          <span className='text-slate-300'>—</span>
        )
    },
    {
      key: 'row_count',
      header: 'Rows',
      className: 'w-[90px] text-right',
      headerClassName: 'text-right',
      render: (r) => (
        <span className='font-mono text-[11.5px] tabular-nums text-slate-700 dark:text-foreground'>
          {r.row_count == null ? '—' : formatNumber(r.row_count)}
        </span>
      )
    },
    {
      key: 'duration',
      header: 'Duration',
      className: 'w-[90px] text-right',
      headerClassName: 'text-right',
      render: (r) => (
        <span className='font-mono text-[11.5px] tabular-nums text-slate-600 dark:text-muted-foreground'>
          {formatDuration(r.duration)}
        </span>
      )
    },
    {
      key: 'created_by',
      header: 'Queued by',
      className: 'w-[150px]',
      render: (r) => {
        const name = runnerName(r)
        if (!name) return <span className='text-slate-300'>—</span>
        // NavigationContext is optional, and its default sends the browser to
        // the admin's own route shape — only link when the host has actually
        // told us how it routes records, otherwise this is a dead link.
        return r.created_by && canLinkUsers ? (
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation()
              openItem({ collection: 'nivaro_users', itemId: r.created_by as string })
            }}
            className='truncate text-[12px] text-slate-600 underline-offset-2 hover:text-nvr-navy hover:underline dark:text-muted-foreground dark:hover:text-nvr-cyan'
          >
            {name}
          </button>
        ) : (
          <span className='truncate text-[12px] text-slate-600 dark:text-muted-foreground'>
            {name}
          </span>
        )
      }
    },
    {
      key: 'created_at',
      header: 'Queued',
      className: 'w-[120px]',
      render: (r) => (
        <span
          className='text-[12px] text-slate-500 dark:text-muted-foreground'
          title={r.created_at ? formatDateTime(r.created_at) : undefined}
        >
          {r.created_at ? formatRelative(r.created_at) : '—'}
        </span>
      )
    },
    {
      key: '__actions__',
      header: '',
      className: 'w-[44px]',
      render: (r) => (
        <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type='button'
                className='rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted'
                aria-label={`Actions for run ${r.id}`}
              >
                <MoreHorizontal className='h-4 w-4' />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end' className='text-[12.5px]'>
              <DropdownMenuItem onSelect={() => setOpenRunId(r.id)}>
                <ScrollText className='h-3.5 w-3.5' /> View details
              </DropdownMenuItem>
              {isAdmin && (
                <DropdownMenuItem
                  disabled={r.status === 'running' || !r.file}
                  onSelect={() => requeue.mutate(r.id)}
                >
                  <RotateCcw className='h-3.5 w-3.5' /> Re-queue
                </DropdownMenuItem>
              )}
              {isAdmin && (
                <DropdownMenuItem
                  disabled={r.status === 'completed'}
                  onSelect={() => cancel.mutate(r.id)}
                >
                  <Ban className='h-3.5 w-3.5' /> Cancel
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )
    }
  ]

  const filtersActive = status !== 'all' || !!importKey || !!debouncedSearch.trim()
  /** Teach only when nothing has EVER run — an empty 30-day window on an
   *  instance with years of history is a different message entirely. */
  const noHistory = (stats?.all_time_total ?? 0) === 0 && !statsQuery.isLoading
  const emptyWindow =
    !filtersActive && !noHistory && (stats?.total ?? 0) === 0 && windowDays !== '0'

  const openRun = openRunId != null ? runs.find((r) => r.id === openRunId) : undefined

  return (
    <div className='flex min-h-0 flex-1 flex-col gap-3'>
      {/* ── Tabs + primary action ──────────────────────────────────────── */}
      <div className='flex flex-wrap items-center gap-2'>
        <div className='flex items-center gap-1'>
          {/* Staged runs are readable by anyone; `/api/imports` and the
              definition registry are admin-only routes, so their sections are
              hidden rather than shown to 403. */}
          {(['runs', 'collection', 'definitions'] as const)
            .filter((t) => t === 'runs' || isAdmin)
            .map((t) => (
              <button
                key={t}
                type='button'
                onClick={() => setTab(t)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors',
                  tab === t
                    ? 'bg-nvr-cyan/15 text-nvr-navy dark:bg-nvr-cyan/20 dark:text-nvr-cyan'
                    : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-muted-foreground dark:hover:bg-muted'
                )}
              >
                {TAB_LABELS[t]}
              </button>
            ))}
        </div>
        <div className='ml-auto flex items-center gap-2'>
          <Button
            variant='ghost'
            size='sm'
            className='h-7 px-2'
            onClick={refreshAll}
            aria-label='Refresh'
          >
            <RefreshCw
              className={cn(
                'h-3.5 w-3.5',
                tab === 'runs' && runsQuery.isFetching && 'motion-safe:animate-spin'
              )}
            />
          </Button>
          {isAdmin && tab === 'runs' && (
            <Button size='sm' className='h-7' onClick={() => setNewOpen(true)}>
              <Plus className='h-3.5 w-3.5' />
              New import
            </Button>
          )}
        </div>
      </div>

      {actionError && (
        <p className='flex items-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400'>
          <AlertTriangle className='h-3.5 w-3.5 shrink-0' />
          {actionError}
        </p>
      )}

      {tab === 'collection' ? (
        <CollectionImportPanel initialJobId={initialJobId} onJobOpen={onJobOpen} />
      ) : tab === 'definitions' ? (
        <DefinitionsPanel
          definitions={definitions}
          runCounts={runCounts}
          isLoading={definitionsQuery.isLoading}
        />
      ) : (
        <>
          {leadRun && (
            <LiveRunBanner
              run={leadRun}
              queuedCount={queuedCount}
              stage={stages[leadRun.id] ?? null}
              canManage={isAdmin}
              onOpen={() => setOpenRunId(leadRun.id)}
              onCancel={() => cancel.mutate(leadRun.id)}
            />
          )}

          {/* ── Insight strip. Left half filters, right half reports. ────── */}
          <div className='flex flex-wrap items-stretch divide-x divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card'>
            <StatusSegment
              label='All'
              count={stats?.total ?? null}
              active={status === 'all'}
              onClick={() => setStatus('all')}
            />
            {RUN_STATUSES.map((s) => (
              <StatusSegment
                key={s}
                label={STATUS_STYLE[s].label}
                status={s}
                count={statsTiles[s] ?? 0}
                active={status === s}
                onClick={() => setStatus(status === s ? 'all' : s)}
              />
            ))}
            <div className='ml-auto flex items-stretch divide-x divide-slate-200 dark:divide-border'>
              <InsightTile
                label='Success rate'
                value={
                  stats?.success_rate == null ? '—' : `${Math.round(stats.success_rate * 100)}%`
                }
                sub='of finished runs'
              />
              <InsightTile
                label='Rows imported'
                value={stats ? formatNumber(stats.rows_imported) : '—'}
              />
              <InsightTile
                label='Median run'
                value={formatDuration(stats?.median_duration)}
                sub='completed runs'
              />
              <div className='flex items-center gap-0.5 px-2.5 py-2'>
                {WINDOWS.map((w) => (
                  <button
                    key={w.value}
                    type='button'
                    onClick={() => setWindowDays(w.value)}
                    className={cn(
                      'rounded px-1.5 py-1 text-[11px] font-medium transition-colors',
                      windowDays === w.value
                        ? 'bg-nvr-cyan/15 text-nvr-navy dark:bg-nvr-cyan/20 dark:text-nvr-cyan'
                        : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted'
                    )}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {noHistory ? (
            <div className='rounded-lg border border-dashed border-slate-300 bg-white px-6 py-12 dark:border-border dark:bg-card'>
              <div className='max-w-[58ch]'>
                <Upload className='h-5 w-5 text-slate-300' />
                <h3 className='mt-3 text-[15px] font-semibold text-slate-900 dark:text-foreground'>
                  No imports have run yet
                </h3>
                <p className='mt-1.5 text-[12.5px] leading-relaxed text-slate-500 dark:text-muted-foreground'>
                  An import reads a file and brings its rows into the records it is defined for.
                  Runs are queued here and picked up by the worker within a few seconds, one at a
                  time.
                </p>
                {isAdmin && (
                  <div className='mt-4 flex items-center gap-2'>
                    <Button size='sm' onClick={() => setNewOpen(true)}>
                      <Plus className='h-3.5 w-3.5' /> Queue an import
                    </Button>
                    {definitions.length === 0 && (
                      <Button variant='ghost' size='sm' onClick={() => setTab('definitions')}>
                        Define one first
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className='flex min-h-0 flex-1 flex-col gap-2'>
              {emptyWindow && (
                <p className='flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-[12px] text-slate-600 dark:border-border dark:bg-card dark:text-muted-foreground'>
                  Nothing ran in this window. All {formatNumber(stats?.all_time_total ?? 0)} runs on
                  record are older than it.
                  <button
                    type='button'
                    onClick={() => setWindowDays('0')}
                    className='font-medium text-nvr-navy underline underline-offset-2 dark:text-nvr-cyan'
                  >
                    Show all time
                  </button>
                </p>
              )}
              <DataTable<ImportRun>
                columns={columns}
                rows={runs}
                rowKey={(r) => String(r.id)}
                total={runsQuery.data?.total ?? 0}
                page={page}
                limit={PAGE_SIZE}
                onPageChange={setPage}
                isLoading={runsQuery.isLoading}
                isError={runsQuery.isError}
                errorMessage='Those runs could not be loaded.'
                searchValue={search}
                onSearchChange={setSearch}
                searchPlaceholder='Search imports, files, run ids…'
                filterDefs={[
                  {
                    key: 'key',
                    // No explicit "all" entry: FilterControl renders the
                    // placeholder as its own clear-selection item, and a second
                    // option with an empty value is what Radix rejects.
                    placeholder: 'All imports',
                    options: definitions.map((d) => ({ label: definitionTitle(d), value: d.key }))
                  }
                ]}
                filterValues={{ key: importKey }}
                onFilterChange={(_k, v) => setImportKey(Array.isArray(v) ? (v[0] ?? '') : v)}
                onRowClick={(r) => setOpenRunId(r.id)}
                nowrapCells
                minBodyHeight={280}
                emptyMessage={
                  filtersActive
                    ? 'No runs match these filters.'
                    : 'No runs in this window — widen it above.'
                }
                rowClassName={(r) =>
                  r.status === 'running' ? 'bg-nvr-cyan/5 dark:bg-nvr-cyan/10' : undefined
                }
                toolbarRight={
                  filtersActive ? (
                    <Button
                      variant='ghost'
                      size='sm'
                      className='h-7 px-2 text-[12px]'
                      onClick={() => {
                        setStatus('all')
                        setImportKey('')
                        setSearch('')
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : undefined
                }
              />
            </div>
          )}
        </>
      )}

      <RunDetailSheet
        run={openRun}
        runId={openRunId}
        stage={openRunId != null ? (stages[openRunId] ?? null) : null}
        isAdmin={isAdmin}
        onClose={() => setOpenRunId(null)}
        onRequeue={(id) => requeue.mutate(id)}
        onCancel={(id) => cancel.mutate(id)}
      />

      {isAdmin && (
        <NewImportDialog
          open={newOpen}
          onOpenChange={setNewOpen}
          definitions={definitions.filter((d) => d.is_active)}
          runCounts={runCounts}
          onQueued={(id) => {
            refreshAll()
            setOpenRunId(id)
          }}
        />
      )}
    </div>
  )
}
