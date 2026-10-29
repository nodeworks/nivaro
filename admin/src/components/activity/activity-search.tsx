import { useMutation, useQuery } from '@tanstack/react-query'
import { Loader2, Search, Sparkles, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { UserCombobox } from '@/components/user-combobox'
import { api } from '@/lib/api'
import { cn, titleCase } from '@/lib/utils'

/**
 * #10 — natural-language search on the Activity page and the chips that show (and let people
 * fix) what it understood. The words go to POST /api/activity/parse (one AI call → filters);
 * the filters are applied through GET /api/activity's own params. With AI off the words come
 * back as plain text search.
 */

/** Mirrors api/src/services/activity-filters.ts ActivityFilters. */
export interface ActivityFilters {
  user?: string | null
  actions?: string[]
  exclude_actions?: string[]
  collections?: string[]
  item?: string | null
  from?: string | null
  to?: string | null
  range?: string | null
  q?: string | null
}

export const RANGE_LABELS: Record<string, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last_24_hours: 'Last 24 hours',
  last_7_days: 'Last 7 days',
  this_week: 'This week',
  last_week: 'Last week',
  last_30_days: 'Last 30 days',
  this_month: 'This month',
  last_month: 'Last month',
  last_90_days: 'Last 90 days'
}

export interface PersonCandidate {
  id: string
  name: string
  email?: string | null
}

export interface ParseResult {
  filters: ActivityFilters
  source: 'ai' | 'text'
  note?: string
  user_label?: string | null
  person_candidates?: PersonCandidate[]
  unmatched_person?: string | null
}

/** GET /api/activity params for a filter set (lists comma-joined). */
export function activityParams(f: ActivityFilters): Record<string, string | undefined> {
  const join = (v?: string[]) => (v?.length ? v.join(',') : undefined)
  return {
    user: f.user || undefined,
    action: join(f.actions),
    exclude_actions: join(f.exclude_actions),
    collection: join(f.collections),
    item: f.item || undefined,
    range: f.range || undefined,
    from: f.range ? undefined : f.from || undefined,
    to: f.range ? undefined : f.to || undefined,
    q: f.q || undefined
  }
}

/** Drop empty keys so two equal filter sets compare equal. */
export function cleanFilters(f: ActivityFilters): ActivityFilters {
  const out: ActivityFilters = {}
  for (const [k, v] of Object.entries(f)) {
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue
    ;(out as Record<string, unknown>)[k] = v
  }
  return out
}

export const sameFilters = (a: ActivityFilters, b: ActivityFilters) =>
  JSON.stringify(cleanFilters(a), Object.keys(cleanFilters(a)).sort()) ===
  JSON.stringify(cleanFilters(b), Object.keys(cleanFilters(b)).sort())

const actionLabel = (a: string) => titleCase(a.replace(/[-_]/g, ' '))

export function ActivitySearchBox({ onParsed }: { onParsed: (r: ParseResult) => void }) {
  const [text, setText] = useState('')
  const parse = useMutation({
    mutationFn: (words: string) =>
      api.post<{ data: ParseResult }>('/activity/parse', { text: words }).then((r) => r.data.data),
    onSuccess: (r) => onParsed(r),
    // The route itself failing (not the AI): still search the words.
    onError: () =>
      onParsed({ filters: { q: text.trim() }, source: 'text', note: 'Searching the words.' })
  })
  const submit = () => {
    const w = text.trim()
    if (w) parse.mutate(w)
  }
  return (
    <form
      className='relative flex min-w-0 flex-1 items-center'
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      data-activity-search
    >
      <Sparkles className='pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-nvr-cyan' />
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder='Search the log — "deletes by Sam last week in invoices"'
        aria-label='Search activity'
        className='h-8 min-w-[220px] pl-8 pr-16 text-[12px]'
      />
      <div className='absolute right-1 flex items-center gap-0.5'>
        {text && (
          <button
            type='button'
            className='rounded p-1 text-slate-400 hover:bg-muted hover:text-slate-700 dark:hover:text-slate-200'
            aria-label='Clear search text'
            onClick={() => setText('')}
          >
            <X className='h-3.5 w-3.5' />
          </button>
        )}
        <button
          type='submit'
          className='rounded p-1 text-slate-500 hover:bg-muted hover:text-slate-800 disabled:opacity-50 dark:text-slate-400 dark:hover:text-slate-100'
          aria-label='Search'
          disabled={!text.trim() || parse.isPending}
        >
          {parse.isPending ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
          ) : (
            <Search className='h-3.5 w-3.5' />
          )}
        </button>
      </div>
    </form>
  )
}

function Chip({
  label,
  onRemove,
  tone = 'default',
  children
}: {
  label: string
  onRemove: () => void
  tone?: 'default' | 'not'
  children?: ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded-full border pl-2 pr-1 text-[11.5px]',
        tone === 'not'
          ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'
          : 'border-nvr-cyan/30 bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
      )}
      data-activity-chip
    >
      {children ?? label}
      <button
        type='button'
        aria-label={`Remove ${label}`}
        onClick={onRemove}
        className='rounded-full p-0.5 hover:bg-black/5 dark:hover:bg-white/10'
      >
        <X className='h-3 w-3' />
      </button>
    </span>
  )
}

