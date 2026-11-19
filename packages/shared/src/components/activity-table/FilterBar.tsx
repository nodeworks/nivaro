import { Calendar, Check, ChevronDown, Layers, Lock, Plus, Undo2, X } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import {
  type ActivityLabels,
  collectionNouns,
  fieldLabel,
  readableTitle
} from '../../lib/activity-sentence'
import {
  ACTOR_KIND_WORDS,
  type ActivitySource,
  type ActivityTableFilters,
  type ActorKind,
  RANGE_WORDS,
  SOURCE_WORDS
} from '../../lib/activity-table'
import { cn, formatDateTime, formatNumber } from '../../lib/utils'
import { containsFilter } from '../DataTable'
import { actionWord } from '../profile/ActivityFeedCard'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import type { ActivityFacets, FacetValue } from './types'

/**
 * The Table view's filter chips. A dimension with nothing picked is a quiet "+ Person" button;
 * once picked it is a filled chip naming the picks ("Person: Sam, Pat") with its own clear.
 * Each list shows the counts of the other filters (GET /activity/table/facets), loaded the
 * first time a chip opens. A preset (locked) filter shows as a chip with a lock and no clear.
 */

const CHIP =
  'inline-flex h-7 max-w-[260px] shrink-0 items-center gap-1 rounded-full border text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
const CHIP_ON =
  'nvr-pop-in border-nvr-cyan/40 bg-nvr-cyan/10 pl-2.5 pr-1 text-slate-800 dark:border-nvr-cyan/40 dark:bg-nvr-cyan/15 dark:text-slate-100'
const CHIP_OFF =
  'border-dashed border-slate-300 px-2.5 text-slate-600 hover:border-slate-400 hover:bg-slate-50 dark:border-white/15 dark:text-slate-300 dark:hover:bg-white/[0.04]'
const CHIP_LOCKED =
  'border-slate-200 bg-slate-100 px-2.5 text-slate-700 dark:border-white/10 dark:bg-white/[0.06] dark:text-slate-200'

function ClearX({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <button
      type='button'
      aria-label={`Clear ${label}`}
      onClick={(e) => {
        e.stopPropagation()
        onClear()
      }}
      className='ml-0.5 flex h-5 w-5 items-center justify-center rounded-full text-slate-500 hover:bg-nvr-cyan/20 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-slate-400 dark:hover:text-slate-100'
    >
      <X className='h-3 w-3' aria-hidden />
    </button>
  )
}

function summary(names: string[]): string {
  if (names.length <= 2) return names.join(', ')
  return `${names[0]} +${names.length - 1}`
}

