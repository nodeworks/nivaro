import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronsUpDown,
  FileUp,
  Link2,
  Loader2,
  MoreHorizontal,
  Plus,
  Sparkles,
  Trash2,
  Upload
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { del, get, post } from '../../lib/commands'
import { cn, formatDateTime, formatNumber, formatRelative } from '../../lib/utils'
import { type Column, DataTable } from '../DataTable'
import { Button } from '../ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { SimpleSelect } from '../ui/SimpleSelect'
import { Sheet, SheetContent } from '../ui/sheet'
import { Textarea } from '../ui/textarea'
import type { ImportJob, ImportJobStatus } from './types'

const PAGE_SIZE = 25
const STEPS = ['Source', 'Map columns', 'Options', 'Confirm']

const JOB_STATUS: Record<ImportJobStatus, { dot: string; text: string; label: string }> = {
  pending: { dot: 'bg-slate-400', text: 'text-slate-600 dark:text-slate-300', label: 'Pending' },
  processing: {
    dot: 'bg-nvr-cyan',
    text: 'text-[#0284a8] dark:text-nvr-cyan',
    label: 'Processing'
  },
  complete: {
    dot: 'bg-emerald-500',
    text: 'text-emerald-700 dark:text-emerald-400',
    label: 'Complete'
  },
  failed: { dot: 'bg-red-500', text: 'text-red-700 dark:text-red-400', label: 'Failed' }
}

function JobStatusPill({ status }: { status: ImportJobStatus }) {
  const s = JOB_STATUS[status] ?? JOB_STATUS.pending
  return (
    <span className={cn('flex items-center gap-1.5 text-[12px] font-medium', s.text)}>
      <span className='relative flex h-1.5 w-1.5 shrink-0'>
        {status === 'processing' && (
          <span
            className={cn(
              'absolute inline-flex h-full w-full rounded-full opacity-75 motion-safe:animate-ping',
              s.dot
            )}
          />
        )}
        <span className={cn('relative inline-flex h-1.5 w-1.5 rounded-full', s.dot)} />
      </span>
      {s.label}
    </span>
  )
}

function ProgressBar({
  processed,
  total,
  failed
}: {
  processed: number | null
  total: number | null
  failed?: boolean
}) {
  if (!total) return <span className='text-[12px] text-slate-300'>—</span>
  const pct = Math.min(100, Math.round(((processed ?? 0) / total) * 100))
  return (
    <div className='flex min-w-[92px] items-center gap-2'>
      <div className='h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-muted'>
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500',
            failed ? 'bg-red-500' : 'bg-nvr-cyan'
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className='w-8 text-right text-[11px] tabular-nums text-slate-400'>{pct}%</span>
    </div>
  )
}

// ─── CSV parsing (client-side preview; the server re-parses on submit) ──────

function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((c) => c.trim())
}

function parseCsvPreview(csv: string): { headers: string[]; rows: string[][]; rowCount: number } {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length === 0) return { headers: [], rows: [], rowCount: 0 }
  const headers = parseCsvLine(lines[0])
  const rows = lines.slice(1, 6).map(parseCsvLine)
  return { headers, rows, rowCount: Math.max(0, lines.length - 1) }
}

// ─── Combobox (never a native select) ───────────────────────────────────────