/** The person chip: shows who, and lets them pick someone else (other matches first). */
function PersonChip({
  userId,
  label,
  candidates,
  onChange
}: {
  userId: string
  label: string | null
  candidates?: PersonCandidate[]
  onChange: (id: string | null, label?: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  // A saved view names a user id only: read the name for the chip.
  const { data: fetched } = useQuery({
    queryKey: ['activity-chip-user', userId],
    queryFn: () =>
      api
        .get(`/users/${userId}`, { params: { fields: 'id,first_name,last_name,email' } })
        .then((r) => {
          const u = r.data.data as { first_name?: string; last_name?: string; email?: string }
          return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || null
        }),
    enabled: !label,
    staleTime: 300_000,
    retry: false
  })
  const shown = label ?? fetched ?? 'Person'
  return (
    <Chip label={`by ${shown}`} onRemove={() => onChange(null)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type='button' className='hover:underline' aria-label='Change person'>
            by {shown}
          </button>
        </PopoverTrigger>
        <PopoverContent align='start' className='w-72 space-y-2 p-2'>
          {candidates && candidates.length > 1 && (
            <div className='space-y-0.5'>
              <p className='px-1 text-[11px] text-slate-500 dark:text-slate-400'>Did you mean</p>
              {candidates.map((c) => (
                <button
                  key={c.id}
                  type='button'
                  className={cn(
                    'flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-[12px] hover:bg-muted',
                    c.id === userId && 'bg-accent'
                  )}
                  onClick={() => {
                    onChange(c.id, c.name)
                    setOpen(false)
                  }}
                >
                  <span className='font-medium'>{c.name}</span>
                  {c.email && (
                    <span className='truncate text-[11px] text-slate-500 dark:text-slate-400'>
                      {c.email}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          <UserCombobox
            value={userId}
            onChange={(id) => {
              onChange(id, null)
              setOpen(false)
            }}
            searchServer
            hideNone
            placeholder='Someone else…'
            className='h-8 w-full text-[12px]'
          />
        </PopoverContent>
      </Popover>
    </Chip>
  )
}

export function ActivityFilterChips({
  filters,
  onChange,
  userLabel,
  candidates,
  collectionLabel,
  note
}: {
  filters: ActivityFilters
  onChange: (next: ActivityFilters, meta?: { userLabel?: string | null }) => void
  userLabel: string | null
  candidates?: PersonCandidate[]
  collectionLabel: (name: string) => string
  note?: string | null
}) {
  const f = filters
  const set = (patch: Partial<ActivityFilters>) => onChange(cleanFilters({ ...f, ...patch }))
  const without = (list: string[] | undefined, v: string) => (list ?? []).filter((x) => x !== v)
  const window = f.range
    ? (RANGE_LABELS[f.range] ?? f.range)
    : f.from || f.to
      ? `${f.from ? String(f.from).slice(0, 10) : '…'} → ${f.to ? String(f.to).slice(0, 10) : 'now'}`
      : null
  const any = Object.keys(cleanFilters(f)).length > 0
  if (!any && !note) return null
  return (
    <div className='flex flex-wrap items-center gap-1.5' data-activity-chips>
      {f.user && (
        <PersonChip
          userId={f.user}
          label={userLabel}
          candidates={candidates}
          onChange={(id, label) => onChange(cleanFilters({ ...f, user: id }), { userLabel: label })}
        />
      )}
      {(f.actions ?? []).map((a) => (
        <Chip
          key={`a-${a}`}
          label={actionLabel(a)}
          onRemove={() => set({ actions: without(f.actions, a) })}
        />
      ))}
      {(f.exclude_actions ?? []).map((a) => (
        <Chip
          key={`x-${a}`}
          tone='not'
          label={`not ${actionLabel(a)}`}
          onRemove={() => set({ exclude_actions: without(f.exclude_actions, a) })}
        />
      ))}
      {(f.collections ?? []).map((c) => (
        <Chip
          key={`c-${c}`}
          label={`in ${collectionLabel(c)}`}
          onRemove={() => set({ collections: without(f.collections, c) })}
        />
      ))}
      {window && (
        <Chip label={window} onRemove={() => set({ range: null, from: null, to: null })} />
      )}
      {f.item && <Chip label={`#${f.item}`} onRemove={() => set({ item: null })} />}
      {f.q && <Chip label={`“${f.q}”`} onRemove={() => set({ q: null })} />}
      {any && (
        <Button
          variant='ghost'
          size='sm'
          className='h-6 px-2 text-[11.5px] text-slate-500 dark:text-slate-400'
          onClick={() => onChange({})}
        >
          Clear all
        </Button>
      )}
      {note && <span className='text-[11.5px] text-slate-500 dark:text-slate-400'>{note}</span>}
    </div>
  )
}
