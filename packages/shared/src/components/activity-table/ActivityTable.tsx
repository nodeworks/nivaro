import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Columns3,
  Download,
  Layers,
  Loader2,
  Rows3,
  Rows4,
  Search,
  X
} from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from 'react'
import { toast } from 'sonner'
import { useApiFetchConfig, useNivaroClient } from '../../context'
import {
  type ActivityLabels,
  collectionNouns,
  fieldLabel,
  renderActivitySentence
} from '../../lib/activity-sentence'
import {
  type ActivityTableFilters,
  type ActivityTableState,
  COLUMN_WORDS,
  mergeLocked,
  nextTableSort,
  OPTIONAL_COLUMNS,
  type OptionalColumn,
  pageRangeText,
  sortOf,
  TABLE_PAGE_SIZES,
  type TableSortKey,
  tableFilterParams
} from '../../lib/activity-table'
import { get } from '../../lib/commands'
import { toastError } from '../../lib/error-toast'
import { followExportRun, isStartedExportRun } from '../../lib/export-runs'
import { useBelowMd } from '../../lib/use-below-md'
import { cn, formatDate, formatNumber } from '../../lib/utils'
import { useActivityLabels } from '../ActivityEntry'
import { ErrorNotice } from '../ErrorNotice'
import { UndoButton } from '../UndoButton'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { SimpleSelect } from '../ui/SimpleSelect'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../ui/sheet'
import { type ActivityDrillTarget, ActivityEntryDetail, EntryStepper } from './ActivityEntryDetail'
import { ActivityFilterBar } from './FilterBar'
import { ActionLabel, RecordLink, RequestCell, sourceWords, WhenText, WhoCell } from './parts'
import type { ActivityFacets, ActivityTablePage, ActivityTableRow } from './types'

/**
 * The Activity log as a table (GET /api/activity/table): one row per entry, sortable on the
 * server, filters as chips with counts, bulk changes folded into one row that opens to its
 * members, a column picker, two densities, CSV export of the filtered set (the audit CSV —
 * big ones run in the background with progress in the Jobs tray), paging on the server and
 * arrow-key rows. A row opens the entry to its last leaf (ActivityEntryDetail) in a drawer,
 * or — with `onOpenEntry` — wherever the host shows it (the Overview's drill sheet).
 *
 * State is the host's (`state` / `onStateChange`): the admin Activity page keeps it in the
 * URL, a sheet keeps it in its own. `locked` is a preset the person cannot remove (shown as
 * locked chips) — e.g. "today, record changes only".
 */

const DENSITY_KEY = (k: string) => `nvr:${k}:density`
const COLS_KEY = (k: string) => `nvr:${k}:cols`

function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function writePref(key: string, v: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* private window: the choice lasts this visit */
  }
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className
}: {
  label: string
  sortKey?: TableSortKey
  sort: string
  onSort: (s: string) => void
  className?: string
}) {
  const s = sortOf(sort)
  const active = !!sortKey && s.key === sortKey
  const aria = active ? (s.dir === 'desc' ? 'descending' : 'ascending') : 'none'
  return (
    <th
      scope='col'
      aria-sort={sortKey ? aria : undefined}
      className={cn(
        'sticky top-0 z-10 whitespace-nowrap border-b border-slate-200 bg-slate-50/95 px-3 py-2 text-left text-[11.5px] font-medium text-slate-500 backdrop-blur-sm dark:border-border dark:bg-[#111827]/95 dark:text-slate-400',
        className
      )}
    >
      {sortKey ? (
        <button
          type='button'
          onClick={() => onSort(nextTableSort(sort, sortKey))}
          className={cn(
            'group inline-flex items-center gap-1 rounded hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:hover:text-slate-100',
            active && 'text-slate-900 dark:text-slate-100'
          )}
        >
          {label}
          {active ? (
            s.dir === 'desc' ? (
              <ArrowDown className='h-3 w-3' aria-hidden />
            ) : (
              <ArrowUp className='h-3 w-3' aria-hidden />
            )
          ) : (
            <ArrowDown
              className='h-3 w-3 opacity-0 transition-opacity group-hover:opacity-40'
              aria-hidden
            />
          )}
        </button>
      ) : (
        label
      )}
    </th>
  )
}