function FacetChip({
  label,
  picked,
  options,
  loading,
  nameOf,
  onChange,
  onOpen,
  locked
}: {
  label: string
  picked: string[]
  options: FacetValue[] | undefined
  loading: boolean
  nameOf: (v: string, f?: FacetValue) => string
  onChange: (values: string[]) => void
  onOpen: () => void
  locked?: string[]
}) {
  const [open, setOpen] = useState(false)
  const lockedOnly = !!locked?.length && picked.length === 0
  const shown = picked.length ? picked : (locked ?? [])
  // Picks always listed (even when the window's counts no longer hold them).
  const list = useMemo(() => {
    const byValue = new Map((options ?? []).map((o) => [o.value, o]))
    for (const v of picked) if (!byValue.has(v)) byValue.set(v, { value: v, count: 0 })
    let all = [...byValue.values()]
    if (locked?.length) all = all.filter((o) => locked.includes(o.value))
    return all
  }, [options, picked, locked])
  const toggle = (v: string) =>
    onChange(picked.includes(v) ? picked.filter((x) => x !== v) : [...picked, v])
  const on = shown.length > 0
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) onOpen()
      }}
    >
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(CHIP, lockedOnly ? CHIP_LOCKED : on ? CHIP_ON : CHIP_OFF)}
          aria-label={
            on
              ? `${label}: ${shown.map((v) => nameOf(v)).join(', ')}`
              : `Filter by ${label.toLowerCase()}`
          }
        >
          {lockedOnly && <Lock className='h-3 w-3 shrink-0 opacity-60' aria-hidden />}
          {!on && <Plus className='h-3 w-3 shrink-0' aria-hidden />}
          <span className={cn('shrink-0', on && 'text-slate-500 dark:text-slate-400')}>
            {label}
            {on ? ':' : ''}
          </span>
          {on && (
            <span className='truncate font-medium'>{summary(shown.map((v) => nameOf(v)))}</span>
          )}
          {picked.length > 0 ? (
            <ClearX label={label} onClear={() => onChange([])} />
          ) : (
            on && <ChevronDown className='h-3 w-3 shrink-0 opacity-60' aria-hidden />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-72 p-0' align='start'>
        <Command filter={containsFilter}>
          <CommandInput
            placeholder={`Find ${label.toLowerCase()}…`}
            className='h-9 text-[12.5px]'
          />
          <CommandList className='max-h-72'>
            {loading && list.length === 0 ? (
              <div className='space-y-1.5 p-2' aria-busy>
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className='h-6 animate-pulse rounded bg-slate-100 dark:bg-white/5' />
                ))}
              </div>
            ) : (
              <CommandEmpty className='px-3 py-4 text-center text-[12px] text-muted-foreground'>
                Nothing in this window.
              </CommandEmpty>
            )}
            {list.map((o) => {
              const sel = picked.includes(o.value)
              return (
                <CommandItem
                  key={o.value}
                  value={`${nameOf(o.value, o)} ${o.value}`}
                  onSelect={() => toggle(o.value)}
                  className='flex items-center gap-2 py-1.5 text-[12.5px]'
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                      sel
                        ? 'border-nvr-cyan bg-nvr-cyan text-white'
                        : 'border-slate-300 dark:border-white/20'
                    )}
                    aria-hidden
                  >
                    {sel && <Check className='h-3 w-3' />}
                  </span>
                  <span className='min-w-0 flex-1 truncate'>{nameOf(o.value, o)}</span>
                  {o.count > 0 && (
                    <span className='shrink-0 text-[11px] tabular-nums text-slate-500 dark:text-slate-400'>
                      {formatNumber(o.count)}
                    </span>
                  )}
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

const PRESETS = [
  'today',
  'yesterday',
  'last_24_hours',
  'last_7_days',
  'this_week',
  'last_30_days',
  'this_month',
  'last_90_days'
] as const

/** `YYYY-MM-DDTHH:mm` in local time for a datetime-local input. */
function toLocalInput(v: string | null | undefined): string {
  if (!v) return ''
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const clockOf = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export function windowWords(f: ActivityTableFilters, now = new Date()): string | null {
  if (f.range) return RANGE_WORDS[f.range] ?? readableTitle(f.range)
  if (f.from && f.to) {
    const a = new Date(f.from)
    const b = new Date(f.to)
    if (
      !Number.isNaN(a.getTime()) &&
      !Number.isNaN(b.getTime()) &&
      a.toDateString() === b.toDateString()
    ) {
      const midnight = a.getHours() === 0 && a.getMinutes() === 0
      if (a.toDateString() === now.toDateString())
        return midnight ? `Today until ${clockOf(b)}` : `Today ${clockOf(a)} – ${clockOf(b)}`
      return `${a.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clockOf(a)} – ${clockOf(b)}`
    }
    return `${formatDateTime(f.from)} – ${formatDateTime(f.to)}`
  }
  if (f.from) return `Since ${formatDateTime(f.from)}`
  if (f.to) return `Until ${formatDateTime(f.to)}`
  return null
}

function DateChip({
  filters,
  onChange,
  locked
}: {
  filters: ActivityTableFilters
  onChange: (next: Partial<ActivityTableFilters>) => void
  locked: boolean
}) {
  const [open, setOpen] = useState(false)
  const words = windowWords(filters)
  if (locked)
    return (
      <span className={cn(CHIP, CHIP_LOCKED)} data-tip='Set by this view'>
        <Lock className='h-3 w-3 opacity-60' aria-hidden />
        <Calendar className='h-3 w-3' aria-hidden />
        <span className='truncate font-medium'>{words}</span>
      </span>
    )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(CHIP, words ? CHIP_ON : CHIP_OFF)}
          aria-label={words ? `When: ${words}` : 'Filter by date'}
        >
          <Calendar className='h-3 w-3 shrink-0' aria-hidden />
          <span className='truncate font-medium'>{words ?? 'Any time'}</span>
          {words ? (
            <ClearX label='dates' onClear={() => onChange({ range: null, from: null, to: null })} />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-72 p-2' align='start'>
        <div className='grid grid-cols-2 gap-1'>
          {PRESETS.map((r) => (
            <button
              key={r}
              type='button'
              onClick={() => {
                onChange({ range: r, from: null, to: null })
                setOpen(false)
              }}
              className={cn(
                'rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60',
                filters.range === r && 'bg-accent font-medium'
              )}
            >
              {RANGE_WORDS[r]}
            </button>
          ))}
        </div>
        <div className='mt-2 space-y-1.5 border-t border-slate-100 pt-2 dark:border-border'>
          <p className='px-1 text-[11px] font-medium text-slate-500 dark:text-slate-400'>Between</p>
          {(['from', 'to'] as const).map((edge) => (
            <label key={edge} className='flex items-center gap-2 px-1 text-[12px]'>
              <span className='w-9 text-slate-500 dark:text-slate-400'>
                {edge === 'from' ? 'From' : 'To'}
              </span>
              <input
                type='datetime-local'
                value={filters.range ? '' : toLocalInput(filters[edge])}
                onChange={(e) => {
                  const v = e.target.value
                  const iso = v ? new Date(v).toISOString() : null
                  onChange({ range: null, [edge]: iso })
                }}
                className='h-7 min-w-0 flex-1 rounded-md border border-slate-200 bg-transparent px-1.5 text-[12px] dark:border-border dark:[color-scheme:dark]'
              />
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function TextChip({
  label,
  value,
  placeholder,
  suggestions,
  onChange,
  locked
}: {
  label: string
  value: string[]
  placeholder: string
  suggestions?: Array<{ value: string; label: string }>
  onChange: (v: string[]) => void
  locked?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const on = value.length > 0
  const name = (v: string) => suggestions?.find((s) => s.value === v)?.label ?? v
  if (locked && on)
    return (
      <span className={cn(CHIP, CHIP_LOCKED)}>
        <Lock className='h-3 w-3 opacity-60' aria-hidden />
        {label}: <span className='truncate font-medium'>{summary(value.map(name))}</span>
      </span>
    )
  const add = (v: string) => {
    const s = v.trim()
    if (s && !value.includes(s)) onChange([...value, s])
    setDraft('')
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(CHIP, on ? CHIP_ON : CHIP_OFF)}
          aria-label={on ? `${label}: ${value.join(', ')}` : `Filter by ${label.toLowerCase()}`}
        >
          {!on && <Plus className='h-3 w-3' aria-hidden />}
          <span className={cn(on && 'text-slate-500 dark:text-slate-400')}>
            {label}
            {on ? ':' : ''}
          </span>
          {on && <span className='truncate font-medium'>{summary(value.map(name))}</span>}
          {on && <ClearX label={label} onClear={() => onChange([])} />}
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-72 p-0' align='start'>
        <Command filter={containsFilter}>
          <CommandInput
            placeholder={placeholder}
            value={draft}
            onValueChange={setDraft}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                draft.trim() &&
                !suggestions?.some((s) => containsFilter(`${s.label} ${s.value}`, draft))
              ) {
                e.preventDefault()
                add(draft)
              }
            }}
            className='h-9 text-[12.5px]'
          />
          <CommandList className='max-h-64'>
            <CommandEmpty className='px-3 py-3 text-[12px] text-muted-foreground'>
              {draft.trim() ? (
                <button
                  type='button'
                  className='w-full rounded px-1 py-1 text-left hover:bg-muted'
                  onClick={() => add(draft)}
                >
                  Use “{draft.trim()}”
                </button>
              ) : (
                'Type a name and press Enter.'
              )}
            </CommandEmpty>
            {(suggestions ?? []).map((s) => {
              const sel = value.includes(s.value)
              return (
                <CommandItem
                  key={s.value}
                  value={`${s.label} ${s.value}`}
                  onSelect={() =>
                    onChange(sel ? value.filter((x) => x !== s.value) : [...value, s.value])
                  }
                  className='flex items-center gap-2 py-1.5 text-[12.5px]'
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                      sel
                        ? 'border-nvr-cyan bg-nvr-cyan text-white'
                        : 'border-slate-300 dark:border-white/20'
                    )}
                    aria-hidden
                  >
                    {sel && <Check className='h-3 w-3' />}
                  </span>
                  <span className='min-w-0 flex-1 truncate'>{s.label}</span>
                  {s.label !== s.value && (
                    <span className='shrink-0 font-mono text-[10.5px] text-slate-400'>
                      {s.value}
                    </span>
                  )}
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function ActivityFilterBar({
  filters,
  locked,
  onChange,
  facets,
  facetsLoading,
  onFacetsWanted,
  labels,
  fieldSuggestions,
  extra
}: {
  /** The person's own filters (without the preset). */
  filters: ActivityTableFilters
  locked?: ActivityTableFilters
  onChange: (next: ActivityTableFilters) => void
  facets: ActivityFacets | undefined
  facetsLoading: boolean
  onFacetsWanted: () => void
  labels?: ActivityLabels | null
  /** Changed fields seen on the page (`collection.field`) for the field chip's list. */
  fieldSuggestions: Array<{ collection: string | null; field: string }>
  extra?: ReactNode
}) {
  const set = (patch: Partial<ActivityTableFilters>) => onChange({ ...filters, ...patch })
  const f = facets?.facets
  const userName = (v: string, o?: FacetValue) =>
    o?.label ?? labels?.users?.[v] ?? labels?.users?.[v.toLowerCase()] ?? 'Someone'
  const people = [...new Set([...(filters.user ? [filters.user] : []), ...(filters.users ?? [])])]
  const lockedWindow = !!(locked?.range || locked?.from || locked?.to)
  const effectiveWindow = lockedWindow ? { ...filters, ...locked } : filters
  const fieldOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const s of fieldSuggestions)
      if (!seen.has(s.field)) seen.set(s.field, fieldLabel(s.collection, s.field, labels))
    return [...seen.entries()].map(([value, label]) => ({ value, label }))
  }, [fieldSuggestions, labels])
  const anyOwn = Object.keys(filters).some((k) => k !== 'q')

  return (
    <div
      className='flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:thin] md:flex-wrap md:overflow-visible'
      role='toolbar'
      aria-label='Filters'
    >
      <DateChip filters={effectiveWindow} locked={lockedWindow} onChange={(p) => set(p)} />
      {filters.group_key && (
        <span className={cn(CHIP, CHIP_ON)}>
          <Layers className='h-3 w-3' aria-hidden />
          One run
          <ClearX label='the run' onClear={() => set({ group_key: null })} />
        </span>
      )}
      {locked?.records_only && (
        <span
          className={cn(CHIP, CHIP_LOCKED)}
          data-tip='Record changes only: creates, edits, deletes and moves'
        >
          <Lock className='h-3 w-3 opacity-60' aria-hidden />
          Record changes
        </span>
      )}
      <FacetChip
        label='Person'
        picked={people}
        options={f?.user}
        loading={facetsLoading}
        nameOf={userName}
        onOpen={onFacetsWanted}
        onChange={(v) => set({ user: null, users: v })}
        locked={locked?.users}
      />
      <FacetChip
        label='Actor'
        picked={filters.actor_kinds ?? []}
        options={f?.actor_kind}
        loading={facetsLoading}
        nameOf={(v) => ACTOR_KIND_WORDS[v as ActorKind] ?? v}
        onOpen={onFacetsWanted}
        onChange={(v) => set({ actor_kinds: v as ActorKind[] })}
      />
      <FacetChip
        label='Action'
        picked={filters.actions ?? []}
        options={f?.action}
        loading={facetsLoading}
        nameOf={(v) => actionWord(v) || readableTitle(v)}
        onOpen={onFacetsWanted}
        onChange={(v) => set({ actions: v })}
        locked={locked?.actions}
      />
      <FacetChip
        label='Collection'
        picked={filters.collections ?? []}
        options={f?.collection}
        loading={facetsLoading}
        nameOf={(v) => collectionNouns(v, labels).plural}
        onOpen={onFacetsWanted}
        onChange={(v) => set({ collections: v })}
        locked={locked?.collections}
      />
      <FacetChip
        label='Source'
        picked={filters.sources ?? []}
        options={f?.source}
        loading={facetsLoading}
        nameOf={(v) => SOURCE_WORDS[v as ActivitySource] ?? v}
        onOpen={onFacetsWanted}
        onChange={(v) => set({ sources: v as ActivitySource[] })}
      />
      <TextChip
        label='Field changed'
        value={filters.fields ?? []}
        placeholder='Field name, e.g. status'
        suggestions={fieldOptions}
        onChange={(v) => set({ fields: v.filter((x) => /^[A-Za-z0-9_]{1,64}$/.test(x)) })}
      />
      <TextChip
        label='Record'
        value={filters.item ? [filters.item] : locked?.item ? [locked.item] : []}
        locked={!!locked?.item}
        placeholder='Record id'
        onChange={(v) => set({ item: v[v.length - 1] ?? null })}
      />
      <button
        type='button'
        aria-pressed={!!filters.undoable}
        onClick={() => set({ undoable: !filters.undoable })}
        className={cn(CHIP, filters.undoable ? `${CHIP_ON} pr-2.5` : CHIP_OFF)}
        data-tip='Edits with a kept snapshot and deletes — the entries that may offer Undo'
      >
        <Undo2 className='h-3 w-3' aria-hidden />
        Can be undone
      </button>
      {anyOwn && (
        <button
          type='button'
          onClick={() => onChange(filters.q ? { q: filters.q } : {})}
          className='shrink-0 px-1.5 text-[12px] font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-slate-400 dark:hover:text-slate-100'
        >
          Clear all
        </button>
      )}
      {extra}
    </div>
  )
}
