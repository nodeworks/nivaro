import {
  ErrorNotice,
  toastError,
  useFreshIds,
  useLiveOps,
  useLiveRefetchInterval
} from '@nivaro/shared'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertOctagon, Plus, Search, X } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { CollectionSelect } from '@/components/collection-select'
import { CrashesView } from '@/components/crashes-view'
import { MonCombobox } from '@/components/filter-combobox'
import { IssueGroupsView } from '@/components/issue-groups-view'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn, formatRelative } from '@/lib/utils'
import { SeverityDot, SeverityLabel, SourceTag, StatusBadge } from './issues/badges'
import { IssueDetailPanel } from './issues/IssueDetailPanel'
import { parseIssueTitle } from './issues/issue-title'
import {
  type CmsUser,
  type Issue,
  type IssueSummary,
  lastSeen,
  personName,
  SEVERITIES,
  SOURCE_LABEL,
  STATUSES,
  statusLabel,
  userLabel
} from './issues/types'

const PAGE = 100
const MAX_ROWS = 500

const SORTS = [
  { value: 'last_seen', label: 'Last seen' },
  { value: 'newest', label: 'Newest first' },
  { value: 'count', label: 'Most frequent' },
  { value: 'severity', label: 'Most severe' },
  { value: 'updated', label: 'Recently changed' }
]

const STATUS_TABS = ['open', 'in_progress', 'resolved', 'closed', ''] as const

// ─── Small pieces ─────────────────────────────────────────────────────────────