function FieldsCell({
  row,
  labels,
  onPick
}: {
  row: ActivityTableRow
  labels?: ActivityLabels | null
  onPick: (field: string) => void
}) {
  const fields = row.fields_changed ?? []
  if (fields.length === 0) return <span className='text-slate-400 dark:text-slate-500'>—</span>
  const shown = fields.slice(0, 2)
  const rest = fields.length - shown.length
  return (
    <span
      className='flex min-w-0 items-center gap-1'
      data-tip={fields.map((f) => fieldLabel(row.collection, f, labels)).join(', ')}
    >
      {shown.map((f) => (
        <button
          key={f}
          type='button'
          onClick={(e) => {
            e.stopPropagation()
            onPick(f)
          }}
          className='max-w-[110px] truncate rounded bg-slate-100 px-1.5 py-px text-[11.5px] text-slate-700 hover:bg-nvr-cyan/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:bg-white/[0.06] dark:text-slate-200'
          aria-label={`Only entries that changed ${fieldLabel(row.collection, f, labels)}`}
        >
          {fieldLabel(row.collection, f, labels)}
        </button>
      ))}
      {rest > 0 && (
        <span className='shrink-0 text-[11px] tabular-nums text-slate-500 dark:text-slate-400'>
          +{rest}
        </span>
      )}
    </span>
  )
}

function useLabelsFor(rows: ActivityTableRow[]) {
  // Every changed field's label (the page's sentences only name the first few).
  const forLabels = useMemo(
    () => rows.map((r) => ({ ...r, changed_fields: [...(r.fields_changed ?? [])] })),
    [rows]
  )
  return useActivityLabels(forLabels)
}

function GroupMembers({
  row,
  params,
  columns,
  onOpen,
  compact
}: {
  row: ActivityTableRow
  params: Record<string, string>
  columns: Set<OptionalColumn>
  onOpen: (id: number) => void
  compact: boolean
}) {
  const client = useNivaroClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['activity-table-group', row.group_key, params],
    queryFn: async () =>
      (await client.request(
        get<ActivityTablePage>('/activity/table', {
          ...params,
          group_key: row.group_key,
          fold: '0',
          limit: 50
        })
      )) as ActivityTablePage,
    staleTime: 30_000
  })
  const members = (data?.data ?? []).filter((m) => m.id !== row.id)
  const labels = useLabelsFor(members)
  const span = 5 + columns.size
  if (isLoading || error)
    return (
      <tr>
        <td
          colSpan={span}
          className='bg-slate-50/60 px-12 py-2 text-[12px] text-slate-500 dark:bg-white/[0.02]'
        >
          {isLoading ? (
            <span className='inline-flex items-center gap-2'>
              <Loader2 className='h-3.5 w-3.5 animate-spin' aria-hidden /> Reading the rest of this
              run…
            </span>
          ) : (
            <ErrorNotice error={error} what='this run' />
          )}
        </td>
      </tr>
    )
  return (
    <>
      {members.map((m) => (
        <tr
          key={m.id}
          onClick={() => onOpen(m.id)}
          className='nvr-expand-in cursor-pointer bg-slate-50/70 text-slate-600 hover:bg-slate-100 dark:bg-white/[0.02] dark:text-slate-300 dark:hover:bg-white/[0.05]'
          data-activity-member={m.id}
        >
          <td className={cn('pl-8 pr-3 text-[11.5px] text-slate-500', compact ? 'py-1' : 'py-1.5')}>
            <WhenText at={m.timestamp} />
          </td>
          <td className='px-3' colSpan={2}>
            <span className='line-clamp-1 text-[12px]'>{renderActivitySentence(m, labels)}</span>
          </td>
          {columns.has('collection') && <td className='px-3' />}
          <td className='px-3'>
            <RecordLink row={m} labels={labels} />
          </td>
          {columns.has('fields') && (
            <td className='px-3 text-[11.5px] text-slate-500'>
              {(m.fields_changed ?? [])
                .map((f) => fieldLabel(m.collection, f, labels))
                .join(', ') || '—'}
            </td>
          )}
          {columns.has('source') && <td className='px-3' />}
          {columns.has('request') && <td className='px-3' />}
          <td />
        </tr>
      ))}
      {(data?.has_more || (data?.total ?? 0) > (data?.data.length ?? 0)) && (
        <tr>
          <td
            colSpan={span}
            className='bg-slate-50/70 py-1.5 pl-8 text-[11.5px] text-slate-500 dark:bg-white/[0.02]'
          >
            Showing the newest {formatNumber(data?.data.length ?? 0)} of{' '}
            {formatNumber(data?.total ?? 0)} — open the entry and choose “See all” for the rest.
          </td>
        </tr>
      )}
    </>
  )
}

