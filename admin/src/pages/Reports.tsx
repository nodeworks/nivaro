import { useQuery } from '@tanstack/react-query'
import { Download, FileBarChart, FilterX } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { api } from '@/lib/api'
import { cn, formatDateTime, formatNumber } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

type ActivityRow = {
  id: number
  action: string
  collection: string | null
  item: string | null
  timestamp: string
  user_id: string | null
  first_name: string | null
  last_name: string | null
  user_email: string | null
}

type ActivityResponse = {
  data: ActivityRow[]
  total: number
  page: number
  limit: number
}

type SummaryResponse = {
  by_action: { action: string; count: number }[]
  by_collection: { collection: string; count: number }[]
  by_user: {
    user_id: string
    first_name: string | null
    last_name: string | null
    email: string
    count: number
  }[]
  total_events: number
  date_range: { from: string | null; to: string | null }
}

type Filters = {
  collection: string
  user: string
  action: string
  from: string
  to: string
}

const EMPTY_FILTERS: Filters = { collection: '', user: '', action: '', from: '', to: '' }
const PAGE_LIMIT = 25

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ACTION_CLS: Record<string, string> = {
  create:
    'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900',
  update:
    'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-400 dark:border-sky-900',
  delete:
    'bg-red-50 text-red-600 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900'
}

function ActionBadge({ action }: { action: string }) {
  const cls = ACTION_CLS[action] ?? 'bg-slate-50 text-slate-500 border-slate-200'
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-semibold',
        cls
      )}
    >
      {action.charAt(0).toUpperCase() + action.slice(1)}
    </span>
  )
}

function userName(row: ActivityRow): string {
  if (row.first_name || row.last_name) {
    return [row.first_name, row.last_name].filter(Boolean).join(' ')
  }
  return row.user_email ?? row.user_id?.slice(0, 8) ?? '—'
}

function filtersToParams(f: Filters) {
  return {
    collection: f.collection || undefined,
    user: f.user || undefined,
    action: f.action || undefined,
    from: f.from || undefined,
    to: f.to || undefined
  }
}

function hasActiveFilters(f: Filters) {
  return Object.values(f).some(Boolean)
}

// ─── Stat strip ───────────────────────────────────────────────────────────────

