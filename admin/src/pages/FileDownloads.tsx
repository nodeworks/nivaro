import { QueryErrorState } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { Download, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { HubToolbar } from '@/components/hub-page'
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
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn, formatNumber } from '@/lib/utils'

/**
 * File downloads report (#3235): who downloaded what, per file, per person and
 * per record, from the download log (#3234). Rows the viewer could not open
 * (User Scopes, row filters) are left out by the server. Administrators only.
 * View, dates, collection and person live in the URL so a link reopens the
 * same answer.
 */

interface DownloadRow {
  activity_id: number
  user: string | null
  person: string
  at: string
  collection: string | null
  item: string | null
  file: string
  name: string | null
  app: string
  kind: 'download' | 'open'
}

interface Report {
  rows: DownloadRow[]
  by_file: Array<{
    file: string
    name: string | null
    count: number
    people: number
    last: string
    records: Array<{ collection: string; item: string }>
  }>
  by_person: Array<{ user: string; name: string; files: number; count: number; last: string }>
  by_record: Array<{ collection: string; item: string; files: number; count: number; last: string }>
  truncated: boolean
}

type LabelAnswer = {
  records?: Record<string, string | null>
  collections?: Record<string, string | { singular?: string; plural?: string }>
}

/** A local calendar day as YYYY-MM-DD (never the UTC day). */
function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const daysAgo = (n: number) => localDay(new Date(Date.now() - n * 86_400_000))
/** The instant a local day starts (offset by `plus` days). */
function dayStart(day: string, plus = 0): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d + plus).toISOString()
}

const ALL = '__all__'
const SKELETON_ROWS = [1, 2, 3, 4, 5, 6]
const RANGES = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
  { days: 365, label: '1y' }
] as const
const VIEWS = [
  { key: 'file', label: 'By file' },
  { key: 'person', label: 'By person' },
  { key: 'record', label: 'By record' },
  { key: 'all', label: 'Every download' }
] as const
type View = (typeof VIEWS)[number]['key']
const isView = (v: string | null): v is View => VIEWS.some((x) => x.key === v)

const plural = (n: number, one: string, many: string) =>
  `${formatNumber(n)} ${n === 1 ? one : many}`

const when = (v: string) =>
  new Date(v).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })

/** Where the download came from, in words: the admin app, another front end's host, or a bare link. */
function appName(app: string): string {
  if (app === 'admin') return 'Admin'
  if (app === 'direct') return 'Direct link'
  return app
}

function collectionName(labels: LabelAnswer | undefined, c: string): string {
  const v = labels?.collections?.[c]
  if (!v) return c
  return typeof v === 'string' ? v : (v.singular ?? v.plural ?? c)
}

function RecordLink({
  collection,
  item,
  labels
}: {
  collection: string
  item: string
  labels: LabelAnswer | undefined
}) {
  const label = labels?.records?.[`${collection}:${item}`]
  return (
    <Link
      to={`/collections/${encodeURIComponent(collection)}/${encodeURIComponent(item)}`}
      className='text-nvr-navy hover:underline dark:text-nvr-cyan'
    >
      {label ?? `${collectionName(labels, collection)} ${item}`}
    </Link>
  )
}

const NotOnRecord = () => (
  <span className='text-slate-500 dark:text-muted-foreground'>Not on a record</span>
)

const th = 'px-3 py-2 font-medium'
const td = 'px-3 py-2'