export interface ActivityTableProps {
  state: ActivityTableState
  onStateChange: (next: ActivityTableState) => void
  /** Preset filters the person cannot remove (shown locked). */
  locked?: ActivityTableFilters
  /** Before the chips (the host's own search). Absent = a plain text search box. */
  toolbarStart?: ReactNode
  /** After the chips (saved views). */
  toolbarEnd?: ReactNode
  /** Remember columns + density under this key (localStorage). */
  storageKey?: string
  /** Open an entry somewhere else instead of the built-in drawer. */
  onOpenEntry?: (id: number) => void
  /** Show a person / record / run (the built-in drawer's links). Default: filter this table. */
  onDrill?: (t: ActivityDrillTarget) => void
  /** Hide the CSV export (e.g. inside a small sheet). */
  noExport?: boolean
  className?: string
}

export function ActivityTable({
  state,
  onStateChange,
  locked,
  toolbarStart,
  toolbarEnd,
  storageKey = 'activity-table',
  onOpenEntry,
  onDrill,
  noExport,
  className
}: ActivityTableProps) {
  const client = useNivaroClient()
  const fetchCfg = useApiFetchConfig()
  const phone = useBelowMd()
  const set = useCallback(
    (patch: Partial<ActivityTableState>) => onStateChange({ ...state, ...patch }),
    [state, onStateChange]
  )
  const effective = useMemo(() => mergeLocked(state.filters, locked), [state.filters, locked])
  const filterParams = useMemo(() => tableFilterParams(effective), [effective])
  const params = useMemo(
    () => ({
      ...filterParams,
      sort: state.sort,
      limit: String(state.pageSize),
      offset: String((state.page - 1) * state.pageSize),
      fold: state.fold ? '1' : '0'
    }),
    [filterParams, state.sort, state.pageSize, state.page, state.fold]
  )

  const page = useQuery({
    queryKey: ['activity-table', params],
    queryFn: async () =>
      (await client.request(
        get<ActivityTablePage>('/activity/table', params)
      )) as ActivityTablePage,
    placeholderData: keepPreviousData,
    staleTime: 15_000
  })
  const rows = page.data?.data ?? []
  const labels = useLabelsFor(rows)

  const [facetsWanted, setFacetsWanted] = useState(false)
  const facets = useQuery({
    queryKey: ['activity-table-facets', filterParams],
    queryFn: async () =>
      (
        (await client.request(
          get<{ data: ActivityFacets }>('/activity/table/facets', filterParams)
        )) as {
          data: ActivityFacets
        }
      ).data,
    enabled: facetsWanted,
    staleTime: 60_000,
    placeholderData: keepPreviousData
  })

  // Columns + density: per person, per browser.
  const [cols, setCols] = useState<Set<OptionalColumn>>(
    () => new Set(readPref<OptionalColumn[]>(COLS_KEY(storageKey), [...OPTIONAL_COLUMNS]))
  )
  const [density, setDensity] = useState<'comfortable' | 'compact'>(() =>
    readPref(DENSITY_KEY(storageKey), 'comfortable')
  )
  const compact = density === 'compact'
  const toggleCol = (c: OptionalColumn) => {
    const next = new Set(cols)
    if (next.has(c)) next.delete(c)
    else next.add(c)
    setCols(next)
    writePref(COLS_KEY(storageKey), [...next])
  }

  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const toggleGroup = (id: number) =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  // Keyboard rows: one tab stop, arrows move, Enter opens, → / ← open and close a run.
  const [active, setActive] = useState(0)
  const bodyRef = useRef<HTMLTableSectionElement | null>(null)
  // A new read starts the keyboard back at the first row.
  const [activeFor, setActiveFor] = useState(params)
  if (activeFor !== params) {
    setActiveFor(params)
    setActive(0)
  }
  const colsId = useId()
  const focusRow = (i: number) => {
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-row-index="${i}"]`)
    el?.focus()
  }
  const open = (id: number) => (onOpenEntry ? onOpenEntry(id) : set({ entry: id }))
  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, i: number, r: ActivityTableRow) => {
    if (e.key === 'ArrowDown' && i < rows.length - 1) {
      e.preventDefault()
      setActive(i + 1)
      focusRow(i + 1)
    } else if (e.key === 'ArrowUp' && i > 0) {
      e.preventDefault()
      setActive(i - 1)
      focusRow(i - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      open(r.id)
    } else if (e.key === 'ArrowRight' && (r.group_count ?? 0) > 1 && !expanded.has(r.id)) {
      toggleGroup(r.id)
    } else if (e.key === 'ArrowLeft' && expanded.has(r.id)) {
      toggleGroup(r.id)
    }
  }

  const drill = (t: ActivityDrillTarget) => {
    if (onDrill) return onDrill(t)
    const f: ActivityTableFilters = { ...state.filters }
    if (t.person) {
      f.user = null
      f.users = [t.person]
    }
    if (t.record) {
      f.collections = [t.record.collection]
      f.item = t.record.item
    }
    if (t.group_key) f.group_key = t.group_key
    onStateChange({ ...state, filters: f, page: 1, entry: null })
  }

  const [exporting, setExporting] = useState(false)
  const exportCsv = async () => {
    setExporting(true)
    try {
      let tz: string | undefined
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      } catch {
        tz = undefined
      }
      const qs = new URLSearchParams({
        ...filterParams,
        format: 'csv',
        readable: '1',
        background: 'auto',
        ...(tz ? { tz } : {})
      })
      const res = await fetch(`${fetchCfg.apiBase}/reports/activity?${qs}`, {
        headers: fetchCfg.authHeaders,
        credentials: fetchCfg.credentials
      })
      if (res.status === 202) {
        const body = (await res.json().catch(() => ({}))) as { data?: unknown }
        if (isStartedExportRun(body.data)) {
          followExportRun(body.data, {
            read: () =>
              fetch(`${fetchCfg.apiBase}/export-runs/${(body.data as { run_id: number }).run_id}`, {
                headers: fetchCfg.authHeaders,
                credentials: fetchCfg.credentials
              })
                .then((r) => r.json())
                .then((j) => (j as { data?: never }).data ?? null)
          })
          return
        }
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw Object.assign(new Error('export failed'), {
          response: { status: res.status, data: body }
        })
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `activity-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
      const n = Number(res.headers.get('x-export-rows') ?? 0)
      if (res.headers.get('x-export-truncated') === '1')
        toast.message(`Exported the newest ${formatNumber(n)} entries`, {
          description: 'Narrow the dates to export the rest.'
        })
      else toast.success(`Exported ${formatNumber(n)} ${n === 1 ? 'entry' : 'entries'}`)
    } catch (err) {
      toastError(err, 'Could not export the activity log', { retry: () => void exportCsv() })
    } finally {
      setExporting(false)
    }
  }

  const fieldSuggestions = useMemo(
    () =>
      rows.flatMap((r) =>
        (r.fields_changed ?? []).map((f) => ({ collection: r.collection, field: f }))
      ),
    [rows]
  )
  const [qDraft, setQDraft] = useState(state.filters.q ?? '')
  useEffect(() => setQDraft(state.filters.q ?? ''), [state.filters.q])

  const index = state.entry != null ? rows.findIndex((r) => r.id === state.entry) : -1
  const total = page.data?.total ?? null
  const hasMore = !!page.data?.has_more
  const sort = state.sort
  const setSort = (s: string) => set({ sort: s, page: 1 })
  const cellY = compact ? 'py-1' : 'py-2'

  const toolbar = (
    <div className='flex flex-col gap-2 border-b border-slate-200 px-3 py-2.5 dark:border-border'>
      <div className='flex flex-wrap items-center gap-2'>
        {toolbarStart ? (
          <div className='flex min-w-0 basis-full sm:basis-auto sm:flex-1'>{toolbarStart}</div>
        ) : (
          <form
            className='relative min-w-[180px] flex-1 sm:max-w-xs'
            onSubmit={(e) => {
              e.preventDefault()
              set({ filters: { ...state.filters, q: qDraft.trim() || null }, page: 1 })
            }}
          >
            <Search
              className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400'
              aria-hidden
            />
            <input
              value={qDraft}
              onChange={(e) => setQDraft(e.target.value)}
              placeholder='Search notes, ids, people…'
              aria-label='Search activity'
              className='h-8 w-full rounded-md border border-slate-200 bg-transparent pl-8 pr-7 text-[12.5px] placeholder:text-slate-400 focus-visible:border-nvr-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/30 dark:border-border'
            />
            {qDraft && (
              <button
                type='button'
                aria-label='Clear search'
                onClick={() => {
                  setQDraft('')
                  set({ filters: { ...state.filters, q: null }, page: 1 })
                }}
                className='absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-slate-400 hover:text-slate-700'
              >
                <X className='h-3 w-3' />
              </button>
            )}
          </form>
        )}
        <div className='ml-auto flex items-center gap-1'>
          {toolbarEnd}
          <button
            type='button'
            aria-pressed={state.fold}
            onClick={() => set({ fold: !state.fold, page: 1 })}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60',
              state.fold
                ? 'border-slate-200 bg-white text-slate-700 dark:border-border dark:bg-card dark:text-slate-200'
                : 'border-slate-200 text-slate-500 dark:border-border dark:text-slate-400'
            )}
            data-tip={
              state.fold
                ? 'Bulk changes show as one row — click to list every entry'
                : 'Every entry listed — click to fold bulk changes into one row'
            }
          >
            <Layers className='h-3.5 w-3.5' aria-hidden />
            <span className='hidden sm:inline'>{state.fold ? 'Runs folded' : 'Every entry'}</span>
          </button>
          <button
            type='button'
            onClick={() => {
              const next = compact ? 'comfortable' : 'compact'
              setDensity(next)
              writePref(DENSITY_KEY(storageKey), next)
            }}
            aria-label={compact ? 'Roomier rows' : 'Tighter rows'}
            data-tip={compact ? 'Roomier rows' : 'Tighter rows'}
            className='inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:border-border dark:text-slate-300 dark:hover:bg-white/[0.04]'
          >
            {compact ? <Rows3 className='h-3.5 w-3.5' /> : <Rows4 className='h-3.5 w-3.5' />}
          </button>
          {!phone && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  aria-label='Columns'
                  data-tip='Columns'
                  className='inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:border-border dark:text-slate-300 dark:hover:bg-white/[0.04]'
                >
                  <Columns3 className='h-3.5 w-3.5' />
                </button>
              </PopoverTrigger>
              <PopoverContent align='end' className='w-52 p-1.5'>
                <p className='px-2 py-1 text-[11px] font-medium text-slate-500'>Show columns</p>
                {OPTIONAL_COLUMNS.map((c) => (
                  <div
                    key={c}
                    className='flex items-center gap-2 rounded px-2 py-1.5 text-[12.5px] hover:bg-muted'
                  >
                    <Checkbox
                      id={`${colsId}-${c}`}
                      checked={cols.has(c)}
                      onCheckedChange={() => toggleCol(c)}
                    />
                    <label htmlFor={`${colsId}-${c}`} className='flex-1 cursor-pointer'>
                      {COLUMN_WORDS[c]}
                    </label>
                  </div>
                ))}
              </PopoverContent>
            </Popover>
          )}
          {!noExport && (
            <Button
              variant='outline'
              size='sm'
              className='h-8 gap-1.5 text-[12px]'
              onClick={() => void exportCsv()}
              disabled={exporting || rows.length === 0}
            >
              {exporting ? (
                <Loader2 className='h-3.5 w-3.5 animate-spin' />
              ) : (
                <Download className='h-3.5 w-3.5' />
              )}
              <span className='hidden sm:inline'>CSV</span>
            </Button>
          )}
        </div>
      </div>
      <ActivityFilterBar
        filters={state.filters}
        locked={locked}
        onChange={(f) => set({ filters: f, page: 1, entry: null })}
        facets={facets.data}
        facetsLoading={facets.isFetching}
        onFacetsWanted={() => setFacetsWanted(true)}
        labels={labels}
        fieldSuggestions={fieldSuggestions}
      />
      {(page.data?.window_from || (facets.data?.defaulted && facetsWanted)) && (
        <p className='text-[11.5px] text-slate-500 dark:text-slate-400'>
          {page.data?.window_from
            ? `This read goes back to ${formatDate(page.data.window_from)} — pick dates to read further.`
            : `Counts cover the last 7 days — pick dates to count further.`}
        </p>
      )}
    </div>
  )

  const empty = (
    <div className='nvr-rise-in px-6 py-14 text-center'>
      <p className='text-[13px] font-medium text-slate-700 dark:text-slate-200'>
        Nothing matches these filters
      </p>
      <p className='mt-1 text-[12px] text-slate-500 dark:text-slate-400'>
        Widen the dates or clear a chip — each chip lists what the others leave.
      </p>
    </div>
  )

  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card',
        className
      )}
      data-activity-table
    >
      {toolbar}
      <div
        className='relative min-h-0 flex-1 overflow-auto'
        aria-busy={page.isFetching || undefined}
      >
        {page.isLoading ? (
          <div className='space-y-2 p-3' aria-busy>
            {Array.from({ length: 10 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
              <div key={i} className='flex items-center gap-3'>
                <div className='h-3 w-16 animate-pulse rounded bg-slate-100 dark:bg-white/5' />
                <div className='h-6 w-6 animate-pulse rounded-full bg-slate-100 dark:bg-white/5' />
                <div className='h-3 flex-1 animate-pulse rounded bg-slate-100 dark:bg-white/5' />
              </div>
            ))}
          </div>
        ) : page.error && !page.data ? (
          <div className='p-4'>
            <ErrorNotice
              error={page.error}
              what='the activity log'
              onRetry={() => void page.refetch()}
            />
          </div>
        ) : rows.length === 0 ? (
          empty
        ) : phone ? (
          <ul
            className={cn(
              'divide-y divide-slate-100 dark:divide-border',
              page.isPlaceholderData && 'opacity-60'
            )}
          >
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type='button'
                  onClick={() => open(r.id)}
                  className='flex w-full flex-col gap-1 px-3 py-2.5 text-left hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none dark:hover:bg-white/[0.04]'
                >
                  <span className='flex items-center justify-between gap-2 text-[11.5px] text-slate-500 dark:text-slate-400'>
                    <WhoCell row={r} labels={labels} compact />
                    <WhenText at={r.timestamp} className='shrink-0' />
                  </span>
                  <span className='text-[13px] leading-snug text-slate-800 dark:text-slate-100'>
                    {renderActivitySentence(r, labels)}
                  </span>
                  {(r.group_count ?? 0) > 1 && (
                    <span className='text-[11.5px] text-slate-500'>
                      One of {formatNumber(r.group_count ?? 0)} written together
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <table
            className={cn(
              'w-full min-w-[860px] border-separate border-spacing-0 text-[12.5px] transition-opacity',
              page.isPlaceholderData && 'opacity-60'
            )}
          >
            <thead>
              <tr>
                <SortHeader
                  label='When'
                  sortKey='when'
                  sort={sort}
                  onSort={setSort}
                  className='w-[112px] pl-4'
                />
                <SortHeader
                  label='Who'
                  sortKey='user'
                  sort={sort}
                  onSort={setSort}
                  className='w-[200px]'
                />
                <SortHeader
                  label='Action'
                  sortKey='action'
                  sort={sort}
                  onSort={setSort}
                  className='w-[140px]'
                />
                {cols.has('collection') && (
                  <SortHeader
                    label='Collection'
                    sortKey='collection'
                    sort={sort}
                    onSort={setSort}
                    className='w-[140px]'
                  />
                )}
                <SortHeader label='Record' sortKey='item' sort={sort} onSort={setSort} />
                {cols.has('fields') && (
                  <SortHeader
                    label='Fields changed'
                    sort={sort}
                    onSort={setSort}
                    className='w-[210px]'
                  />
                )}
                {cols.has('source') && (
                  <SortHeader label='Source' sort={sort} onSort={setSort} className='w-[150px]' />
                )}
                {cols.has('request') && (
                  <SortHeader label='Request' sort={sort} onSort={setSort} className='w-[110px]' />
                )}
                <th
                  scope='col'
                  className='sticky top-0 z-10 w-[72px] border-b border-slate-200 bg-slate-50/95 dark:border-border dark:bg-[#111827]/95'
                >
                  <span className='sr-only'>Undo</span>
                </th>
              </tr>
            </thead>
            <tbody ref={bodyRef}>
              {rows.map((r, i) => {
                const runs = (r.group_count ?? 0) > 1
                const isOpen = expanded.has(r.id)
                const current = state.entry === r.id
                return (
                  <FragmentRow key={r.id}>
                    <tr
                      data-row-index={i}
                      data-activity-row={r.id}
                      tabIndex={i === active ? 0 : -1}
                      aria-current={current || undefined}
                      onFocus={() => setActive(i)}
                      onKeyDown={(e) => onRowKey(e, i, r)}
                      onClick={() => open(r.id)}
                      className={cn(
                        'group cursor-pointer outline-none transition-colors [&>td]:border-b [&>td]:border-slate-100 dark:[&>td]:border-border',
                        current
                          ? 'bg-nvr-cyan/[0.07] dark:bg-nvr-cyan/[0.09]'
                          : 'hover:bg-slate-50 dark:hover:bg-white/[0.03]',
                        'focus-visible:bg-slate-50 focus-visible:[&>td:first-child]:shadow-[inset_2px_0_0_0_rgb(var(--nvr-cyan-rgb,0_206_255))] dark:focus-visible:bg-white/[0.04]'
                      )}
                    >
                      <td
                        className={cn(
                          'whitespace-nowrap pl-2 pr-3 text-slate-500 dark:text-slate-400',
                          cellY
                        )}
                      >
                        <span className='flex items-center gap-1'>
                          {runs ? (
                            <button
                              type='button'
                              aria-expanded={isOpen}
                              aria-label={
                                isOpen
                                  ? 'Hide the rest of this run'
                                  : `Show the other ${formatNumber((r.group_count ?? 1) - 1)} entries of this run`
                              }
                              onClick={(e) => {
                                e.stopPropagation()
                                toggleGroup(r.id)
                              }}
                              className='flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:hover:bg-white/10 dark:hover:text-slate-100'
                            >
                              <ChevronRight
                                className={cn(
                                  'h-3.5 w-3.5 transition-transform duration-200',
                                  isOpen && 'rotate-90'
                                )}
                              />
                            </button>
                          ) : (
                            <span className='w-5 shrink-0' aria-hidden />
                          )}
                          <WhenText at={r.timestamp} />
                        </span>
                      </td>
                      <td className={cn('max-w-[220px] px-3', cellY)}>
                        <WhoCell row={r} labels={labels} compact={compact} />
                      </td>
                      <td className={cn('px-3', cellY)}>
                        <span className='flex items-center gap-1.5'>
                          <ActionLabel action={r.action} />
                          {runs && (
                            <span
                              className='shrink-0 rounded-full bg-slate-100 px-1.5 text-[10.5px] font-medium tabular-nums text-slate-600 dark:bg-white/[0.08] dark:text-slate-300'
                              data-tip={`${formatNumber(r.group_count ?? 0)} entries written together`}
                            >
                              ×{formatNumber(r.group_count ?? 0)}
                            </span>
                          )}
                        </span>
                      </td>
                      {cols.has('collection') && (
                        <td
                          className={cn(
                            'max-w-[160px] truncate px-3 text-slate-600 dark:text-slate-300',
                            cellY
                          )}
                        >
                          {r.collection ? collectionNouns(r.collection, labels).plural : '—'}
                        </td>
                      )}
                      <td className={cn('max-w-[280px] px-3', cellY)}>
                        <span className='flex min-w-0'>
                          <RecordLink row={r} labels={labels} />
                        </span>
                      </td>
                      {cols.has('fields') && (
                        <td className={cn('max-w-[230px] px-3', cellY)}>
                          <FieldsCell
                            row={r}
                            labels={labels}
                            onPick={(f) =>
                              set({
                                filters: {
                                  ...state.filters,
                                  fields: [...new Set([...(state.filters.fields ?? []), f])]
                                },
                                page: 1
                              })
                            }
                          />
                        </td>
                      )}
                      {cols.has('source') && (
                        <td
                          className={cn(
                            'max-w-[160px] truncate px-3 text-slate-600 dark:text-slate-300',
                            cellY
                          )}
                        >
                          {sourceWords(r)}
                        </td>
                      )}
                      {cols.has('request') && (
                        <td className={cn('px-3', cellY)}>
                          <RequestCell request={r.request} />
                        </td>
                      )}
                      <td
                        className={cn('pr-3 text-right', cellY)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <span className='invisible group-hover:visible group-focus-within:visible'>
                          <UndoButton activityId={r.id} />
                        </span>
                      </td>
                    </tr>
                    {runs && isOpen && (
                      <GroupMembers
                        row={r}
                        params={filterParams}
                        columns={cols}
                        onOpen={open}
                        compact={compact}
                      />
                    )}
                  </FragmentRow>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      {rows.length > 0 && (
        <div className='flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-3 py-2 text-[12px] text-slate-600 dark:border-border dark:text-slate-300'>
          <span className='tabular-nums'>
            {pageRangeText({
              page: state.page,
              pageSize: state.pageSize,
              shown: rows.length,
              total,
              hasMore
            })}
            {state.fold && total != null && (
              <span className='text-slate-400'> entries · runs folded</span>
            )}
          </span>
          <div className='flex items-center gap-2'>
            <SimpleSelect
              value={String(state.pageSize)}
              onChange={(v) => set({ pageSize: Number(v), page: 1 })}
              options={TABLE_PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} a page` }))}
              ariaLabel='Rows a page'
              className='h-7 w-[104px] text-[12px]'
            />
            <Button
              variant='outline'
              size='sm'
              className='h-7'
              disabled={state.page <= 1}
              onClick={() => set({ page: state.page - 1 })}
            >
              Previous
            </Button>
            <Button
              variant='outline'
              size='sm'
              className='h-7'
              disabled={!hasMore}
              onClick={() => set({ page: state.page + 1 })}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {!onOpenEntry && (
        <Sheet open={state.entry != null} onOpenChange={(o) => !o && set({ entry: null })}>
          <SheetContent side='right' className='w-full overflow-y-auto p-0 sm:max-w-xl'>
            <div className='sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-slate-100 bg-background/95 px-5 py-2.5 pr-12 backdrop-blur-sm dark:border-border'>
              <SheetTitle className='text-[13px] font-semibold'>Activity entry</SheetTitle>
              <SheetDescription className='sr-only'>
                Everything this entry recorded
              </SheetDescription>
              <EntryStepper
                position={index >= 0 ? `${index + 1} of ${rows.length}` : undefined}
                onPrev={index > 0 ? () => set({ entry: rows[index - 1].id }) : undefined}
                onNext={
                  index >= 0 && index < rows.length - 1
                    ? () => set({ entry: rows[index + 1].id })
                    : undefined
                }
              />
            </div>
            {state.entry != null && (
              <ActivityEntryDetail
                key={state.entry}
                id={state.entry}
                onOpenEntry={(id) => set({ entry: id })}
                onDrill={drill}
              />
            )}
          </SheetContent>
        </Sheet>
      )}
    </div>
  )
}

function FragmentRow({ children }: { children: ReactNode }) {
  return <>{children}</>
}