function PickCombobox({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  className
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(
            'flex h-8 w-full items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-2.5 text-left text-[12px] transition-colors hover:border-slate-300 dark:border-border dark:bg-card',
            className
          )}
        >
          <span
            className={cn(
              'truncate font-mono',
              current ? 'text-slate-800 dark:text-foreground' : 'text-slate-400'
            )}
          >
            {current?.label ?? placeholder}
          </span>
          <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[240px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty>Nothing matches.</CommandEmpty>
            {options.map((o) => (
              <CommandItem
                key={o.value || '__skip__'}
                value={o.label}
                onSelect={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
                className='text-[12px]'
              >
                <Check
                  className={cn(
                    'h-3.5 w-3.5',
                    o.value === value ? 'text-nvr-cyan opacity-100' : 'opacity-0'
                  )}
                />
                <span className='font-mono'>{o.label}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100)
  const tone =
    pct >= 80
      ? 'text-emerald-700 dark:text-emerald-400'
      : pct >= 50
        ? 'text-amber-700 dark:text-amber-400'
        : 'text-slate-500'
  return (
    <span
      className={cn('shrink-0 text-[10.5px] font-medium tabular-nums', tone)}
      title='AI mapping confidence'
    >
      AI {pct}%
    </span>
  )
}

// ─── Panel ──────────────────────────────────────────────────────────────────

export function CollectionImportPanel({
  initialJobId,
  onJobOpen
}: {
  /** Deep link: open this job's detail on mount. */
  initialJobId?: string | null
  onJobOpen?: (id: string | null) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [mode, setMode] = useState<'list' | 'wizard'>('list')
  const [openJobId, setOpenJobId] = useState<string | null>(initialJobId ?? null)
  const [status, setStatus] = useState<ImportJobStatus | 'all'>('all')
  const [page, setPage] = useState(1)
  const [error, setError] = useState<string | null>(null)

  const jobsQuery = useQuery({
    queryKey: ['collection-import-jobs'],
    // The endpoint returns every job the caller may see, so the counters below
    // are exact rather than page-scoped.
    queryFn: () => client.request(get<{ data: ImportJob[] }>('/imports')),
    refetchInterval: (q) =>
      (q.state.data?.data ?? []).some((j) => j.status === 'pending' || j.status === 'processing')
        ? 3000
        : false,
    placeholderData: (prev) => prev
  })
  const jobs = useMemo(() => jobsQuery.data?.data ?? [], [jobsQuery.data?.data])

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const j of jobs) c[j.status] = (c[j.status] ?? 0) + 1
    return c
  }, [jobs])
  const totals = useMemo(
    () =>
      jobs.reduce(
        (a, j) => ({
          created: a.created + (j.created_rows ?? 0),
          updated: a.updated + (j.updated_rows ?? 0),
          skipped: a.skipped + (j.skipped_rows ?? 0),
          errors: a.errors + (j.error_rows ?? 0)
        }),
        { created: 0, updated: 0, skipped: 0, errors: 0 }
      ),
    [jobs]
  )

  const filtered = status === 'all' ? jobs : jobs.filter((j) => j.status === status)
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  useEffect(() => setPage(1), [status])

  const removeJob = useMutation({
    mutationFn: (id: string) => client.request(del(`/imports/${id}`)),
    onSuccess: () => {
      setError(null)
      void qc.invalidateQueries({ queryKey: ['collection-import-jobs'] })
    },
    onError: (err: Error) => setError(err.message)
  })

  const rollbackJob = useMutation({
    mutationFn: (id: string) => client.request(post(`/imports/${id}/rollback`, {})),
    onSuccess: () => {
      setError(null)
      void qc.invalidateQueries({ queryKey: ['collection-import-jobs'] })
    },
    onError: (err: Error) => setError(err.message)
  })

  function openJob(id: string | null) {
    setOpenJobId(id)
    onJobOpen?.(id)
  }

  const columns: Column<ImportJob>[] = [
    {
      key: 'status',
      header: 'Status',
      className: 'w-[110px]',
      render: (j) => <JobStatusPill status={j.status} />
    },
    {
      key: 'file_name',
      header: 'File',
      className: 'max-w-[220px]',
      render: (j) => (
        <span
          className='block truncate font-mono text-[11.5px] text-slate-800 dark:text-foreground'
          title={j.file_name}
        >
          {j.file_name}
        </span>
      )
    },
    {
      key: 'collection',
      header: 'Collection',
      className: 'w-[170px]',
      render: (j) => (
        <span className='truncate font-mono text-[11.5px] text-slate-600 dark:text-muted-foreground'>
          {j.collection}
        </span>
      )
    },
    {
      key: 'progress',
      header: 'Progress',
      className: 'w-[130px]',
      render: (j) => (
        <ProgressBar
          processed={j.processed_rows}
          total={j.total_rows}
          failed={j.status === 'failed'}
        />
      )
    },
    {
      key: 'created_rows',
      header: 'Created',
      className: 'w-[76px] text-right',
      headerClassName: 'text-right',
      render: (j) => <Num n={j.created_rows} />
    },
    {
      key: 'updated_rows',
      header: 'Updated',
      className: 'w-[76px] text-right',
      headerClassName: 'text-right',
      render: (j) => <Num n={j.updated_rows} />
    },
    {
      key: 'skipped_rows',
      header: 'Skipped',
      className: 'w-[76px] text-right',
      headerClassName: 'text-right',
      render: (j) => <Num n={j.skipped_rows} />
    },
    {
      key: 'error_rows',
      header: 'Errors',
      className: 'w-[70px] text-right',
      headerClassName: 'text-right',
      render: (j) =>
        (j.error_rows ?? 0) > 0 ? (
          <span className='font-mono text-[11.5px] font-medium tabular-nums text-red-600 dark:text-red-400'>
            {formatNumber(j.error_rows ?? 0)}
          </span>
        ) : (
          <Num n={0} />
        )
    },
    {
      key: 'created_at',
      header: 'Queued',
      className: 'w-[110px]',
      render: (j) => (
        <span
          className='text-[12px] text-slate-500 dark:text-muted-foreground'
          title={formatDateTime(j.created_at)}
        >
          {formatRelative(j.created_at)}
        </span>
      )
    },
    {
      key: '__actions__',
      header: '',
      className: 'w-[44px]',
      render: (j) => (
        <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type='button'
                className='rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted'
                aria-label={`Actions for ${j.file_name}`}
              >
                <MoreHorizontal className='h-4 w-4' />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end' className='text-[12.5px]'>
              <DropdownMenuItem onSelect={() => openJob(j.id)}>View details</DropdownMenuItem>
              <DropdownMenuItem
                disabled={j.status !== 'complete' || !!j.rolled_back_at}
                onSelect={() => {
                  if (
                    window.confirm(
                      'Roll back this import? Created rows are deleted (to trash) and overwritten rows restored to their prior values. One-shot.'
                    )
                  ) {
                    rollbackJob.mutate(j.id)
                  }
                }}
              >
                {j.rolled_back_at ? 'Rolled back' : 'Roll back this import'}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={j.status !== 'complete' && j.status !== 'failed'}
                onSelect={() => removeJob.mutate(j.id)}
              >
                <Trash2 className='h-3.5 w-3.5' /> Delete job
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )
    }
  ]

  if (mode === 'wizard') {
    return (
      <ImportWizard
        onCancel={() => setMode('list')}
        onCreated={(id) => {
          setMode('list')
          void qc.invalidateQueries({ queryKey: ['collection-import-jobs'] })
          openJob(id)
        }}
      />
    )
  }

  return (
    <div className='flex min-h-0 flex-1 flex-col gap-3'>
      {error && (
        <p className='rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400'>
          {error}
        </p>
      )}

      <div className='flex flex-wrap items-stretch divide-x divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card'>
        <StatusChip
          label='All'
          count={jobs.length}
          active={status === 'all'}
          onClick={() => setStatus('all')}
        />
        {(Object.keys(JOB_STATUS) as ImportJobStatus[]).map((s) => (
          <StatusChip
            key={s}
            label={JOB_STATUS[s].label}
            dot={JOB_STATUS[s].dot}
            count={counts[s] ?? 0}
            active={status === s}
            onClick={() => setStatus(status === s ? 'all' : s)}
          />
        ))}
        <div className='ml-auto flex items-stretch divide-x divide-slate-200 dark:divide-border'>
          <Tile label='Records created' value={formatNumber(totals.created)} />
          <Tile label='Records updated' value={formatNumber(totals.updated)} />
          <Tile label='Skipped' value={formatNumber(totals.skipped)} />
          <Tile
            label='Row errors'
            value={formatNumber(totals.errors)}
            tone={totals.errors > 0 ? 'red' : undefined}
          />
        </div>
      </div>

      {jobs.length === 0 && !jobsQuery.isLoading ? (
        <div className='rounded-lg border border-dashed border-slate-300 bg-white px-6 py-12 dark:border-border dark:bg-card'>
          <div className='max-w-[58ch]'>
            <Upload className='h-5 w-5 text-slate-300' />
            <h3 className='mt-3 text-[15px] font-semibold text-slate-900 dark:text-foreground'>
              No collection imports yet
            </h3>
            <p className='mt-1.5 text-[12.5px] leading-relaxed text-slate-500 dark:text-muted-foreground'>
              This is the row-by-row importer: a CSV's columns are mapped onto a collection's
              fields, and each row is created or updated through the normal item API — so
              validation, hooks and permissions all apply. Use it when you want records, not a
              staging table.
            </p>
            <Button size='sm' className='mt-4' onClick={() => setMode('wizard')}>
              <Plus className='h-3.5 w-3.5' /> Start an import
            </Button>
          </div>
        </div>
      ) : (
        <div className='min-h-0 flex-1'>
          <DataTable<ImportJob>
            columns={columns}
            rows={pageRows}
            rowKey={(j) => j.id}
            total={filtered.length}
            page={page}
            limit={PAGE_SIZE}
            onPageChange={setPage}
            isLoading={jobsQuery.isLoading}
            onRowClick={(j) => openJob(j.id)}
            nowrapCells
            minBodyHeight={280}
            emptyMessage='No import jobs match this filter.'
            rowClassName={(j) =>
              j.status === 'processing' ? 'bg-nvr-cyan/5 dark:bg-nvr-cyan/10' : undefined
            }
            toolbarRight={
              <Button size='sm' className='h-7' onClick={() => setMode('wizard')}>
                <Plus className='h-3.5 w-3.5' /> New collection import
              </Button>
            }
          />
        </div>
      )}

      <JobDetailSheet jobId={openJobId} onClose={() => openJob(null)} />
    </div>
  )
}

function Num({ n }: { n: number | null }) {
  return (
    <span className='font-mono text-[11.5px] tabular-nums text-slate-600 dark:text-muted-foreground'>
      {formatNumber(n ?? 0)}
    </span>
  )
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: 'red' }) {
  return (
    <div className='px-3.5 py-2'>
      <p className='text-[10.5px] font-medium text-slate-400 dark:text-muted-foreground'>{label}</p>
      <p
        className={cn(
          'mt-0.5 text-[15px] font-semibold leading-none tabular-nums',
          tone === 'red' ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-foreground'
        )}
      >
        {value}
      </p>
    </div>
  )
}

function StatusChip({
  label,
  count,
  dot,
  active,
  onClick
}: {
  label: string
  count: number
  dot?: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1.5 px-3 py-2 transition-colors hover:bg-slate-50 dark:hover:bg-muted/40',
        active && 'bg-nvr-cyan/10 ring-1 ring-inset ring-nvr-cyan dark:bg-nvr-cyan/15',
        !active && count === 0 && 'opacity-45'
      )}
    >
      {dot && <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dot)} />}
      <span className='text-[14px] font-semibold leading-none tabular-nums text-slate-900 dark:text-foreground'>
        {formatNumber(count)}
      </span>
      <span className='text-[11px] font-medium leading-none text-slate-400 dark:text-muted-foreground'>
        {label}
      </span>
    </button>
  )
}