export function FileDownloadsPage() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const from = params.get('from') ?? daysAgo(30)
  const to = params.get('to') ?? localDay(new Date())
  const collection = params.get('collection') ?? ALL
  const person = params.get('person') ?? ALL
  const view: View = isView(params.get('view')) ? (params.get('view') as View) : 'file'
  const fileFilter = params.get('file') ?? ''
  const [search, setSearch] = useState('')
  const [exporting, setExporting] = useState(false)

  function setParam(next: Record<string, string | null>) {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(next)) {
          if (v == null || v === '' || v === ALL) p.delete(k)
          else p.set(k, v)
        }
        return p
      },
      { replace: true }
    )
  }

  const range = { from: dayStart(from), to: dayStart(to, 1) }
  const filters = {
    ...range,
    ...(collection !== ALL ? { collection } : {}),
    ...(person !== ALL ? { user: person } : {})
  }

  // The unfiltered range feeds the Collection and Person choices.
  const base = useQuery<Report>({
    queryKey: ['file-downloads', range.from, range.to],
    queryFn: () => api.get('/file-downloads/report', { params: range }).then((r) => r.data.data),
    enabled: !!user?.is_admin
  })
  const filtered = collection !== ALL || person !== ALL
  const narrowed = useQuery<Report>({
    queryKey: ['file-downloads', range.from, range.to, collection, person],
    queryFn: () => api.get('/file-downloads/report', { params: filters }).then((r) => r.data.data),
    enabled: !!user?.is_admin && filtered
  })
  const active = filtered ? narrowed : base
  const report = active.data

  const collections = useMemo(
    () =>
      [
        ...new Set(
          (base.data?.rows ?? [])
            .map((r) => r.collection)
            .filter((c): c is string => !!c && c !== 'nivaro_files')
        )
      ].sort(),
    [base.data]
  )
  const people = base.data?.by_person ?? []

  // File search (by name) and a picked file narrow every view on the client.
  const needle = search.trim().toLowerCase()
  const fileMatch = useMemo(() => {
    const picked = fileFilter.toLowerCase()
    return (id: string, name: string | null) =>
      (!picked || id.toLowerCase() === picked) &&
      (!needle || (name ?? id).toLowerCase().includes(needle))
  }, [fileFilter, needle])
  const rows = useMemo(
    () => (report?.rows ?? []).filter((r) => fileMatch(r.file, r.name)),
    [report, fileMatch]
  )
  const byFile = useMemo(
    () => (report?.by_file ?? []).filter((f) => fileMatch(f.file, f.name)),
    [report, fileMatch]
  )
  const narrowedByFile = !!fileFilter || !!needle
  // Person and record groupings follow the file search from the rows themselves.
  const byPerson = useMemo(() => {
    if (!narrowedByFile) return report?.by_person ?? []
    const m = new Map<
      string,
      { user: string; name: string; files: Set<string>; count: number; last: string }
    >()
    for (const r of rows) {
      const k = (r.user ?? '').toUpperCase()
      const p = m.get(k) ?? {
        user: r.user ?? '',
        name: r.person,
        files: new Set(),
        count: 0,
        last: r.at
      }
      p.count += 1
      p.files.add(r.file.toLowerCase())
      if (r.at > p.last) p.last = r.at
      m.set(k, p)
    }
    return [...m.values()]
      .map((p) => ({ ...p, files: p.files.size }))
      .sort((a, b) => b.count - a.count)
  }, [report, rows, narrowedByFile])
  const byRecord = useMemo(() => {
    if (!narrowedByFile) return report?.by_record ?? []
    const m = new Map<
      string,
      { collection: string; item: string; files: Set<string>; count: number; last: string }
    >()
    for (const r of rows) {
      if (!r.collection || r.item == null || r.collection === 'nivaro_files') continue
      const k = `${r.collection}:${r.item}`
      const rec = m.get(k) ?? {
        collection: r.collection,
        item: r.item,
        files: new Set(),
        count: 0,
        last: r.at
      }
      rec.count += 1
      rec.files.add(r.file.toLowerCase())
      if (r.at > rec.last) rec.last = r.at
      m.set(k, rec)
    }
    return [...m.values()]
      .map((r) => ({ ...r, files: r.files.size }))
      .sort((a, b) => b.count - a.count)
  }, [report, rows, narrowedByFile])

  // Files sharing one name get a short id so they can be told apart.
  const dupNames = useMemo(() => {
    const seen = new Map<string, number>()
    for (const f of report?.by_file ?? []) {
      const n = (f.name ?? '').toLowerCase()
      seen.set(n, (seen.get(n) ?? 0) + 1)
    }
    return new Set([...seen].filter(([, c]) => c > 1).map(([n]) => n))
  }, [report])

  const refs = useMemo(() => {
    const seen = new Map<string, { collection: string; id: string }>()
    for (const r of report?.by_record.slice(0, 300) ?? [])
      seen.set(`${r.collection}:${r.item}`, { collection: r.collection, id: r.item })
    for (const f of report?.by_file.slice(0, 300) ?? [])
      for (const r of f.records.slice(0, 3))
        seen.set(`${r.collection}:${r.item}`, { collection: r.collection, id: r.item })
    for (const c of collections) seen.set(`${c}:`, { collection: c, id: '' })
    return [...seen.values()].filter((r) => r.id)
  }, [report, collections])
  const { data: labels } = useQuery<LabelAnswer>({
    queryKey: [
      'file-downloads-labels',
      refs.map((r) => `${r.collection}:${r.id}`).join('|'),
      collections.join('|')
    ],
    queryFn: () =>
      api
        .post('/activity/labels', {
          refs,
          collections: [...new Set([...refs.map((r) => r.collection), ...collections])]
        })
        .then((r) => r.data.data),
    enabled: refs.length > 0 || collections.length > 0,
    staleTime: 60_000
  })

  async function exportCsv() {
    setExporting(true)
    try {
      const r = await api.get('/file-downloads/report', {
        params: { ...filters, format: 'csv' },
        responseType: 'blob'
      })
      const url = URL.createObjectURL(r.data as Blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `file-downloads-${from}-to-${to}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch {
      toast.error('The CSV could not be made. Try again in a moment.')
    } finally {
      setExporting(false)
    }
  }

  if (!user?.is_admin) {
    return (
      <div className='flex flex-1 items-center justify-center text-sm text-muted-foreground'>
        The file downloads report is available to administrators only.
      </div>
    )
  }

  const total = rows.length
  const pickedFile = fileFilter
    ? report?.by_file.find((f) => f.file.toLowerCase() === fileFilter.toLowerCase())
    : null
  const rangeDays = Math.round(
    (new Date(dayStart(to, 1)).getTime() - new Date(dayStart(from)).getTime()) / 86_400_000
  )
  const presetActive = (days: number) => to === localDay(new Date()) && rangeDays === days + 1

  const viewEmpty =
    view === 'file'
      ? byFile.length === 0
      : view === 'person'
        ? byPerson.length === 0
        : view === 'record'
          ? byRecord.length === 0
          : rows.length === 0

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar
        description='Who downloaded or opened which file, and from which record. The same person fetching the same file again within a minute counts once; thumbnails and images shown on a page do not count.'
        actions={
          <Button
            size='sm'
            variant='outline'
            onClick={exportCsv}
            disabled={exporting || total === 0}
          >
            <Download className='mr-1.5 h-3.5 w-3.5' />
            {exporting ? 'Exporting…' : 'Export CSV'}
          </Button>
        }
      />
      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside className='w-[224px] shrink-0 space-y-4 overflow-y-auto border-r border-border p-4'>
          <div className='space-y-1.5'>
            <Label htmlFor='fd-search'>File</Label>
            <div className='relative'>
              <Search className='pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500' />
              <Input
                id='fd-search'
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder='Find by name'
                className='pl-7'
              />
            </div>
          </div>
          <div className='space-y-1.5'>
            <span className='text-[12px] font-medium'>Range</span>
            <div className='flex gap-1'>
              {RANGES.map((r) => (
                <button
                  key={r.days}
                  type='button'
                  aria-pressed={presetActive(r.days)}
                  onClick={() => setParam({ from: daysAgo(r.days), to: null })}
                  className={cn(
                    'flex-1 rounded border px-1.5 py-1 text-[11.5px] transition-colors',
                    presetActive(r.days)
                      ? 'border-nvr-cyan/50 bg-nvr-cyan/10 font-medium text-foreground'
                      : 'border-border text-slate-600 hover:bg-muted dark:text-slate-300'
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='fd-from'>From</Label>
            <Input
              id='fd-from'
              type='date'
              value={from}
              max={to}
              onChange={(e) => e.target.value && setParam({ from: e.target.value })}
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='fd-to'>To</Label>
            <Input
              id='fd-to'
              type='date'
              value={to}
              min={from}
              onChange={(e) => e.target.value && setParam({ to: e.target.value })}
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='fd-collection'>Collection</Label>
            <Select value={collection} onValueChange={(v) => setParam({ collection: v })}>
              <SelectTrigger id='fd-collection'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All collections</SelectItem>
                {collections.map((c) => (
                  <SelectItem key={c} value={c}>
                    {collectionName(labels, c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='fd-person'>Person</Label>
            <Select value={person} onValueChange={(v) => setParam({ person: v })}>
              <SelectTrigger id='fd-person'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Everyone</SelectItem>
                {people.map((p) => (
                  <SelectItem key={p.user} value={p.user}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {(filtered || fileFilter || search || params.get('from') || params.get('to')) && (
            <button
              type='button'
              onClick={() => {
                setSearch('')
                setParams(view === 'file' ? {} : { view }, { replace: true })
              }}
              className='text-[12px] text-nvr-navy hover:underline dark:text-nvr-cyan'
            >
              Reset filters
            </button>
          )}
        </aside>

        <div className='flex flex-1 min-w-0 flex-col overflow-y-auto bg-slate-50 dark:bg-background'>
          <div className='flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border bg-card px-5 py-3 text-[13px]'>
            {report ? (
              <>
                <span>
                  <b className='tabular-nums'>{plural(total, 'download', 'downloads')}</b>
                </span>
                <span className='text-slate-600 dark:text-muted-foreground'>
                  {plural(byFile.length, 'file', 'files')} ·{' '}
                  {plural(byPerson.length, 'person', 'people')}
                </span>
              </>
            ) : (
              <Skeleton className='h-4 w-48' />
            )}
            {pickedFile && (
              <span className='inline-flex items-center gap-1.5 rounded bg-accent px-2 py-0.5 text-[12px]'>
                {pickedFile.name ?? pickedFile.file}
                <button
                  type='button'
                  aria-label='Show every file'
                  onClick={() => setParam({ file: null })}
                  className='text-slate-500 hover:text-foreground'
                >
                  ×
                </button>
              </span>
            )}
            <fieldset
              aria-label='Group downloads'
              className='ml-auto flex min-w-0 rounded-md border border-border p-0.5'
            >
              {VIEWS.map((v) => (
                <button
                  key={v.key}
                  type='button'
                  aria-pressed={view === v.key}
                  onClick={() => setParam({ view: v.key === 'file' ? null : v.key })}
                  className={cn(
                    'rounded px-2.5 py-1 text-[12px] transition-colors',
                    view === v.key
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-slate-600 hover:bg-muted dark:text-slate-300'
                  )}
                >
                  {v.label}
                </button>
              ))}
            </fieldset>
          </div>

          {report?.truncated && (
            <p className='border-b border-border bg-amber-500/10 px-5 py-2 text-[12px] text-amber-800 dark:text-amber-300'>
              Only the newest 20,000 downloads in this range are counted. Narrow the dates to see
              the rest.
            </p>
          )}

          <div className='p-5'>
            {active.isLoading ? (
              <div className='space-y-2'>
                {SKELETON_ROWS.map((n) => (
                  <Skeleton key={n} className='h-8 w-full' />
                ))}
              </div>
            ) : active.isError ? (
              <QueryErrorState
                error={active.error}
                what='the downloads'
                onRetry={() => void active.refetch()}
              />
            ) : (report?.rows.length ?? 0) === 0 ? (
              <p className='text-[13px] text-slate-600 dark:text-muted-foreground'>
                No downloads in this range. Downloads are logged from the release that added this
                report onward.
              </p>
            ) : viewEmpty ? (
              <p className='text-[13px] text-slate-600 dark:text-muted-foreground'>
                {view === 'record'
                  ? 'None of these downloads came from a record: the files were opened from the file library or a direct link.'
                  : 'No file matches the search.'}
              </p>
            ) : (
              <div className='overflow-x-auto rounded-lg border border-border bg-card'>
                <table className='w-full text-[12px]'>
                  {view === 'file' && (
                    <>
                      <thead className='border-b border-border text-left text-slate-600 dark:text-muted-foreground'>
                        <tr>
                          <th className={th}>File</th>
                          <th className={th}>Record</th>
                          <th className={`${th} text-right`}>Downloads</th>
                          <th className={`${th} text-right`}>People</th>
                          <th className={th}>Last</th>
                        </tr>
                      </thead>
                      <tbody>
                        {byFile.map((f) => (
                          <tr
                            key={f.file}
                            className='border-b border-border last:border-0 hover:bg-muted/50'
                          >
                            <td className={`${td} max-w-[360px]`}>
                              <button
                                type='button'
                                data-tip='Show who downloaded this file'
                                onClick={() => setParam({ file: f.file, view: 'all' })}
                                className='block max-w-full truncate text-left text-nvr-navy hover:underline dark:text-nvr-cyan'
                              >
                                {f.name ?? f.file}
                              </button>
                              {dupNames.has((f.name ?? '').toLowerCase()) && (
                                <span className='font-mono text-[10.5px] text-slate-500'>
                                  {f.file.slice(0, 8).toLowerCase()}
                                </span>
                              )}
                            </td>
                            <td className={td}>
                              {f.records.length === 0 ? (
                                <NotOnRecord />
                              ) : (
                                <span className='flex flex-wrap gap-x-2'>
                                  {f.records.slice(0, 3).map((r) => (
                                    <RecordLink
                                      key={`${r.collection}:${r.item}`}
                                      collection={r.collection}
                                      item={r.item}
                                      labels={labels}
                                    />
                                  ))}
                                  {f.records.length > 3 && (
                                    <span className='text-slate-500'>+{f.records.length - 3}</span>
                                  )}
                                </span>
                              )}
                            </td>
                            <td className={`${td} text-right tabular-nums`}>{f.count}</td>
                            <td className={`${td} text-right tabular-nums`}>{f.people}</td>
                            <td className={`${td} whitespace-nowrap`}>{when(f.last)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}
                  {view === 'person' && (
                    <>
                      <thead className='border-b border-border text-left text-slate-600 dark:text-muted-foreground'>
                        <tr>
                          <th className={th}>Person</th>
                          <th className={`${th} text-right`}>Files</th>
                          <th className={`${th} text-right`}>Downloads</th>
                          <th className={th}>Last</th>
                        </tr>
                      </thead>
                      <tbody>
                        {byPerson.map((p) => (
                          <tr
                            key={p.user}
                            className='border-b border-border last:border-0 hover:bg-muted/50'
                          >
                            <td className={td}>
                              <button
                                type='button'
                                data-tip='Show this person’s downloads'
                                className='text-nvr-navy hover:underline dark:text-nvr-cyan'
                                onClick={() => setParam({ person: p.user, view: 'all' })}
                              >
                                {p.name}
                              </button>
                            </td>
                            <td className={`${td} text-right tabular-nums`}>{p.files}</td>
                            <td className={`${td} text-right tabular-nums`}>{p.count}</td>
                            <td className={`${td} whitespace-nowrap`}>{when(p.last)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}
                  {view === 'record' && (
                    <>
                      <thead className='border-b border-border text-left text-slate-600 dark:text-muted-foreground'>
                        <tr>
                          <th className={th}>Record</th>
                          <th className={`${th} text-right`}>Files</th>
                          <th className={`${th} text-right`}>Downloads</th>
                          <th className={th}>Last</th>
                        </tr>
                      </thead>
                      <tbody>
                        {byRecord.map((r) => (
                          <tr
                            key={`${r.collection}:${r.item}`}
                            className='border-b border-border last:border-0 hover:bg-muted/50'
                          >
                            <td className={td}>
                              <RecordLink collection={r.collection} item={r.item} labels={labels} />
                            </td>
                            <td className={`${td} text-right tabular-nums`}>{r.files}</td>
                            <td className={`${td} text-right tabular-nums`}>{r.count}</td>
                            <td className={`${td} whitespace-nowrap`}>{when(r.last)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}
                  {view === 'all' && (
                    <>
                      <thead className='border-b border-border text-left text-slate-600 dark:text-muted-foreground'>
                        <tr>
                          <th className={th}>When</th>
                          <th className={th}>Person</th>
                          <th className={th}>File</th>
                          <th className={th}>Record</th>
                          <th className={th}>Action</th>
                          <th className={th}>Opened in</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.slice(0, 2000).map((r) => (
                          <tr
                            key={r.activity_id}
                            className='border-b border-border last:border-0 hover:bg-muted/50'
                          >
                            <td className={`${td} whitespace-nowrap`}>{when(r.at)}</td>
                            <td className={td}>{r.person}</td>
                            <td className={`${td} max-w-[300px] truncate`}>{r.name ?? r.file}</td>
                            <td className={td}>
                              {r.collection && r.item && r.collection !== 'nivaro_files' ? (
                                <RecordLink
                                  collection={r.collection}
                                  item={r.item}
                                  labels={labels}
                                />
                              ) : (
                                <NotOnRecord />
                              )}
                            </td>
                            <td className={td}>{r.kind === 'open' ? 'Opened' : 'Downloaded'}</td>
                            <td className={`${td} text-slate-600 dark:text-muted-foreground`}>
                              {appName(r.app)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}
                </table>
                {view === 'all' && total > 2000 && (
                  <p className='border-t border-border px-3 py-2 text-[12px] text-slate-600 dark:text-muted-foreground'>
                    Showing the newest 2,000. Export CSV for all {formatNumber(total)}.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