function StatStrip({
  summaryData,
  loading
}: {
  summaryData: SummaryResponse | null | undefined
  loading: boolean
}) {
  const actionCount = (action: string) =>
    summaryData?.by_action.find((a) => a.action === action)?.count ?? null

  const stats = [
    { label: 'Total events', value: summaryData?.total_events, cls: '' },
    {
      label: 'Creates',
      value: actionCount('create'),
      cls: 'text-emerald-600 dark:text-emerald-400'
    },
    { label: 'Updates', value: actionCount('update'), cls: 'text-sky-600 dark:text-sky-400' },
    { label: 'Deletes', value: actionCount('delete'), cls: 'text-red-600 dark:text-red-400' }
  ]

  return (
    <div className='grid grid-cols-4 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'>
      {stats.map((s) => (
        <div key={s.label} className='bg-white px-4 py-3.5 dark:bg-card'>
          <p className='mb-1 text-[11px] font-medium text-slate-400 dark:text-muted-foreground'>
            {s.label}
          </p>
          {loading ? (
            <Skeleton className='h-6 w-16 rounded' />
          ) : (
            <p
              className={cn(
                'text-[22px] font-semibold leading-none tabular-nums',
                s.cls || 'text-slate-900 dark:text-foreground'
              )}
            >
              {formatNumber(s.value ?? 0)}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Filter sidebar ───────────────────────────────────────────────────────────

function FilterSidebar({
  draft,
  setDraft,
  onApply,
  onReset,
  collectionsData
}: {
  draft: Filters
  setDraft: React.Dispatch<React.SetStateAction<Filters>>
  onApply: () => void
  onReset: () => void
  collectionsData: { collection: string; display_name: string | null }[] | undefined
}) {
  return (
    <aside className='flex w-[224px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
      <div className='shrink-0 border-b border-slate-100 px-4 py-3 dark:border-border'>
        <p className='text-[11px] font-semibold text-slate-500 dark:text-muted-foreground'>
          Filters
        </p>
      </div>

      <div className='flex-1 overflow-y-auto p-4 space-y-4'>
        <div className='space-y-1.5'>
          <Label className='text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
            From
          </Label>
          <Input
            type='date'
            value={draft.from}
            onChange={(e) => setDraft((p) => ({ ...p, from: e.target.value }))}
            className='h-8 text-[12px]'
          />
        </div>
        <div className='space-y-1.5'>
          <Label className='text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
            To
          </Label>
          <Input
            type='date'
            value={draft.to}
            onChange={(e) => setDraft((p) => ({ ...p, to: e.target.value }))}
            className='h-8 text-[12px]'
          />
        </div>
        <div className='space-y-1.5'>
          <Label className='text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
            Collection
          </Label>
          <Select
            value={draft.collection || '__all__'}
            onValueChange={(v) => setDraft((p) => ({ ...p, collection: v === '__all__' ? '' : v }))}
          >
            <SelectTrigger className='h-8 text-[12px]'>
              <SelectValue placeholder='All' />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='__all__'>All collections</SelectItem>
              {(collectionsData ?? []).map((c) => (
                <SelectItem key={c.collection} value={c.collection}>
                  {c.display_name ?? c.collection}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className='space-y-1.5'>
          <Label className='text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
            Action
          </Label>
          <Select
            value={draft.action || '__all__'}
            onValueChange={(v) => setDraft((p) => ({ ...p, action: v === '__all__' ? '' : v }))}
          >
            <SelectTrigger className='h-8 text-[12px]'>
              <SelectValue placeholder='All' />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='__all__'>All actions</SelectItem>
              <SelectItem value='create'>Create</SelectItem>
              <SelectItem value='update'>Update</SelectItem>
              <SelectItem value='delete'>Delete</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className='space-y-1.5'>
          <Label className='text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
            User
          </Label>
          <Input
            placeholder='ID or email'
            value={draft.user}
            onChange={(e) => setDraft((p) => ({ ...p, user: e.target.value }))}
            className='h-8 text-[12px]'
          />
        </div>
      </div>

      <div className='shrink-0 border-t border-slate-100 p-4 space-y-2 dark:border-border'>
        <Button size='sm' className='w-full' onClick={onApply}>
          Apply filters
        </Button>
        <Button size='sm' variant='ghost' className='w-full' onClick={onReset}>
          <FilterX className='mr-1.5 h-3.5 w-3.5' /> Reset
        </Button>
      </div>
    </aside>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function ReportsPage() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS)
  const [page, setPage] = useState(1)
  const [exporting, setExporting] = useState(false)

  const { data: collectionsData } = useQuery({
    queryKey: ['collections'],
    queryFn: () =>
      api
        .get('/collections')
        .then((r) => r.data.data as { collection: string; display_name: string | null }[])
  })

  const { data: activityData, isLoading: activityLoading } = useQuery({
    queryKey: ['reports-activity', filters, page],
    queryFn: () =>
      api
        .get<ActivityResponse>('/reports/activity', {
          params: { ...filtersToParams(filters), page, limit: PAGE_LIMIT }
        })
        .then((r) => r.data)
  })

  const { data: summaryData, isLoading: summaryLoading } = useQuery({
    queryKey: ['reports-summary', filters.from, filters.to],
    queryFn: () =>
      api
        .get<SummaryResponse>('/reports/summary', {
          params: { from: filters.from || undefined, to: filters.to || undefined }
        })
        .then((r) => r.data),
    retry: false
  })

  const rows = activityData?.data ?? []
  const total = activityData?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_LIMIT)

  function applyFilters() {
    setFilters({ ...draft })
    setPage(1)
  }

  function resetFilters() {
    setDraft(EMPTY_FILTERS)
    setFilters(EMPTY_FILTERS)
    setPage(1)
  }

  async function exportCSV() {
    setExporting(true)
    try {
      const params = new URLSearchParams({ format: 'csv' })
      if (filters.collection) params.set('collection', filters.collection)
      if (filters.user) params.set('user', filters.user)
      if (filters.action) params.set('action', filters.action)
      if (filters.from) params.set('from', filters.from)
      if (filters.to) params.set('to', filters.to)
      const res = await api.get(`/reports/activity?${params.toString()}`, { responseType: 'blob' })
      const url = URL.createObjectURL(res.data as Blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'activity-report.csv'
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }

  const showSummary = summaryData != null || summaryLoading

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <div className='sticky top-0 z-10 shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2.5'>
            <div className='flex h-7 w-7 items-center justify-center rounded-lg bg-[#00ceff]/10'>
              <FileBarChart className='h-3.5 w-3.5 text-[#00ceff]' />
            </div>
            <h1 className='text-[17px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Audit Reports
            </h1>
            {hasActiveFilters(filters) && (
              <span className='inline-flex items-center rounded-full bg-[#00ceff]/10 px-2 py-0.5 text-[11px] font-medium text-[#00ceff]'>
                Filtered
              </span>
            )}
          </div>
          <Button size='sm' variant='outline' onClick={exportCSV} disabled={exporting}>
            <Download className='mr-1.5 h-3.5 w-3.5' />
            {exporting ? 'Exporting…' : 'Export CSV'}
          </Button>
        </div>
      </div>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <FilterSidebar
          draft={draft}
          setDraft={setDraft}
          onApply={applyFilters}
          onReset={resetFilters}
          collectionsData={collectionsData}
        />

        <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
          <div className='p-6 space-y-5'>
            {showSummary && <StatStrip summaryData={summaryData} loading={summaryLoading} />}

            <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
              {activityLoading ? (
                <div className='p-5 space-y-2.5'>
                  {[...Array(8)].map((_, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
                    <Skeleton key={i} className='h-10 w-full rounded' />
                  ))}
                </div>
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className='text-[11px]'>Timestamp</TableHead>
                        <TableHead className='text-[11px]'>User</TableHead>
                        <TableHead className='text-[11px]'>Collection</TableHead>
                        <TableHead className='text-[11px]'>Item</TableHead>
                        <TableHead className='text-[11px]'>Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell className='text-[12px] text-muted-foreground whitespace-nowrap'>
                            {formatDateTime(row.timestamp)}
                          </TableCell>
                          <TableCell className='text-[13px]'>{userName(row)}</TableCell>
                          <TableCell className='font-mono text-[12px] text-slate-600 dark:text-slate-400'>
                            {row.collection ?? '—'}
                          </TableCell>
                          <TableCell className='font-mono text-[12px] text-muted-foreground'>
                            {row.item ?? '—'}
                          </TableCell>
                          <TableCell>
                            <ActionBadge action={row.action} />
                          </TableCell>
                        </TableRow>
                      ))}
                      {rows.length === 0 && (
                        <TableRow>
                          <TableCell
                            colSpan={5}
                            className='py-16 text-center text-[13px] text-muted-foreground'
                          >
                            No activity matches the selected filters.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>

                  {total > 0 && (
                    <div className='flex items-center justify-between border-t border-slate-100 px-4 py-3 dark:border-border'>
                      <p className='text-[12px] text-muted-foreground'>
                        {formatNumber(total)} event{total !== 1 ? 's' : ''}
                      </p>
                      <div className='flex items-center gap-2'>
                        <Button
                          variant='outline'
                          size='sm'
                          disabled={page <= 1}
                          onClick={() => setPage((p) => p - 1)}
                        >
                          Previous
                        </Button>
                        <span className='text-[12px] text-muted-foreground'>
                          {page} / {totalPages}
                        </span>
                        <Button
                          variant='outline'
                          size='sm'
                          disabled={page >= totalPages}
                          onClick={() => setPage((p) => p + 1)}
                        >
                          Next
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