// ─── Wizard ─────────────────────────────────────────────────────────────────

function ImportWizard({
  onCancel,
  onCreated
}: {
  onCancel: () => void
  onCreated: (id: string) => void
}) {
  const client = useNivaroClient()
  const fileRef = useRef<HTMLInputElement>(null)

  const [step, setStep] = useState(0)
  const [csv, setCsv] = useState('')
  const [fileName, setFileName] = useState('')
  const [url, setUrl] = useState('')
  const [collection, setCollection] = useState('')
  const [columnMap, setColumnMap] = useState<Record<string, string>>({})
  const [aiConfidence, setAiConfidence] = useState<Record<string, number>>({})
  const [strategy, setStrategy] = useState('skip')
  const [idField, setIdField] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [savedMappingNote, setSavedMappingNote] = useState<string | null>(null)
  const mappingLookupRef = useRef<string | null>(null)

  const { headers, rows, rowCount } = useMemo(() => parseCsvPreview(csv), [csv])

  // Mapping memory: the server remembers each (collection, header shape)'s
  // last column mapping — creation IS the save, so re-importing the same
  // shaped file starts fully mapped. Applied only while the map is still
  // untouched; a hand-corrected mapping is never clobbered.
  useEffect(() => {
    if (!collection || headers.length === 0) return
    const key = `${collection}|${headers.join('\u0001')}`
    if (mappingLookupRef.current === key) return
    mappingLookupRef.current = key
    client
      .request<{
        data: {
          column_map: Record<string, string>
          id_field: string | null
          duplicate_strategy: string | null
          updated_at: string | null
        } | null
      }>(post('/imports/mappings/lookup', { collection, headers }))
      .then((r) => {
        const saved = r.data
        if (!saved) return
        setColumnMap((current) => {
          if (Object.values(current).some((v) => v?.trim())) return current
          const next: Record<string, string> = {}
          for (const h of headers) if (saved.column_map[h]) next[h] = saved.column_map[h]
          if (Object.keys(next).length === 0) return current
          setSavedMappingNote(
            saved.updated_at
              ? `Applied your saved mapping from ${new Date(saved.updated_at).toLocaleDateString()}`
              : 'Applied your saved mapping'
          )
          if (saved.id_field) setIdField((cur) => cur || saved.id_field || '')
          if (saved.duplicate_strategy)
            setStrategy((cur) => (cur === 'skip' ? saved.duplicate_strategy || cur : cur))
          return next
        })
      })
      .catch(() => {})
  }, [collection, headers, client])

  // Diff preview — the server classifies every row (new / unchanged /
  // changed / conflict) against the live collection WITHOUT writing, using
  // the same matching logic the import itself runs. Fetched only on the
  // confirm step, re-fetched when any input that changes the answer changes.
  const previewQuery = useQuery({
    queryKey: [
      'import-diff-preview',
      collection,
      idField,
      strategy,
      csv.length,
      JSON.stringify(columnMap)
    ],
    queryFn: () =>
      client.request(
        post<{
          data: {
            total: number
            truncated: boolean
            new: number
            unchanged: number
            changed: number
            conflicts: number
            field_change_counts: Record<string, number>
            diffs: Array<{
              row: number
              id: string
              kind: 'changed' | 'conflict'
              reason?: string
              fields: Array<{ field: string; old: unknown; new: unknown }>
            }>
          }
        }>('/imports/preview', {
          collection,
          csv_data: csv,
          column_map: columnMap,
          id_field: idField || null,
          duplicate_strategy: strategy
        })
      ),
    enabled: step === 3 && !!collection && !!csv,
    staleTime: 30_000,
    retry: false
  })
  const preview = previewQuery.data?.data

  const collectionsQuery = useQuery({
    queryKey: ['import-collections'],
    queryFn: () => client.request(get<{ data: { collection: string }[] }>('/collections')),
    staleTime: 60_000
  })
  const collectionOptions = (collectionsQuery.data?.data ?? [])
    .filter((c) => !c.collection.toLowerCase().startsWith('nivaro_'))
    .map((c) => ({ value: c.collection, label: c.collection }))

  const metaQuery = useQuery({
    queryKey: ['import-collection-meta', collection],
    queryFn: () =>
      client.request(
        get<{ data: { fields?: { field: string; hidden?: boolean }[] } }>(
          `/collections/${collection}`
        )
      ),
    enabled: !!collection,
    staleTime: 60_000
  })
  const fields = (metaQuery.data?.data?.fields ?? []).filter((f) => !f.hidden).map((f) => f.field)

  const fetchUrl = useMutation({
    mutationFn: (u: string) =>
      client.request(
        post<{ data: { csv_data: string; file_name: string } }>('/imports/from-url', {
          url: u,
          preview: true
        })
      ),
    onSuccess: (res) => {
      setError(null)
      setCsv(res.data.csv_data)
      setFileName(res.data.file_name)
    },
    onError: (err: Error) => setError(err.message)
  })

  const aiMap = useMutation({
    mutationFn: () =>
      client.request(
        post<{
          data?: { mappings?: { column: string; field: string | null; confidence: number }[] }
          mappings?: { column: string; field: string | null; confidence: number }[]
        }>('/ai/map-columns', {
          collection,
          columns: headers,
          sample_rows: rows.slice(0, 5)
        })
      ),
    onSuccess: (res) => {
      const mappings = res.data?.mappings ?? res.mappings ?? []
      const next = { ...columnMap }
      const conf: Record<string, number> = {}
      for (const m of mappings) {
        if (!headers.includes(m.column)) continue
        next[m.column] = m.field ?? ''
        if (m.field) conf[m.column] = m.confidence ?? 0
      }
      setColumnMap(next)
      setAiConfidence(conf)
      setError(null)
    },
    onError: (err: Error & { status?: number }) =>
      setError(
        err.status === 503
          ? 'AI mapping needs an Anthropic API key — add one in Settings, or map the columns by hand.'
          : err.message
      )
  })

  const create = useMutation({
    mutationFn: () =>
      client.request(
        post<{ data: { id: string } }>('/imports', {
          collection,
          csv_data: csv,
          column_map: columnMap,
          duplicate_strategy: strategy,
          id_field: idField || undefined,
          file_name: fileName || 'import.csv'
        })
      ),
    onSuccess: (res) => onCreated(res.data.id),
    onError: (err: Error) => setError(err.message)
  })

  function setMapping(header: string, field: string) {
    setColumnMap((m) => ({ ...m, [header]: field }))
    if (aiConfidence[header] !== undefined) {
      setAiConfidence((c) => {
        const n = { ...c }
        delete n[header]
        return n
      })
    }
  }

  async function takeFile(file: File | null) {
    if (!file) return
    setError(null)
    setCsv(await file.text())
    setFileName(file.name)
  }

  const mappedCount = headers.filter((h) => columnMap[h]?.trim()).length
  const mappingNote = savedMappingNote
  const canAdvance =
    step === 0 ? headers.length > 0 : step === 1 ? !!collection && mappedCount > 0 : true

  return (
    <div className='flex min-h-0 flex-1 flex-col gap-4'>
      <div className='flex items-center gap-3'>
        <Button variant='ghost' size='sm' className='h-7 px-2' onClick={onCancel}>
          <ArrowLeft className='h-3.5 w-3.5' /> Back to jobs
        </Button>
        <ol className='flex items-center gap-1.5'>
          {STEPS.map((s, i) => (
            <li key={s} className='flex items-center gap-1.5'>
              <button
                type='button'
                // Only backwards: a later step's inputs depend on this one's.
                onClick={() => i < step && setStep(i)}
                disabled={i > step}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-colors',
                  i === step
                    ? 'bg-nvr-cyan/15 text-nvr-navy dark:bg-nvr-cyan/20 dark:text-nvr-cyan'
                    : i < step
                      ? 'text-slate-600 hover:bg-slate-100 dark:text-muted-foreground dark:hover:bg-muted'
                      : 'text-slate-300 dark:text-slate-600'
                )}
              >
                <span className='tabular-nums'>{i + 1}</span>
                {s}
              </button>
              {i < STEPS.length - 1 && <span className='text-slate-300'>›</span>}
            </li>
          ))}
        </ol>
      </div>

      <div className='min-h-0 flex-1 overflow-y-auto rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
        {step === 0 && (
          <div className='max-w-[980px] space-y-5'>
            <input
              ref={fileRef}
              type='file'
              accept='.csv,text/csv'
              className='hidden'
              onChange={(e) => {
                void takeFile(e.target.files?.[0] ?? null)
                e.target.value = ''
              }}
            />
            <div className='grid gap-4 lg:grid-cols-2'>
              <button
                type='button'
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragging(true)
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragging(false)
                  void takeFile(e.dataTransfer.files?.[0] ?? null)
                }}
                className={cn(
                  'flex flex-col items-center justify-center gap-1.5 rounded-md border border-dashed px-4 py-8 transition-colors',
                  dragging
                    ? 'border-nvr-cyan bg-nvr-cyan/10'
                    : 'border-slate-300 hover:border-slate-400 hover:bg-slate-50 dark:border-border dark:hover:bg-muted/30'
                )}
              >
                <FileUp className='h-4 w-4 text-slate-400' />
                <span className='text-[12.5px] font-medium text-slate-700 dark:text-foreground'>
                  Drop a CSV, or click to choose
                </span>
                {fileName && (
                  <span className='font-mono text-[11px] text-slate-500'>{fileName}</span>
                )}
              </button>

              <div className='space-y-1.5'>
                <Label className='flex items-center gap-1.5 text-[11.5px]'>
                  <Link2 className='h-3.5 w-3.5 text-slate-400' /> Or fetch from a URL
                </Label>
                <form
                  className='flex items-center gap-2'
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (url.trim()) fetchUrl.mutate(url.trim())
                  }}
                >
                  <Input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder='https://example.com/data.csv'
                    className='h-8 font-mono text-[12px]'
                  />
                  <Button
                    type='submit'
                    variant='outline'
                    size='sm'
                    className='h-8 shrink-0'
                    disabled={!url.trim() || fetchUrl.isPending}
                  >
                    {fetchUrl.isPending ? (
                      <Loader2 className='h-3.5 w-3.5 animate-spin' />
                    ) : (
                      'Fetch'
                    )}
                  </Button>
                </form>
                <p className='text-[11px] leading-snug text-slate-400'>
                  The server fetches it (25MB max, CSV or plain text) so the file never has to
                  round-trip through your machine.
                </p>
              </div>
            </div>

            <div className='space-y-1.5'>
              <Label className='text-[11.5px]'>Or paste the rows</Label>
              <Textarea
                value={csv}
                onChange={(e) => {
                  setCsv(e.target.value)
                  if (!fileName) setFileName('pasted.csv')
                }}
                rows={5}
                spellCheck={false}
                placeholder={'col1,col2,col3\nval1,val2,val3'}
                className='font-mono text-[12px]'
              />
            </div>

            {headers.length > 0 && (
              <div className='space-y-2'>
                <p className='text-[12px] text-slate-600 dark:text-muted-foreground'>
                  <span className='font-semibold text-slate-900 dark:text-foreground'>
                    {formatNumber(rowCount)}
                  </span>{' '}
                  data rows ×{' '}
                  <span className='font-semibold text-slate-900 dark:text-foreground'>
                    {headers.length}
                  </span>{' '}
                  columns
                </p>
                <PreviewTable headers={headers} rows={rows} />
              </div>
            )}
          </div>
        )}

        {step === 1 && (
          // Bounded width: a mapping row is a form field, and stretching the
          // pickers to a 1600px viewport puts the CSV column and the field it
          // maps to half a screen apart.
          <div className='max-w-[860px] space-y-4'>
            <div className='flex flex-wrap items-end justify-between gap-3'>
              <div className='space-y-1.5'>
                <Label className='text-[11.5px]'>Target collection</Label>
                <div className='w-[260px]'>
                  <PickCombobox
                    value={collection}
                    onChange={setCollection}
                    options={collectionOptions}
                    placeholder='Choose a collection…'
                  />
                </div>
                <p className='text-[11px] text-slate-400'>
                  Rows are written through the item API, so this collection's validation, hooks and
                  permissions all apply.
                </p>
              </div>
              <Button
                variant='outline'
                size='sm'
                className='h-8'
                disabled={!collection || headers.length === 0 || aiMap.isPending}
                onClick={() => aiMap.mutate()}
              >
                {aiMap.isPending ? (
                  <Loader2 className='h-3.5 w-3.5 animate-spin' />
                ) : (
                  <Sparkles className='h-3.5 w-3.5 text-nvr-cyan' />
                )}
                Match columns with AI
              </Button>
            </div>

            <div className='overflow-hidden rounded-md border border-slate-200 dark:border-border'>
              <table className='w-full border-collapse'>
                <thead>
                  <tr className='bg-slate-50 dark:bg-muted/40'>
                    <th className='w-[45%] border-b border-slate-200 px-3 py-1.5 text-left text-[10.5px] font-medium uppercase tracking-wide text-slate-400 dark:border-border'>
                      CSV column
                    </th>
                    <th className='border-b border-slate-200 px-3 py-1.5 text-left text-[10.5px] font-medium uppercase tracking-wide text-slate-400 dark:border-border'>
                      Collection field
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {headers.map((h) => (
                    <tr
                      key={h}
                      className='border-b border-slate-100 last:border-b-0 dark:border-border/60'
                    >
                      <td className='px-3 py-1.5 font-mono text-[11.5px] text-slate-600 dark:text-muted-foreground'>
                        {h}
                      </td>
                      <td className='px-3 py-1.5'>
                        <div className='flex items-center gap-2'>
                          <div className='w-[220px]'>
                            {fields.length > 0 ? (
                              <PickCombobox
                                value={columnMap[h] ?? ''}
                                onChange={(v) => setMapping(h, v)}
                                options={[
                                  { value: '', label: '— skip this column —' },
                                  ...fields.map((f) => ({ value: f, label: f }))
                                ]}
                                placeholder='— skip this column —'
                              />
                            ) : (
                              <Input
                                value={columnMap[h] ?? ''}
                                onChange={(e) => setMapping(h, e.target.value)}
                                placeholder='field_name'
                                className='h-8 font-mono text-[12px]'
                              />
                            )}
                          </div>
                          {aiConfidence[h] !== undefined && columnMap[h] && (
                            <ConfidenceBadge confidence={aiConfidence[h]} />
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              {mappedCount} of {headers.length} columns mapped — unmapped columns are ignored.
              {mappingNote && (
                <span className='ml-1.5 rounded bg-sky-500/10 px-1.5 py-0.5 text-[10.5px] font-medium text-sky-700 dark:text-sky-400'>
                  {mappingNote}
                </span>
              )}
            </p>
          </div>
        )}

        {step === 2 && (
          <div className='max-w-[520px] space-y-4'>
            <div className='space-y-1.5'>
              <Label className='text-[11.5px]'>When a record already exists</Label>
              <SimpleSelect
                value={strategy}
                onChange={setStrategy}
                options={[
                  { value: 'skip', label: 'Skip — leave the existing record alone' },
                  { value: 'overwrite', label: 'Overwrite — replace every mapped field' },
                  { value: 'merge', label: 'Merge — update only the mapped fields' }
                ]}
                className='h-8 text-[12.5px]'
              />
            </div>
            <div className='space-y-1.5'>
              <Label className='text-[11.5px]'>Match records on</Label>
              <PickCombobox
                value={idField}
                onChange={setIdField}
                options={[
                  { value: '', label: '— always create new records —' },
                  ...fields.map((f) => ({ value: f, label: f }))
                ]}
                placeholder='— always create new records —'
                className='w-[260px]'
              />
              <p className='text-[11px] leading-snug text-slate-400'>
                The field used to decide whether a row is a duplicate. Leave it empty and every row
                becomes a new record.
              </p>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className='max-w-[620px] space-y-4'>
            {previewQuery.isLoading && (
              <p className='text-[12px] text-slate-400'>Comparing against the live data…</p>
            )}
            {preview && (
              <div className='space-y-2'>
                <div className='flex flex-wrap gap-2'>
                  {[
                    {
                      label: 'new',
                      n: preview.new,
                      cls: 'border-emerald-300 text-emerald-700 dark:border-emerald-500/40 dark:text-emerald-400'
                    },
                    {
                      label: 'changed',
                      n: preview.changed,
                      cls: 'border-amber-300 text-amber-700 dark:border-amber-500/40 dark:text-amber-400'
                    },
                    {
                      label: preview.conflicts === 1 ? 'conflict' : 'conflicts',
                      n: preview.conflicts,
                      cls: 'border-red-300 text-red-700 dark:border-red-500/40 dark:text-red-400'
                    },
                    {
                      label: 'unchanged',
                      n: preview.unchanged,
                      cls: 'border-slate-200 text-slate-500 dark:border-border dark:text-slate-400'
                    }
                  ].map((c) => (
                    <span
                      key={c.label}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border bg-white px-2.5 py-1 text-[12px] font-medium dark:bg-card',
                        c.cls
                      )}
                    >
                      <span className='tabular-nums'>{formatNumber(c.n)}</span> {c.label}
                    </span>
                  ))}
                  {preview.truncated && (
                    <span className='self-center text-[11px] text-slate-400'>
                      (first {formatNumber(preview.total)} rows scanned)
                    </span>
                  )}
                </div>
                {preview.diffs.length > 0 && (
                  <div className='max-h-56 overflow-y-auto rounded-md border border-slate-200 dark:border-border'>
                    {preview.diffs.map((d) => (
                      <div
                        key={`${d.row}-${d.id}`}
                        className='border-b border-slate-100 px-3 py-2 text-[12px] last:border-b-0 dark:border-border/60'
                      >
                        <p className='flex items-center gap-2'>
                          <span
                            className={cn(
                              'rounded px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide',
                              d.kind === 'conflict'
                                ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                                : 'bg-amber-400/10 text-amber-600 dark:text-amber-400'
                            )}
                          >
                            {d.kind}
                          </span>
                          <span className='font-mono text-[11.5px]'>{d.id}</span>
                          <span className='text-[11px] text-slate-400'>row {d.row}</span>
                        </p>
                        {d.reason && (
                          <p className='mt-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
                            {d.reason}
                          </p>
                        )}
                        {d.fields.map((f) => (
                          <p key={f.field} className='mt-0.5 font-mono text-[11px]'>
                            <span className='text-slate-400'>{f.field}:</span>{' '}
                            <span className='text-red-600 line-through dark:text-red-400'>
                              {String(f.old ?? '—')}
                            </span>{' '}
                            <span className='text-emerald-600 dark:text-emerald-400'>
                              {String(f.new ?? '—')}
                            </span>
                          </p>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
                {preview.conflicts > 0 && (
                  <p className='text-[11.5px] text-red-600 dark:text-red-400'>
                    Conflicts need a look before you start — they are rows the import will silently
                    drop or resolve by last-write-wins.
                  </p>
                )}
              </div>
            )}
            <div className='overflow-hidden rounded-md border border-slate-200 dark:border-border'>
              {[
                { label: 'File', value: fileName || 'pasted.csv', mono: true },
                { label: 'Collection', value: collection, mono: true },
                { label: 'Data rows', value: formatNumber(rowCount) },
                { label: 'Mapped columns', value: `${mappedCount} of ${headers.length}` },
                {
                  label: 'Duplicates',
                  value:
                    strategy === 'skip'
                      ? 'Skipped'
                      : strategy === 'overwrite'
                        ? 'Overwritten'
                        : 'Merged'
                },
                {
                  label: 'Matched on',
                  value: idField || 'nothing — every row is new',
                  mono: !!idField
                }
              ].map((r) => (
                <div
                  key={r.label}
                  className='flex items-center gap-4 border-b border-slate-100 px-3.5 py-2 last:border-b-0 dark:border-border/60'
                >
                  <span className='w-36 shrink-0 text-[11.5px] text-slate-400'>{r.label}</span>
                  <span
                    className={cn(
                      'truncate text-[12.5px] text-slate-800 dark:text-foreground',
                      r.mono && 'font-mono text-[12px]'
                    )}
                  >
                    {r.value}
                  </span>
                </div>
              ))}
            </div>
            <p className='text-[12px] leading-relaxed text-slate-500 dark:text-muted-foreground'>
              Starting the import writes {formatNumber(rowCount)} rows into{' '}
              <span className='font-mono text-slate-700 dark:text-foreground'>{collection}</span>{' '}
              one at a time. Progress appears in the job list as it runs.
            </p>
          </div>
        )}
      </div>

      <div className='flex shrink-0 items-center gap-2'>
        {step > 0 && (
          <Button variant='ghost' size='sm' onClick={() => setStep((s) => s - 1)}>
            <ArrowLeft className='h-3.5 w-3.5' /> Back
          </Button>
        )}
        {error && <p className='text-[12px] text-red-600 dark:text-red-400'>{error}</p>}
        <div className='ml-auto flex items-center gap-2'>
          <Button variant='ghost' size='sm' onClick={onCancel}>
            Cancel
          </Button>
          {step < STEPS.length - 1 ? (
            <Button size='sm' disabled={!canAdvance} onClick={() => setStep((s) => s + 1)}>
              Next <ArrowRight className='h-3.5 w-3.5' />
            </Button>
          ) : (
            <Button size='sm' disabled={create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? (
                <>
                  <Loader2 className='h-3.5 w-3.5 animate-spin' /> Starting…
                </>
              ) : (
                'Start import'
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function PreviewTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className='overflow-x-auto rounded-md border border-slate-200 dark:border-border'>
      <table className='w-full border-collapse'>
        <thead>
          <tr className='bg-slate-50 dark:bg-muted/40'>
            {headers.map((h) => (
              <th
                key={h}
                className='whitespace-nowrap border-b border-slate-200 px-2.5 py-1.5 text-left font-mono text-[10.5px] font-medium text-slate-500 dark:border-border dark:text-muted-foreground'
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <tr key={i} className='border-b border-slate-100 last:border-b-0 dark:border-border/60'>
              {headers.map((_h, ci) => (
                <td
                  // eslint-disable-next-line react/no-array-index-key
                  key={ci}
                  className='max-w-[200px] truncate whitespace-nowrap px-2.5 py-1 font-mono text-[11px] text-slate-700 dark:text-foreground'
                  title={row[ci] ?? ''}
                >
                  {row[ci] || <span className='text-slate-300'>—</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Job detail ─────────────────────────────────────────────────────────────

function JobDetailSheet({ jobId, onClose }: { jobId: string | null; onClose: () => void }) {
  const client = useNivaroClient()
  const query = useQuery({
    queryKey: ['collection-import-job', jobId],
    queryFn: () => client.request(get<{ data: ImportJob }>(`/imports/${jobId}`)),
    enabled: !!jobId,
    refetchInterval: (q) =>
      q.state.data?.data?.status === 'processing' || q.state.data?.data?.status === 'pending'
        ? 2000
        : false
  })
  const job = query.data?.data
  const errors = Array.isArray(job?.errors) ? job.errors : []
  const pct = job?.total_rows
    ? Math.min(100, Math.round(((job.processed_rows ?? 0) / job.total_rows) * 100))
    : job?.status === 'complete'
      ? 100
      : 0

  return (
    <Sheet open={!!jobId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side='right' className='w-[min(560px,94vw)] p-0 sm:max-w-none'>
        {!job ? (
          <div className='p-5 text-[12.5px] text-slate-400'>Loading job…</div>
        ) : (
          <div className='flex h-full flex-col'>
            <header className='shrink-0 border-b border-slate-200 px-5 py-4 dark:border-border'>
              <JobStatusPill status={job.status} />
              <h2 className='mt-1.5 truncate font-mono text-[15px] font-semibold text-slate-900 dark:text-foreground'>
                {job.file_name}
              </h2>
              <p className='text-[11.5px] text-slate-400'>
                into <span className='font-mono'>{job.collection}</span> ·{' '}
                {formatDateTime(job.created_at)}
              </p>
            </header>

            <div className='min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4'>
              <section className='space-y-2'>
                <div className='flex items-center justify-between'>
                  <h3 className='text-[11.5px] font-semibold text-slate-500 dark:text-muted-foreground'>
                    Progress
                  </h3>
                  <span className='text-[12px] font-medium tabular-nums text-slate-700 dark:text-foreground'>
                    {pct}%
                  </span>
                </div>
                <div className='h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-muted'>
                  <div
                    className={cn(
                      'h-full rounded-full transition-[width] duration-500',
                      job.status === 'failed' ? 'bg-red-500' : 'bg-nvr-cyan'
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                  {formatNumber(job.processed_rows ?? 0)} of{' '}
                  {job.total_rows == null ? '?' : formatNumber(job.total_rows)} rows processed
                </p>
              </section>

              <section className='grid grid-cols-4 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'>
                {[
                  { label: 'Created', value: job.created_rows ?? 0 },
                  { label: 'Updated', value: job.updated_rows ?? 0 },
                  { label: 'Skipped', value: job.skipped_rows ?? 0 },
                  { label: 'Errors', value: job.error_rows ?? 0, bad: (job.error_rows ?? 0) > 0 }
                ].map((s) => (
                  <div key={s.label} className='bg-white px-3 py-2 dark:bg-card'>
                    <p className='text-[10.5px] text-slate-400'>{s.label}</p>
                    <p
                      className={cn(
                        'text-[15px] font-semibold tabular-nums',
                        s.bad
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-slate-900 dark:text-foreground'
                      )}
                    >
                      {formatNumber(s.value)}
                    </p>
                  </div>
                ))}
              </section>

              <section>
                <h3 className='mb-1 text-[11.5px] font-semibold text-slate-500 dark:text-muted-foreground'>
                  Settings
                </h3>
                {[
                  { label: 'Duplicates', value: job.duplicate_strategy },
                  { label: 'Matched on', value: job.id_field ?? '— always create' },
                  {
                    label: 'Started',
                    value: job.started_at ? formatDateTime(job.started_at) : '—'
                  },
                  {
                    label: 'Completed',
                    value: job.completed_at ? formatDateTime(job.completed_at) : '—'
                  }
                ].map((r) => (
                  <div
                    key={r.label}
                    className='flex items-baseline justify-between gap-4 border-b border-slate-100 py-1.5 last:border-b-0 dark:border-border/60'
                  >
                    <span className='text-[11.5px] text-slate-400'>{r.label}</span>
                    <span className='truncate text-[12px] text-slate-800 dark:text-foreground'>
                      {r.value}
                    </span>
                  </div>
                ))}
              </section>

              {job.column_map && Object.keys(job.column_map).length > 0 && (
                <section>
                  <h3 className='mb-1.5 text-[11.5px] font-semibold text-slate-500 dark:text-muted-foreground'>
                    Column mapping
                  </h3>
                  <div className='overflow-hidden rounded-md border border-slate-200 dark:border-border'>
                    {Object.entries(job.column_map).map(([col, field]) => (
                      <div
                        key={col}
                        className='flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 font-mono text-[11.5px] last:border-b-0 dark:border-border/60'
                      >
                        <span className='flex-1 truncate text-slate-500 dark:text-muted-foreground'>
                          {col}
                        </span>
                        <ArrowRight className='h-3 w-3 shrink-0 text-slate-300' />
                        <span className='flex-1 truncate text-slate-800 dark:text-foreground'>
                          {field || <span className='font-sans text-slate-400'>skipped</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {errors.length > 0 && (
                <section>
                  <h3 className='mb-1.5 text-[11.5px] font-semibold text-red-700 dark:text-red-400'>
                    Row errors ({errors.length})
                  </h3>
                  <div className='max-h-[240px] overflow-auto rounded-md border border-red-200 dark:border-red-900'>
                    {errors.map((e) => (
                      <div
                        key={`${e.row}-${e.error}`}
                        className='flex gap-3 border-b border-red-100 px-3 py-1.5 text-[11.5px] last:border-b-0 dark:border-red-900/60'
                      >
                        <span className='shrink-0 font-mono tabular-nums text-slate-400'>
                          {e.row}
                        </span>
                        <span className='text-red-700 dark:text-red-400'>{e.error}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