function Segmented<T extends string>({
  value,
  onChange,
  options,
  label
}: {
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; label: ReactNode; data?: string }>
  label: string
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a segmented control, not a form fieldset
    <div
      role='group'
      aria-label={label}
      className='flex shrink-0 rounded-md border border-slate-200 bg-white p-0.5 dark:border-border dark:bg-card'
    >
      {options.map((o) => (
        <button
          key={o.value || 'all'}
          type='button'
          aria-pressed={value === o.value}
          data-issues-view={o.data}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded px-2 py-0.5 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
            value === o.value
              ? 'bg-nvr-cyan/15 text-slate-900 dark:text-foreground'
              : 'text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Count({ n }: { n?: number }) {
  if (n == null) return null
  return <span className='ml-1 tabular-nums text-muted-foreground'>{n}</span>
}

// ─── Create panel ────────────────────────────────────────────────────────────

function CreateIssuePanel({
  users,
  onCreated,
  onCancel
}: {
  users: CmsUser[]
  onCreated: (id: number | null) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState('')
  const [severity, setSeverity] = useState('medium')
  const [collection, setCollection] = useState('')
  const [item, setItem] = useState('')
  const [assignedTo, setAssignedTo] = useState('')

  const createMut = useMutation({
    mutationFn: () =>
      api.post<{ data?: { id?: number } }>('/issues', {
        title: title.trim(),
        severity,
        collection: collection || null,
        item: item.trim() || null,
        assigned_to: assignedTo || null
      }),
    onSuccess: (r) => {
      toast.success('Issue raised')
      onCreated(r.data?.data?.id ?? null)
    },
    onError: (err) => toastError(err, 'Could not raise the issue')
  })

  return (
    <form
      className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'
      onSubmit={(e) => {
        e.preventDefault()
        if (title.trim() && !createMut.isPending) createMut.mutate()
      }}
    >
      <div className='grid gap-3 lg:grid-cols-4'>
        <div className='space-y-1 lg:col-span-4'>
          <Label
            htmlFor='new-issue-title'
            className='text-[11.5px] text-slate-600 dark:text-muted-foreground'
          >
            What is wrong?
          </Label>
          <Input
            id='new-issue-title'
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder='e.g. Forecast totals on PO 155260 do not match the lines'
            className='h-8 text-[12.5px]'
            maxLength={500}
          />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11.5px] text-slate-600 dark:text-muted-foreground'>
            Severity
          </Label>
          <MonCombobox
            value={severity}
            onChange={(v) => v && setSeverity(v)}
            options={SEVERITIES.map((s) => ({
              value: s,
              label: s.charAt(0).toUpperCase() + s.slice(1)
            }))}
            className='w-full'
          />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11.5px] text-slate-600 dark:text-muted-foreground'>
            Assign to
          </Label>
          <MonCombobox
            value={assignedTo}
            onChange={setAssignedTo}
            options={users.map((u) => ({ value: u.id, label: userLabel(u) }))}
            placeholder='No one yet'
            className='w-full'
          />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11.5px] text-slate-600 dark:text-muted-foreground'>
            Collection
          </Label>
          <CollectionSelect
            value={collection}
            onChange={setCollection}
            placeholder='None'
            className='w-full'
          />
        </div>
        <div className='space-y-1'>
          <Label
            htmlFor='new-issue-item'
            className='text-[11.5px] text-slate-600 dark:text-muted-foreground'
          >
            Record id
          </Label>
          <Input
            id='new-issue-item'
            value={item}
            onChange={(e) => setItem(e.target.value)}
            placeholder={collection ? 'The record this is about' : 'Pick a collection first'}
            disabled={!collection}
            className='h-8 font-mono text-[12px]'
          />
        </div>
      </div>
      <div className='mt-3 flex justify-end gap-2'>
        <Button
          type='button'
          variant='ghost'
          size='sm'
          className='h-7 text-[12px]'
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type='submit'
          size='sm'
          className='h-7 text-[12px]'
          disabled={createMut.isPending || !title.trim()}
        >
          {createMut.isPending ? 'Raising…' : 'Raise issue'}
        </Button>
      </div>
    </form>
  )
}

// ─── List row ────────────────────────────────────────────────────────────────

function IssueRow({
  issue,
  active,
  selected,
  fresh,
  showStatus,
  onOpen,
  onSelect
}: {
  issue: Issue
  active: boolean
  selected: boolean
  fresh: boolean
  showStatus: boolean
  onOpen: () => void
  onSelect: (v: boolean) => void
}) {
  const t = parseIssueTitle(issue.title)
  const count = issue.occurrence_count ?? 0
  const assignee = personName(issue.assigned_to_name, issue.assigned_to_email)
  return (
    <li
      id={`issue-row-${issue.id}`}
      data-issue-fresh={fresh ? 'true' : undefined}
      data-active={active ? 'true' : undefined}
      className={cn(
        'group relative flex items-start gap-3 border-b border-slate-100 px-4 py-2.5 transition-colors duration-500 dark:border-white/[0.06]',
        active ? 'bg-nvr-cyan/[0.12]' : 'hover:bg-slate-50 dark:hover:bg-muted/40',
        fresh && !active && 'bg-nvr-cyan/10'
      )}
    >
      <label className='-m-1.5 flex h-8 w-8 shrink-0 cursor-pointer items-start justify-center pt-2.5 sm:h-6 sm:w-6 sm:pt-2'>
        <input
          type='checkbox'
          checked={selected}
          onChange={(e) => onSelect(e.target.checked)}
          aria-label={`Select issue ${issue.id}`}
          className='h-3.5 w-3.5 cursor-pointer accent-nvr-cyan'
        />
      </label>
      <button
        type='button'
        onClick={onOpen}
        aria-current={active ? 'true' : undefined}
        className='-my-1 flex min-w-0 flex-1 items-start gap-3 rounded py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan'
      >
        <span className='mt-[5px] flex' data-tip={issue.severity}>
          <SeverityDot severity={issue.severity} />
          <span className='sr-only'>{issue.severity} severity</span>
        </span>
        <span className='min-w-0 flex-1'>
          <span className='flex min-w-0 items-baseline gap-2'>
            <span
              className={cn(
                'truncate text-[13px] text-slate-900 dark:text-foreground',
                active ? 'font-semibold' : 'font-medium'
              )}
            >
              {t.headline}
            </span>
            {count > 1 && (
              <span
                className='shrink-0 rounded-full bg-slate-100 px-1.5 text-[10.5px] font-semibold tabular-nums text-slate-600 dark:bg-muted dark:text-muted-foreground'
                data-issue-count={count}
                data-tip={`Happened ${count} times`}
              >
                ×{count}
              </span>
            )}
          </span>
          <span className='mt-0.5 flex min-w-0 items-center gap-2 text-[11.5px] text-muted-foreground'>
            {(issue.severity === 'critical' || issue.severity === 'high') && (
              <SeverityLabel severity={issue.severity} />
            )}
            <SourceTag source={issue.source ?? t.source} />
            {showStatus && <StatusBadge status={issue.status} />}
            {t.where && <span className='min-w-0 truncate font-mono text-[11px]'>{t.where}</span>}
            {issue.collection && !t.where && (
              <span className='min-w-0 truncate font-mono text-[11px]'>
                {issue.collection}
                {issue.item ? `/${issue.item}` : ''}
              </span>
            )}
          </span>
        </span>
        <span className='hidden shrink-0 flex-col items-end gap-0.5 text-right text-[11.5px] sm:flex'>
          <span className='tabular-nums text-slate-700 dark:text-foreground' data-tip='Last seen'>
            {formatRelative(lastSeen(issue))}
          </span>
          {assignee && (
            <span className='max-w-[140px] truncate text-muted-foreground'>{assignee}</span>
          )}
        </span>
      </button>
    </li>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function IssuesPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { user: me } = useAuth()
  const isAdmin = !!me?.is_admin
  const [search, setSearch] = useSearchParams()

  // Filters live in the URL so a filtered list can be shared and survives a reload.
  const status = search.get('status') ?? 'open'
  const severity = search.get('severity') ?? ''
  const source = search.get('source') ?? ''
  const assignee = search.get('assignee') ?? ''
  const collection = search.get('collection') ?? ''
  const sort = search.get('sort') ?? 'last_seen'
  const q = search.get('q') ?? ''
  const view = (isAdmin && (search.get('view') as 'grouped' | 'crashes' | null)) || 'list'

  const setParam = useCallback(
    (patch: Record<string, string | null>) => {
      setSearch(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const [k, v] of Object.entries(patch)) {
            if (v == null || v === '') next.delete(k)
            else next.set(k, v)
          }
          return next
        },
        { replace: true }
      )
    },
    [setSearch]
  )

  const [draftQ, setDraftQ] = useState(q)
  useEffect(() => setDraftQ(q), [q])
  useEffect(() => {
    if (draftQ === q) return
    const t = setTimeout(() => setParam({ q: draftQ.trim() || null }), 250)
    return () => clearTimeout(t)
  }, [draftQ, q, setParam])

  const [limit, setLimit] = useState(PAGE)
  useEffect(() => setLimit(PAGE), [status, severity, source, assignee, collection, sort, q])

  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  // Deep link /issues/:id opens that issue; picking one keeps the URL in step.
  const { id: routeId } = useParams()
  const routeNum = routeId && /^\d+$/.test(routeId) ? Number(routeId) : null
  const [openId, setOpenId] = useState<number | null>(routeNum)
  useEffect(() => {
    if (routeNum != null) setOpenId(routeNum)
  }, [routeNum])
  const qsNow = search.toString()
  const openIssue = useCallback(
    (id: number | null) => {
      setOpenId(id)
      navigate(`/issues${id != null ? `/${id}` : ''}${qsNow ? `?${qsNow}` : ''}`, {
        replace: true
      })
    },
    [navigate, qsNow]
  )

  const listParams = new URLSearchParams()
  if (status) listParams.set('status', status)
  if (severity) listParams.set('severity', severity)
  if (source) listParams.set('source', source)
  if (assignee) listParams.set('assigned_to', assignee)
  if (collection) listParams.set('collection', collection)
  if (q) listParams.set('q', q)
  listParams.set('sort', sort)
  listParams.set('limit', String(limit))
  const qs = listParams.toString()

  // #2450 — the `issues` topic refreshes the list; the poll is a safety net while the socket is live.
  const issuesPoll = useLiveRefetchInterval(60_000)
  const listQuery = useQuery<{ rows: Issue[]; total: number }>({
    queryKey: ['issues', qs],
    queryFn: () =>
      api
        .get<{ data: Issue[]; meta?: { total?: number } }>(`/issues?${qs}`)
        .then((r) => ({ rows: r.data.data, total: r.data.meta?.total ?? r.data.data.length })),
    refetchInterval: issuesPoll,
    placeholderData: keepPreviousData
  })
  const issues = listQuery.data?.rows ?? []
  const total = listQuery.data?.total ?? 0
  const isLoading = listQuery.isLoading

  const { data: summary } = useQuery<IssueSummary>({
    queryKey: ['issues-summary'],
    queryFn: () => api.get<{ data: IssueSummary }>('/issues/summary').then((r) => r.data.data)
  })

  useLiveOps('issues', () => {
    void qc.invalidateQueries({ queryKey: ['issues'] })
    void qc.invalidateQueries({ queryKey: ['issues-summary'] })
    void qc.invalidateQueries({ queryKey: ['issue-full'] })
  })
  const freshIds = useFreshIds(issues.map((i) => i.id))

  const { data: users = [] } = useQuery<CmsUser[]>({
    queryKey: ['users-list-for-issues'],
    queryFn: () => api.get<{ data: CmsUser[] }>('/users').then((r) => r.data.data),
    staleTime: 60_000
  })

  // An opened issue the current list does not hold (deep link, older than the page, another
  // filter): fetched on its own and pinned on top. Keyed under ['issues'] so every invalidation
  // after an edit refreshes it too.
  const openInList = openId != null && issues.some((i) => i.id === openId)
  const { data: linkedRaw, isError: linkedMissing } = useQuery({
    queryKey: ['issues', 'linked', openId],
    queryFn: () => api.get<{ data: Issue }>(`/issues/${openId}`).then((r) => r.data.data),
    enabled: openId != null && !isLoading && !openInList,
    retry: false,
    staleTime: 60_000
  })
  const linkedIssue = useMemo(() => {
    if (!linkedRaw || openInList) return null
    // The single-issue route returns the raw row: names come from the directory.
    const find = (id: string | null) =>
      id ? users.find((u) => u.id.toLowerCase() === id.toLowerCase()) : undefined
    const raiser = find(linkedRaw.raised_by)
    const owner = find(linkedRaw.assigned_to)
    return {
      ...linkedRaw,
      raised_by_name: linkedRaw.raised_by_name ?? (raiser ? userLabel(raiser) : null),
      raised_by_email: linkedRaw.raised_by_email ?? raiser?.email ?? null,
      assigned_to_name: linkedRaw.assigned_to_name ?? (owner ? userLabel(owner) : null),
      assigned_to_email: linkedRaw.assigned_to_email ?? owner?.email ?? null
    }
  }, [linkedRaw, openInList, users])
  const rows = useMemo(
    () => (linkedIssue ? [linkedIssue, ...issues] : issues),
    [linkedIssue, issues]
  )
  const current = rows.find((i) => i.id === openId) ?? null
  const index = current ? rows.indexOf(current) : -1

  useEffect(() => {
    if (openId == null) return
    requestAnimationFrame(() =>
      document.getElementById(`issue-row-${openId}`)?.scrollIntoView({ block: 'nearest' })
    )
  }, [openId])

  // Keyboard: j/k (or ↓/↑) move, Esc closes, / searches, x selects the open issue.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (
        el?.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"], [cmdk-root]'
        )
      ) {
        if (e.key === 'Escape' && el === searchRef.current) searchRef.current?.blur()
        return
      }
      if (view !== 'list') return
      if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === 'Escape' && openId != null) {
        openIssue(null)
      } else if (e.key === 'j' || (e.key === 'ArrowDown' && openId != null)) {
        const next = rows[index + 1] ?? (index < 0 ? rows[0] : null)
        if (next) {
          e.preventDefault()
          openIssue(next.id)
        }
      } else if (e.key === 'k' || (e.key === 'ArrowUp' && openId != null)) {
        const prev = index > 0 ? rows[index - 1] : null
        if (prev) {
          e.preventDefault()
          openIssue(prev.id)
        }
      } else if (e.key === 'x' && current) {
        setSelected((s) => {
          const n = new Set(s)
          if (n.has(current.id)) n.delete(current.id)
          else n.add(current.id)
          return n
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rows, index, current, openId, openIssue, view])

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ['issues'] })
    void qc.invalidateQueries({ queryKey: ['issues-summary'] })
    void qc.invalidateQueries({ queryKey: ['issue-full'] })
  }

  const bulk = async (path: string, body: Record<string, unknown>, done: string) => {
    setBulkBusy(true)
    try {
      const r = await api.post<{ data?: { updated?: number } }>(path, {
        ids: [...selected],
        ...body
      })
      const n = r.data?.data?.updated ?? selected.size
      toast.success(`${n} issue${n === 1 ? '' : 's'} ${done}`)
      setSelected(new Set())
      refreshAll()
    } catch (err) {
      toastError(err, 'Could not update the selected issues')
    } finally {
      setBulkBusy(false)
    }
  }

  const filtersOn = !!(severity || source || assignee || collection || q)
  const clearFilters = () =>
    setParam({ severity: null, source: null, assignee: null, collection: null, q: null })
  const severityList = severity ? severity.split(',') : []
  const toggleSeverity = (s: string) => {
    const next = severityList.includes(s)
      ? severityList.filter((x) => x !== s)
      : [...severityList, s]
    setParam({
      severity: next.length ? SEVERITIES.filter((x) => next.includes(x)).join(',') : null
    })
  }

  const by = summary?.by_status ?? {}
  const active = (by.open ?? 0) + (by.in_progress ?? 0)
  const activeSev = summary?.active_by_severity ?? {}
  const urgent = (activeSev.critical ?? 0) + (activeSev.high ?? 0)
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const openFromView = (id: number) => {
    setSearch(new URLSearchParams({ status: '' }), { replace: true })
    openIssue(id)
  }

  return (
    <div className='flex min-h-0 flex-1 flex-col bg-slate-50 dark:bg-background'>
      {/* Header */}
      <header className='flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 bg-white px-6 py-3.5 dark:border-border dark:bg-card'>
        <div className='flex min-w-0 items-center gap-2.5'>
          <AlertOctagon className='h-5 w-5 shrink-0 text-muted-foreground' aria-hidden />
          <h1 className='text-[18px] font-semibold tracking-[-0.01em]'>Issue log</h1>
        </div>
        {summary && (
          <p
            className='min-w-0 max-w-full truncate text-[12.5px] text-muted-foreground sm:whitespace-normal'
            data-issues-summary
          >
            <span className='font-medium text-slate-800 dark:text-foreground'>{active}</span> need
            attention
            {urgent > 0 && (
              <>
                {' · '}
                <button
                  type='button'
                  className='font-medium text-orange-700 underline-offset-2 hover:underline dark:text-orange-400'
                  onClick={() => setParam({ status: 'active', severity: 'critical,high' })}
                >
                  {urgent} high or critical
                </button>
              </>
            )}
            {(summary.unassigned_active ?? 0) > 0 && (
              <>
                {' · '}
                <button
                  type='button'
                  className='underline-offset-2 hover:text-foreground hover:underline'
                  onClick={() => setParam({ status: 'active', assignee: 'unassigned' })}
                >
                  {summary.unassigned_active} unassigned
                </button>
              </>
            )}
            {(summary.new_24h ?? 0) > 0 && <> · {summary.new_24h} new today</>}
          </p>
        )}
        <div className='ml-auto flex items-center gap-2'>
          {isAdmin && (
            <Segmented
              label='View'
              value={view}
              onChange={(v) => setParam({ view: v === 'list' ? null : v })}
              options={[
                { value: 'list', label: 'List', data: 'list' },
                { value: 'grouped', label: 'Grouped', data: 'grouped' },
                { value: 'crashes', label: 'Crashes', data: 'crashes' }
              ]}
            />
          )}
          <Button size='sm' className='h-8 gap-1.5' onClick={() => setCreating((v) => !v)}>
            {creating ? <X className='h-4 w-4' /> : <Plus className='h-4 w-4' />}
            {creating ? 'Close' : 'Raise issue'}
          </Button>
        </div>
      </header>

      {creating && (
        <CreateIssuePanel
          users={users}
          onCreated={(id) => {
            setCreating(false)
            refreshAll()
            if (id != null) openIssue(id)
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {view === 'crashes' ? (
        <div className='min-h-0 flex-1 overflow-y-auto'>
          <CrashesView onOpen={openFromView} />
        </div>
      ) : view === 'grouped' ? (
        <div className='min-h-0 flex-1 overflow-y-auto'>
          <IssueGroupsView onOpen={openFromView} />
        </div>
      ) : (
        <>
          {/* Status tabs */}
          <nav
            aria-label='Status'
            className='flex shrink-0 items-end gap-1 overflow-x-auto border-b [scrollbar-width:none] [&::-webkit-scrollbar]:hidden border-slate-200 bg-white px-4 dark:border-border dark:bg-card'
          >
            {STATUS_TABS.map((s) => {
              const n = s === '' ? Object.values(by).reduce((a, b) => a + b, 0) : by[s]
              const on = status === s
              return (
                <button
                  key={s || 'all'}
                  type='button'
                  aria-current={on ? 'page' : undefined}
                  onClick={() => setParam({ status: s === 'open' ? null : s || '' })}
                  className={cn(
                    'relative whitespace-nowrap px-2.5 pb-2 pt-2 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan',
                    on
                      ? 'text-slate-900 after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-nvr-cyan dark:text-foreground'
                      : 'text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
                  )}
                >
                  {statusLabel(s)}
                  {summary && <Count n={n ?? 0} />}
                </button>
              )
            })}
            {status === 'active' && (
              <span className='relative whitespace-nowrap px-2.5 pb-2 pt-2 text-[12.5px] font-medium text-slate-900 after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-nvr-cyan dark:text-foreground'>
                Open + in progress
                <Count n={active} />
              </span>
            )}
          </nav>

          {/* Filters */}
          <div className='flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2 dark:border-border dark:bg-card'>
            <div className='relative w-full sm:w-72'>
              <Search
                className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground'
                aria-hidden
              />
              <Input
                ref={searchRef}
                type='search'
                value={draftQ}
                onChange={(e) => setDraftQ(e.target.value)}
                placeholder={isAdmin ? 'Search titles, details or #id' : 'Search titles or #id'}
                aria-label='Search issues'
                className='h-8 pl-8 pr-8 text-[12.5px]'
              />
              {!draftQ && (
                <kbd className='pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-slate-200 px-1 font-mono text-[10px] text-muted-foreground dark:border-border'>
                  /
                </kbd>
              )}
            </div>
            <div className='-mx-4 flex w-[calc(100%+2rem)] items-center gap-2 overflow-x-auto px-4 [mask-image:linear-gradient(to_right,black_88%,transparent)] [scrollbar-width:none] sm:mx-0 sm:w-auto sm:flex-wrap sm:overflow-visible sm:px-0 sm:[mask-image:none] [&::-webkit-scrollbar]:hidden'>
              {/* biome-ignore lint/a11y/useSemanticElements: chip group, not a fieldset */}
              <div role='group' aria-label='Severity' className='flex shrink-0 items-center gap-1'>
                {SEVERITIES.map((s) => {
                  const on = severityList.includes(s)
                  return (
                    <button
                      key={s}
                      type='button'
                      aria-pressed={on}
                      onClick={() => toggleSeverity(s)}
                      className={cn(
                        'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[11.5px] font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
                        on
                          ? 'border-nvr-cyan/50 bg-nvr-cyan/10 text-slate-900 dark:text-foreground'
                          : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900 dark:border-border dark:bg-card dark:text-muted-foreground dark:hover:text-foreground'
                      )}
                    >
                      <SeverityDot severity={s} />
                      {s}
                      {summary?.active_by_severity && (
                        <span className='tabular-nums text-muted-foreground'>
                          {summary.active_by_severity[s] ?? 0}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
              <Segmented
                label='Assigned to'
                value={assignee}
                onChange={(v) => setParam({ assignee: v || null })}
                options={[
                  { value: '', label: 'Anyone' },
                  {
                    value: 'me',
                    label: (
                      <>
                        Mine
                        <Count n={summary?.mine_active} />
                      </>
                    )
                  },
                  {
                    value: 'unassigned',
                    label: (
                      <>
                        Unassigned
                        <Count n={summary?.unassigned_active} />
                      </>
                    )
                  }
                ]}
              />
              <Segmented
                label='Source'
                value={source}
                onChange={(v) => setParam({ source: v || null })}
                options={[
                  { value: '', label: 'All sources' },
                  ...(['server', 'client', 'manual'] as const).map((s) => ({
                    value: s,
                    label: SOURCE_LABEL[s]
                  }))
                ]}
              />
              <CollectionSelect
                value={collection}
                onChange={(v) => setParam({ collection: v || null })}
                className='w-52 shrink-0'
              />
              <MonCombobox
                value={sort}
                onChange={(v) => setParam({ sort: v && v !== 'last_seen' ? v : null })}
                options={SORTS}
                className='w-36 shrink-0 sm:hidden'
              />
            </div>
            <div className='ml-auto flex items-center gap-2'>
              {filtersOn && (
                <Button
                  variant='ghost'
                  size='sm'
                  className='h-7 text-[12px]'
                  onClick={clearFilters}
                >
                  Clear filters
                </Button>
              )}
              <MonCombobox
                value={sort}
                onChange={(v) => setParam({ sort: v && v !== 'last_seen' ? v : null })}
                options={SORTS}
                className='hidden w-40 sm:flex'
              />
            </div>
          </div>

          {/* Bulk bar */}
          {selected.size > 0 && (
            <div className='flex shrink-0 flex-wrap items-center gap-2 border-b border-nvr-cyan/30 bg-nvr-cyan/[0.06] px-4 py-2'>
              <span className='mr-1 text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                {selected.size} selected
              </span>
              {STATUSES.map((s) => (
                <Button
                  key={s}
                  size='sm'
                  variant='outline'
                  className='h-7 text-[12px]'
                  disabled={bulkBusy}
                  onClick={() =>
                    bulk(
                      '/issues/bulk-status',
                      { status: s },
                      `marked ${statusLabel(s).toLowerCase()}`
                    )
                  }
                >
                  {s === 'open' ? 'Reopen' : `Mark ${statusLabel(s).toLowerCase()}`}
                </Button>
              ))}
              {me?.id && (
                <Button
                  size='sm'
                  variant='outline'
                  className='h-7 text-[12px]'
                  disabled={bulkBusy}
                  onClick={() =>
                    bulk('/issues/bulk-assign', { assigned_to: 'me' }, 'assigned to you')
                  }
                >
                  Assign to me
                </Button>
              )}
              <Button
                size='sm'
                variant='ghost'
                className='ml-auto h-7 text-[12px]'
                onClick={() => setSelected(new Set())}
              >
                Clear selection
              </Button>
            </div>
          )}

          {linkedMissing && openId != null && (
            <p
              id='issue-linked-missing'
              className='shrink-0 border-b border-amber-200 bg-amber-50 px-6 py-2 text-[12.5px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
            >
              Issue #{openId} was not found. It may have been deleted, or you may not have access to
              it.
            </p>
          )}

          <div className='flex min-h-0 flex-1'>
            {/* List */}
            <section
              aria-label='Issues'
              className={cn(
                'flex min-h-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card',
                current ? 'hidden w-[44%] min-w-[380px] max-w-[620px] lg:flex' : 'min-w-0 flex-1'
              )}
            >
              <div className='flex shrink-0 items-center gap-3 border-b border-slate-100 px-4 py-1.5 text-[11.5px] text-muted-foreground dark:border-border/60'>
                <input
                  type='checkbox'
                  checked={allSelected}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(rows.map((i) => i.id)) : new Set())
                  }
                  aria-label='Select every issue shown'
                  className='h-3.5 w-3.5 cursor-pointer accent-nvr-cyan'
                  disabled={rows.length === 0}
                  data-issues-select-all
                />
                <span aria-live='polite'>
                  {isLoading
                    ? 'Loading…'
                    : total > rows.length
                      ? `${rows.length} of ${total}`
                      : `${rows.length} ${rows.length === 1 ? 'issue' : 'issues'}`}
                </span>
                {listQuery.isFetching && !isLoading && <span>· updating</span>}
                {!current && (
                  <span className='ml-auto hidden md:inline'>
                    <kbd className='font-mono'>j</kbd>/<kbd className='font-mono'>k</kbd> to move ·{' '}
                    <kbd className='font-mono'>/</kbd> to search
                  </span>
                )}
              </div>
              <div className='min-h-0 flex-1 overflow-y-auto'>
                {listQuery.isError && !listQuery.data ? (
                  <div className='p-6'>
                    <ErrorNotice
                      error={listQuery.error}
                      what='the issue log'
                      onRetry={() => void listQuery.refetch()}
                    />
                  </div>
                ) : isLoading ? (
                  <ul aria-hidden className='divide-y divide-slate-100 dark:divide-border/50'>
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <li key={i} className='flex gap-3 px-4 py-3'>
                        <Skeleton className='h-3.5 w-3.5' />
                        <div className='flex-1 space-y-1.5'>
                          <Skeleton className='h-3.5 w-3/5' />
                          <Skeleton className='h-3 w-2/5' />
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : rows.length === 0 ? (
                  <div className='flex flex-col items-center px-6 py-20 text-center'>
                    <AlertOctagon className='mb-3 h-8 w-8 text-muted-foreground/40' aria-hidden />
                    <p className='text-[13.5px] font-medium'>
                      {filtersOn
                        ? 'Nothing matches these filters'
                        : status === 'open'
                          ? 'Nothing open right now'
                          : `No ${statusLabel(status).toLowerCase()} issues`}
                    </p>
                    <p className='mt-1 max-w-sm text-[12.5px] text-muted-foreground'>
                      {filtersOn
                        ? 'Try fewer filters, or clear them to see the whole log.'
                        : 'Server and browser errors are logged here as they happen. Raise one yourself for a data or process problem.'}
                    </p>
                    {filtersOn && (
                      <Button
                        variant='outline'
                        size='sm'
                        className='mt-4 h-7 text-[12px]'
                        onClick={clearFilters}
                      >
                        Clear filters
                      </Button>
                    )}
                  </div>
                ) : (
                  <>
                    <ul>
                      {rows.map((issue) => (
                        <IssueRow
                          key={issue.id}
                          issue={issue}
                          active={issue.id === openId}
                          selected={selected.has(issue.id)}
                          fresh={freshIds.has(String(issue.id))}
                          showStatus={
                            status === '' || status === 'active' || issue.id === linkedIssue?.id
                          }
                          onOpen={() => openIssue(issue.id === openId ? null : issue.id)}
                          onSelect={(v) =>
                            setSelected((prev) => {
                              const next = new Set(prev)
                              if (v) next.add(issue.id)
                              else next.delete(issue.id)
                              return next
                            })
                          }
                        />
                      ))}
                    </ul>
                    {total > issues.length && limit < MAX_ROWS && (
                      <div className='flex justify-center p-4'>
                        <Button
                          variant='outline'
                          size='sm'
                          className='h-7 text-[12px]'
                          disabled={listQuery.isFetching}
                          onClick={() => setLimit((l) => Math.min(MAX_ROWS, l + PAGE))}
                        >
                          Show more
                        </Button>
                      </div>
                    )}
                    {total > issues.length && limit >= MAX_ROWS && (
                      <p className='p-4 text-center text-[12px] text-muted-foreground'>
                        Showing the first {MAX_ROWS}. Narrow the filters or search to find the rest.
                      </p>
                    )}
                  </>
                )}
              </div>
            </section>

            {/* Detail */}
            {current && (
              <IssueDetailPanel
                key={current.id}
                issue={current}
                users={users}
                onClose={() => openIssue(null)}
                onPrev={index > 0 ? () => openIssue(rows[index - 1].id) : undefined}
                onNext={
                  index >= 0 && index < rows.length - 1
                    ? () => openIssue(rows[index + 1].id)
                    : undefined
                }
                position={
                  index >= 0
                    ? `${index + 1} of ${total > rows.length ? total : rows.length}`
                    : undefined
                }
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}
