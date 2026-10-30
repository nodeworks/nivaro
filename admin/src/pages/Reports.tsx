import {
  ActivityFeed,
  type ActivityLabels,
  collectionNouns,
  QueryErrorState,
  readableTitle,
  useActivityLabels
} from '@nivaro/shared'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Check, ChevronDown, ChevronsUpDown, Download, SlidersHorizontal, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import {
  type ActivityFilters,
  activityParams,
  cleanFilters,
  RANGE_LABELS
} from '@/components/activity/activity-search'
import {
  AUDIT_PRESETS,
  type AuditPresetId,
  actionBreakdown,
  activePreset,
  describeFilters,
  effectiveFilters,
  type PresetContext,
  presetFilters,
  type SummaryInput,
  splitReads,
  summaryPhrases
} from '@/components/activity/audit-report'
import { SavedViewsMenu } from '@/components/activity/saved-views'
import { HubToolbar } from '@/components/hub-page'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { UserCombobox } from '@/components/user-combobox'
import { type ActivityEntry, api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn, formatDate, formatNumber } from '@/lib/utils'

/**
 * Audit report (Activity hub → /activity/audit): who changed what and why, in sentences.
 * Rows render through the shared readable-activity kit (ActivityFeed: real actor, record
 * labels read as the reader, the reason, bursts folded); the filters speak GET /api/activity's
 * shape and the totals come from GET /api/reports/summary with the same filters. Reads are
 * left out unless "Show reads" is on — opening a record logs one, and they drown the rest.
 */

type ActivityResponse = {
  data: ActivityEntry[]
  total: number
  limit: number
  offset: number
  window_from?: string | null
}

type SummaryResponse = SummaryInput & {
  date_range: {
    from: string | null
    to: string | null
    default_days?: number | null
    range?: string | null
  }
  filtered?: boolean
}

type CollectionRow = { collection: string; display_name: string | null; singular?: string | null }

const PAGE_LIMIT = 50
const DEFAULT_FILTERS: ActivityFilters = { range: 'last_7_days' }
const COMMON_ACTIONS = ['create', 'update', 'delete', 'transition', 'login', 'export', 'read']

// ─── URL state ────────────────────────────────────────────────────────────────

const URL_KEYS = ['user', 'action', 'exclude_actions', 'collection', 'item', 'range', 'from', 'to']

function stateFromUrl(p: URLSearchParams): { filters: ActivityFilters; showReads: boolean } {
  if (!URL_KEYS.some((k) => p.has(k)) && !p.has('q') && !p.has('all'))
    return { filters: DEFAULT_FILTERS, showReads: p.get('reads') === '1' }
  const list = (k: string) =>
    p
      .getAll(k)
      .flatMap((v) => v.split(','))
      .map((v) => v.trim())
      .filter(Boolean)
  const split = splitReads(
    cleanFilters({
      user: p.get('user'),
      actions: list('action'),
      exclude_actions: list('exclude_actions'),
      collections: list('collection'),
      item: p.get('item'),
      range: p.get('range'),
      from: p.get('from'),
      to: p.get('to'),
      q: p.get('q')
    })
  )
  // Reads show only when the link asks for them and its filters do not leave them out.
  return { filters: split.filters, showReads: p.get('reads') === '1' && split.showReads }
}

function stateToUrl(f: ActivityFilters, showReads: boolean): URLSearchParams {
  const out = new URLSearchParams()
  for (const [k, v] of Object.entries(activityParams(f))) if (v) out.set(k, v)
  // "Any time" with nothing else still needs a marker, or the default window comes back.
  if ([...out.keys()].length === 0) out.set('all', '1')
  if (showReads) out.set('reads', '1')
  return out
}

// ─── Small pieces ─────────────────────────────────────────────────────────────

function errorText(e: unknown): string {
  const err = e as { response?: { data?: { error?: string } }; message?: string }
  return err?.response?.data?.error ?? err?.message ?? 'Something went wrong'
}

/** The picked person's name — same key and shape as the Activity page's person chip. */
function usePersonName(userId: string | null | undefined): string | null {
  const { data } = useQuery({
    queryKey: ['activity-chip-user', userId],
    queryFn: () =>
      api
        .get(`/users/${userId}`, { params: { fields: 'id,first_name,last_name,email' } })
        .then((r) => {
          const u = r.data.data as { first_name?: string; last_name?: string; email?: string }
          return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || null
        }),
    enabled: !!userId,
    staleTime: 300_000,
    retry: false
  })
  return data ?? null
}

interface PickOption {
  value: string
  label: string
  group?: string
}

/** Several values from a searchable list (Popover + Command), shown as removable chips. */
function MultiPicker({
  label,
  placeholder,
  options,
  value,
  onChange,
  empty
}: {
  label: string
  placeholder: string
  options: PickOption[]
  value: string[]
  onChange: (v: string[]) => void
  empty: string
}) {
  const [open, setOpen] = useState(false)
  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options])
  const groups = useMemo(() => {
    const out = new Map<string, PickOption[]>()
    for (const o of options) {
      const g = o.group ?? ''
      out.set(g, [...(out.get(g) ?? []), o])
    }
    return [...out]
  }, [options])
  const toggle = (v: string) =>
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v])
  return (
    <div className='space-y-1.5'>
      <Label className='text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
        {label}
      </Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant='outline'
            size='sm'
            role='combobox'
            aria-expanded={open}
            aria-label={label}
            className='h-8 w-full justify-between px-2.5 text-[12px] font-normal'
          >
            <span className={cn('truncate', !value.length && 'text-slate-400 dark:text-slate-500')}>
              {value.length === 0
                ? placeholder
                : value.length === 1
                  ? (byValue.get(value[0])?.label ?? value[0])
                  : `${value.length} chosen`}
            </span>
            <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 opacity-50' />
          </Button>
        </PopoverTrigger>
        <PopoverContent align='start' className='w-64 p-0'>
          <Command>
            <CommandInput placeholder='Search…' className='text-[12px]' />
            <CommandList>
              <CommandEmpty className='py-4 text-center text-[12px]'>{empty}</CommandEmpty>
              {groups.map(([g, list]) => (
                <CommandGroup key={g || 'all'} heading={g || undefined}>
                  {list.map((o) => (
                    <CommandItem
                      key={o.value}
                      value={`${o.label} ${o.value}`}
                      onSelect={() => toggle(o.value)}
                      className='text-[12px]'
                    >
                      <Check
                        className={cn(
                          'h-3.5 w-3.5',
                          value.includes(o.value) ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                      <span className='truncate'>{o.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value.length > 1 && (
        <div className='flex flex-wrap gap-1'>
          {value.map((v) => (
            <span
              key={v}
              className='inline-flex h-5 max-w-full items-center gap-0.5 rounded-full border border-slate-200 bg-slate-50 pl-2 pr-0.5 text-[11px] text-slate-700 dark:border-border dark:bg-muted/40 dark:text-slate-200'
            >
              <span className='truncate'>{byValue.get(v)?.label ?? v}</span>
              <button
                type='button'
                aria-label={`Remove ${byValue.get(v)?.label ?? v}`}
                onClick={() => toggle(v)}
                className='rounded-full p-0.5 hover:bg-slate-200 dark:hover:bg-muted'
              >
                <X className='h-2.5 w-2.5' />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Filter sidebar ───────────────────────────────────────────────────────────

const WHEN_OPTIONS = [
  { value: '', label: 'Any time' },
  ...Object.entries(RANGE_LABELS).map(([value, label]) => ({ value, label })),
  { value: 'custom', label: 'Between dates…' }
]

function FilterSidebar({
  applied,
  draft,
  setDraft,
  customDates,
  setCustomDates,
  showReads,
  onShowReads,
  onApply,
  onReset,
  onPreset,
  presetCtx,
  actionOptions,
  collectionOptions,
  open
}: {
  applied: ActivityFilters
  draft: ActivityFilters
  setDraft: React.Dispatch<React.SetStateAction<ActivityFilters>>
  customDates: boolean
  setCustomDates: (v: boolean) => void
  showReads: boolean
  onShowReads: (v: boolean) => void
  onApply: () => void
  onReset: () => void
  onPreset: (id: AuditPresetId) => void
  presetCtx: PresetContext
  actionOptions: PickOption[]
  collectionOptions: PickOption[]
  open: boolean
}) {
  const active = activePreset(applied, presetCtx)
  const when = customDates ? 'custom' : (draft.range ?? '')
  return (
    <aside
      className={cn(
        'shrink-0 flex-col border-b border-slate-200 bg-white md:flex md:w-[240px] md:border-b-0 md:border-r dark:border-border dark:bg-card',
        open ? 'flex' : 'hidden'
      )}
      aria-label='Report filters'
    >
      <div className='space-y-5 p-4 md:flex-1 md:overflow-y-auto'>
        <section className='space-y-1'>
          <p className='px-1 text-[11px] font-semibold text-slate-500 dark:text-muted-foreground'>
            Quick views
          </p>
          <div className='grid grid-cols-2 gap-1 md:grid-cols-1'>
            {AUDIT_PRESETS.map((p) => {
              const disabled = presetFilters(p.id, presetCtx) == null
              const on = active === p.id
              return (
                <button
                  key={p.id}
                  type='button'
                  disabled={disabled}
                  onClick={() => onPreset(p.id)}
                  aria-pressed={on}
                  className={cn(
                    'rounded-md px-2 py-1.5 text-left transition-colors disabled:opacity-50',
                    on ? 'bg-nvr-cyan/10' : 'hover:bg-muted'
                  )}
                >
                  <span
                    className={cn(
                      'block text-[12.5px] font-medium',
                      on ? 'text-nvr-navy dark:text-nvr-cyan' : 'text-slate-700 dark:text-slate-200'
                    )}
                  >
                    {p.label}
                  </span>
                  <span className='block text-[11px] text-slate-500 dark:text-slate-400'>
                    {p.hint}
                  </span>
                </button>
              )
            })}
          </div>
        </section>

        <section className='space-y-3.5 border-t border-slate-100 pt-4 dark:border-border'>
          <p className='text-[11px] font-semibold text-slate-500 dark:text-muted-foreground'>
            Narrow it down
          </p>
          <div className='space-y-1.5'>
            <Label className='text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
              When
            </Label>
            <SimpleSelect
              value={when}
              onChange={(v) => {
                if (v === 'custom') {
                  setCustomDates(true)
                  setDraft((p) => ({ ...p, range: null }))
                } else {
                  setCustomDates(false)
                  setDraft((p) => ({ ...p, range: v || null, from: null, to: null }))
                }
              }}
              options={WHEN_OPTIONS}
              ariaLabel='When'
              className='h-8 text-[12px]'
            />
            {customDates && (
              <div className='grid grid-cols-2 gap-1.5'>
                <Input
                  type='date'
                  aria-label='From'
                  value={draft.from ?? ''}
                  onChange={(e) => setDraft((p) => ({ ...p, from: e.target.value || null }))}
                  className='h-8 px-2 text-[12px]'
                />
                <Input
                  type='date'
                  aria-label='To'
                  value={draft.to ?? ''}
                  onChange={(e) => setDraft((p) => ({ ...p, to: e.target.value || null }))}
                  className='h-8 px-2 text-[12px]'
                />
              </div>
            )}
          </div>
          <MultiPicker
            label='What happened'
            placeholder='Anything'
            options={actionOptions}
            value={draft.actions ?? []}
            onChange={(v) => setDraft((p) => ({ ...p, actions: v }))}
            empty='No action by that name.'
          />
          <MultiPicker
            label='Where'
            placeholder='Every collection'
            options={collectionOptions}
            value={draft.collections ?? []}
            onChange={(v) => setDraft((p) => ({ ...p, collections: v }))}
            empty='No collection by that name.'
          />
          <div className='space-y-1.5'>
            <Label className='text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
              Who
            </Label>
            <div className='flex items-center gap-1'>
              <div className='min-w-0 flex-1'>
                <UserCombobox
                  value={draft.user ?? null}
                  onChange={(id) => setDraft((p) => ({ ...p, user: id }))}
                  searchServer
                  hideNone
                  placeholder='Anyone — type a name'
                  className='h-8 w-full text-[12px]'
                />
              </div>
              {draft.user && (
                <Button
                  variant='ghost'
                  size='sm'
                  className='h-8 w-8 shrink-0 p-0'
                  aria-label='Anyone'
                  onClick={() => setDraft((p) => ({ ...p, user: null }))}
                >
                  <X className='h-3.5 w-3.5' />
                </Button>
              )}
            </div>
          </div>
          <div className='space-y-1.5'>
            <Label
              htmlFor='audit-words'
              className='text-[11px] font-medium text-slate-500 dark:text-muted-foreground'
            >
              Words
            </Label>
            <Input
              id='audit-words'
              placeholder='A reason, record number…'
              value={draft.q ?? ''}
              onChange={(e) => setDraft((p) => ({ ...p, q: e.target.value || null }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onApply()
              }}
              className='h-8 text-[12px]'
            />
          </div>
        </section>

        <label
          htmlFor='audit-show-reads'
          className='flex items-start gap-2.5 border-t border-slate-100 pt-4 dark:border-border'
        >
          <Switch
            id='audit-show-reads'
            checked={showReads}
            onCheckedChange={onShowReads}
            className='mt-0.5'
          />
          <span>
            <span className='block text-[12.5px] font-medium text-slate-700 dark:text-slate-200'>
              Show reads
            </span>
            <span className='block text-[11px] leading-snug text-slate-500 dark:text-slate-400'>
              Every opened record is logged as a read, so they are hidden unless you ask.
            </span>
          </span>
        </label>
      </div>

      <div className='flex shrink-0 gap-2 border-t border-slate-100 p-4 md:flex-col dark:border-border'>
        <Button size='sm' className='flex-1 bg-nvr-cyan text-white md:w-full' onClick={onApply}>
          Apply filters
        </Button>
        <Button size='sm' variant='ghost' className='flex-1 md:w-full' onClick={onReset}>
          Back to last 7 days
        </Button>
      </div>
    </aside>
  )
}

// ─── Summary ──────────────────────────────────────────────────────────────────

function SummaryCard({
  heading,
  summary,
  loading,
  failed,
  onRetry,
  collectionName,
  listAnyTime,
  textWindowFrom
}: {
  heading: string | null
  summary: SummaryResponse | undefined
  loading: boolean
  failed: boolean
  onRetry: () => void
  collectionName: (c: string) => string
  listAnyTime: boolean
  textWindowFrom: string | null
}) {
  const phrases = summary ? summaryPhrases(summary, { collectionName, format: formatNumber }) : []
  const breakdown = summary ? actionBreakdown(summary, 4, formatNumber) : ''
  const notes: string[] = []
  if (listAnyTime && summary?.date_range.default_days)
    notes.push(`Totals cover the last ${summary.date_range.default_days} days.`)
  if (textWindowFrom) notes.push(`Word search reads back to ${formatDate(textWindowFrom)}.`)
  return (
    <section
      className='rounded-lg border border-slate-200 bg-white px-4 py-3.5 md:px-5 dark:border-border dark:bg-card'
      aria-live='polite'
      data-audit-summary
    >
      {heading ? (
        <h2 className='text-[14px] font-semibold leading-snug text-slate-900 dark:text-foreground'>
          {heading}
        </h2>
      ) : (
        <Skeleton className='h-5 w-3/4 rounded' />
      )}
      <div className='mt-1.5 space-y-1 text-[12.5px] leading-relaxed text-slate-600 dark:text-slate-300'>
        {loading ? (
          <Skeleton className='h-4 w-1/2 rounded' />
        ) : failed ? (
          <p className='text-slate-500 dark:text-slate-400'>
            The totals did not load — the entries below are still complete.{' '}
            <button
              type='button'
              onClick={onRetry}
              className='font-medium text-nvr-navy underline-offset-2 hover:underline dark:text-nvr-cyan'
            >
              Try again
            </button>
          </p>
        ) : phrases.length ? (
          <p data-audit-totals>{phrases.join(' · ')}</p>
        ) : null}
        {!loading && !failed && breakdown && (
          <p className='text-[11.5px] text-slate-500 dark:text-slate-400'>{breakdown}</p>
        )}
        {notes.length > 0 && (
          <p className='text-[11.5px] text-slate-500 dark:text-slate-400'>{notes.join(' ')}</p>
        )}
      </div>
    </section>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function ReportsPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [initial] = useState(() => stateFromUrl(searchParams))
  const [filters, setFiltersState] = useState<ActivityFilters>(initial.filters)
  const [showReads, setShowReadsState] = useState(initial.showReads)
  const [draft, setDraft] = useState<ActivityFilters>(initial.filters)
  const [customDates, setCustomDates] = useState(
    !initial.filters.range && !!(initial.filters.from || initial.filters.to)
  )
  const [page, setPage] = useState(1)
  const [activeViewId, setActiveViewId] = useState<number | null>(null)
  const [exporting, setExporting] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)

  const commit = (next: ActivityFilters, reads: boolean = showReads) => {
    const clean = cleanFilters(next)
    setFiltersState(clean)
    setDraft(clean)
    setCustomDates(!clean.range && !!(clean.from || clean.to))
    setShowReadsState(reads)
    setPage(1)
    setSearchParams(stateToUrl(clean, reads), { replace: true })
  }

  const effective = useMemo(() => effectiveFilters(filters, showReads), [filters, showReads])
  const params = activityParams(effective)

  const { data: collectionsData } = useQuery({
    queryKey: ['collections'],
    queryFn: () => api.get('/collections').then((r) => r.data.data as CollectionRow[])
  })
  const { data: actionsData } = useQuery({
    queryKey: ['activity-actions'],
    queryFn: () => api.get('/activity/actions').then((r) => r.data.data as string[]),
    staleTime: 300_000
  })

  const list = useQuery({
    queryKey: ['audit-report-list', effective, page],
    queryFn: () =>
      api
        .get<ActivityResponse>('/activity', {
          params: { ...params, limit: PAGE_LIMIT, offset: (page - 1) * PAGE_LIMIT }
        })
        .then((r) => r.data),
    placeholderData: keepPreviousData
  })
  const summary = useQuery({
    queryKey: ['audit-report-summary', effective],
    queryFn: () => api.get<SummaryResponse>('/reports/summary', { params }).then((r) => r.data),
    retry: false
  })

  const rows = list.data?.data ?? []
  const labels = useActivityLabels(rows)
  const total = list.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT))

  // Collection names: the registry's display names, then the readable kit's own nouns.
  const collectionLabels = useMemo<ActivityLabels>(() => {
    const out: NonNullable<ActivityLabels['collections']> = {}
    for (const c of collectionsData ?? [])
      if (c.display_name || c.singular)
        out[c.collection] = { plural: c.display_name ?? null, singular: c.singular ?? null }
    return { collections: { ...out, ...(labels?.collections ?? {}) } }
  }, [collectionsData, labels])
  const collectionName = (c: string) => collectionNouns(c, collectionLabels).plural

  const presetCtx: PresetContext = { me: user?.id ?? null, actions: actionsData }
  const personName = usePersonName(filters.user)

  const actionOptions = useMemo<PickOption[]>(() => {
    const all = [...new Set([...COMMON_ACTIONS, ...(actionsData ?? [])])]
    const label = (a: string) =>
      a === 'transition'
        ? 'Moved to another state'
        : a === 'login'
          ? 'Signed in'
          : a === 'read'
            ? 'Opened (read)'
            : readableTitle(a) || a
    return [
      ...COMMON_ACTIONS.map((a) => ({ value: a, label: label(a), group: 'Common' })),
      ...all
        .filter((a) => !COMMON_ACTIONS.includes(a))
        .map((a) => ({ value: a, label: label(a), group: 'Everything else' }))
        .sort((x, y) => x.label.localeCompare(y.label))
    ]
  }, [actionsData])

  const collectionOptions = useMemo<PickOption[]>(() => {
    const keys = new Set<string>((collectionsData ?? []).map((c) => c.collection))
    for (const c of summary.data?.by_collection ?? []) if (c.collection) keys.add(c.collection)
    for (const c of filters.collections ?? []) keys.add(c)
    return [...keys]
      .map((c) => ({ value: c, label: collectionNouns(c, collectionLabels).plural }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [collectionsData, summary.data, filters.collections, collectionLabels])

  const heading = list.data
    ? describeFilters(
        filters,
        {
          collectionName,
          personName,
          isMe: !!user?.id && filters.user === user.id,
          showReads,
          formatDay: (d) => formatDate(d)
        },
        total,
        formatNumber
      )
    : null

  const applyDraft = () => {
    setActiveViewId(null)
    commit(customDates ? { ...draft, range: null } : draft)
    setFiltersOpen(false)
  }
  const applyPreset = (id: AuditPresetId) => {
    const f = presetFilters(id, presetCtx)
    if (!f) return
    setActiveViewId(null)
    commit(f)
    setFiltersOpen(false)
  }

  async function exportCSV() {
    setExporting(true)
    try {
      let tz: string | undefined
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      } catch {
        tz = undefined
      }
      const res = await api.get('/reports/activity', {
        params: { ...params, format: 'csv', readable: '1', tz },
        responseType: 'blob'
      })
      const url = URL.createObjectURL(res.data as Blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `audit-report-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
      const rowsOut = Number(res.headers['x-export-rows'] ?? 0)
      if (res.headers['x-export-truncated'] === '1')
        toast.message(`Exported the newest ${formatNumber(rowsOut)} entries`, {
          description: 'Narrow the dates to export the rest.'
        })
      else toast.success(`Exported ${formatNumber(rowsOut)} ${rowsOut === 1 ? 'entry' : 'entries'}`)
    } catch (e) {
      // The error body is a Blob when responseType is blob.
      let message = errorText(e)
      const blob = (e as { response?: { data?: unknown } }).response?.data
      if (blob instanceof Blob) {
        try {
          message = (JSON.parse(await blob.text()) as { error?: string }).error ?? message
        } catch {
          // keep the generic message
        }
      }
      toast.error(`The export did not finish: ${message}`)
    } finally {
      setExporting(false)
    }
  }

  const isDefault = !showReads && JSON.stringify(filters) === JSON.stringify(DEFAULT_FILTERS)
  const narrowWindow = !!filters.range && filters.range !== 'last_90_days'

  const emptyState = (
    <div className='px-6 py-14 text-center'>
      <p className='text-[13.5px] font-medium text-slate-800 dark:text-slate-100'>
        {isDefault ? 'Nothing was recorded in the last 7 days.' : 'Nothing matches these filters.'}
      </p>
      <p className='mx-auto mt-1 max-w-[46ch] text-[12.5px] text-slate-500 dark:text-slate-400'>
        Try a longer window, include reads, or start again from the last 7 days.
      </p>
      <div className='mt-4 flex flex-wrap justify-center gap-2'>
        {narrowWindow && (
          <Button
            size='sm'
            variant='outline'
            onClick={() => commit({ ...filters, range: 'last_90_days' })}
          >
            Look back 90 days
          </Button>
        )}
        {!showReads && (
          <Button size='sm' variant='outline' onClick={() => commit(filters, true)}>
            Show reads
          </Button>
        )}
        {!isDefault && (
          <Button size='sm' variant='ghost' onClick={() => commit(DEFAULT_FILTERS, false)}>
            Clear filters
          </Button>
        )}
      </div>
    </div>
  )

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar
        description='Who changed what, and why, in plain sentences. Bulk changes, imports and automations fold into one line. Pick a quick view or narrow it down, then export what you see.'
        actions={
          <>
            <Button
              size='sm'
              variant='outline'
              className='h-8 text-[12px] md:hidden'
              onClick={() => setFiltersOpen((v) => !v)}
              aria-expanded={filtersOpen}
            >
              <SlidersHorizontal className='mr-1.5 h-3.5 w-3.5' aria-hidden />
              Filters
              <ChevronDown
                className={cn('ml-1 h-3.5 w-3.5 transition-transform', filtersOpen && 'rotate-180')}
                aria-hidden
              />
            </Button>
            <SavedViewsMenu
              filters={effective}
              activeId={activeViewId}
              onApply={(v) => {
                setActiveViewId(v?.id ?? null)
                // Closing (or removing) a view keeps what is on screen.
                if (!v) return
                const split = splitReads(v.filters)
                commit(split.filters, split.showReads)
              }}
            />
            <Button
              size='sm'
              variant='outline'
              className='h-8 text-[12px]'
              onClick={exportCSV}
              disabled={exporting || total === 0}
              data-tip='Each entry as a sentence, plus the raw columns'
            >
              <Download className='mr-1.5 h-3.5 w-3.5' aria-hidden />
              {exporting ? 'Exporting…' : 'Export CSV'}
            </Button>
          </>
        }
      />

      <div className='flex flex-1 min-h-0 flex-col overflow-y-auto md:flex-row md:overflow-hidden'>
        <FilterSidebar
          applied={filters}
          draft={draft}
          setDraft={setDraft}
          customDates={customDates}
          setCustomDates={setCustomDates}
          showReads={showReads}
          onShowReads={(v) => {
            setActiveViewId(null)
            commit(filters, v)
          }}
          onApply={applyDraft}
          onReset={() => {
            setActiveViewId(null)
            commit(DEFAULT_FILTERS, false)
          }}
          onPreset={applyPreset}
          presetCtx={presetCtx}
          actionOptions={actionOptions}
          collectionOptions={collectionOptions}
          open={filtersOpen}
        />

        <div className='flex-1 bg-slate-50 md:overflow-y-auto dark:bg-background'>
          <div className='space-y-4 p-4 md:p-6'>
            <SummaryCard
              heading={heading}
              summary={summary.data}
              loading={summary.isLoading}
              failed={summary.isError && !summary.data}
              onRetry={() => void summary.refetch()}
              collectionName={collectionName}
              listAnyTime={!filters.range && !filters.from && !filters.to}
              textWindowFrom={list.data?.window_from ?? null}
            />

            <div
              className={cn(
                'overflow-hidden rounded-lg border border-slate-200 bg-white transition-opacity dark:border-border dark:bg-card',
                list.isFetching && list.isPlaceholderData && 'opacity-60'
              )}
            >
              {list.isLoading ? (
                <div className='space-y-3 p-5' aria-busy>
                  {[...Array(8)].map((_, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
                    <div key={i} className='flex items-center gap-2.5'>
                      <Skeleton className='h-6 w-6 shrink-0 rounded-full' />
                      <Skeleton className='h-4 flex-1 rounded' />
                      <Skeleton className='h-3 w-14 shrink-0 rounded' />
                    </div>
                  ))}
                </div>
              ) : list.isError && !list.data ? (
                <QueryErrorState
                  error={list.error}
                  what='the audit report'
                  onRetry={() => void list.refetch()}
                />
              ) : (
                <>
                  <ActivityFeed
                    className='px-2 py-1'
                    entries={rows}
                    labels={labels}
                    onOpen={(e) => e.id != null && navigate(`/activity/${e.id}`)}
                    empty={emptyState}
                  />
                  {total > PAGE_LIMIT && (
                    <div className='flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-3 dark:border-border'>
                      <p className='text-[12px] text-slate-500 dark:text-slate-400'>
                        {formatNumber((page - 1) * PAGE_LIMIT + 1)}–
                        {formatNumber(Math.min(page * PAGE_LIMIT, total))} of {formatNumber(total)}
                      </p>
                      <div className='flex items-center gap-2'>
                        <Button
                          variant='outline'
                          size='sm'
                          disabled={page <= 1}
                          onClick={() => setPage((p) => p - 1)}
                        >
                          Newer
                        </Button>
                        <span className='text-[12px] text-slate-500 dark:text-slate-400'>
                          Page {page} of {formatNumber(totalPages)}
                        </span>
                        <Button
                          variant='outline'
                          size='sm'
                          disabled={page >= totalPages}
                          onClick={() => setPage((p) => p + 1)}
                        >
                          Older
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
