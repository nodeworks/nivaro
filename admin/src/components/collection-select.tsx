/**
 * The collection picker: friendly names grouped by the folders people set up on the Collections
 * page, the key beside each name, search over both. Folder rows themselves, hidden collections
 * and nivaro_ system tables stay out unless asked for. Popover + Command, like every other
 * picker in the admin (never a native <select>).
 */
import { queryKeys } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronsUpDown, Database, History, Pin, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { cn, titleCase } from '@/lib/utils'

interface CollectionRow {
  collection: string
  display_name?: string | null
  group?: string | null
  color?: string | null
  sort?: number | null
  hidden?: boolean | null
}

export interface CollectionOption {
  collection: string
  label: string
  folder: string | null
}

export interface CollectionSection {
  key: string
  label: string
  color: string | null
  options: CollectionOption[]
}

const label = (c: CollectionRow) => (c.display_name || '').trim() || titleCase(c.collection)

/** Folders first (in their set order), then "Other collections"; names A–Z inside each. */
export function collectionSections(
  rows: CollectionRow[],
  opts: { includeHidden?: boolean; includeSystem?: boolean } = {}
): CollectionSection[] {
  const folderKeys = new Set(rows.map((c) => c.group).filter((g): g is string => !!g))
  const folderRows = new Map(
    rows.filter((c) => folderKeys.has(c.collection)).map((c) => [c.collection, c])
  )
  const sections = new Map<string, CollectionSection>()
  for (const c of rows) {
    if (folderKeys.has(c.collection)) continue
    if (!opts.includeHidden && c.hidden) continue
    if (!opts.includeSystem && /^(nivaro|directus)_/i.test(c.collection)) continue
    const key = c.group && folderKeys.has(c.group) ? c.group : ''
    let s = sections.get(key)
    if (!s) {
      const f = folderRows.get(key)
      s = {
        key,
        label: key ? (f ? label(f) : titleCase(key)) : 'Other collections',
        color: f?.color ?? null,
        options: []
      }
      sections.set(key, s)
    }
    s.options.push({ collection: c.collection, label: label(c), folder: key || null })
  }
  const order = (key: string) =>
    key ? (folderRows.get(key)?.sort ?? 9999) : Number.MAX_SAFE_INTEGER
  return [...sections.values()]
    .map((s) => ({ ...s, options: s.options.sort((a, b) => a.label.localeCompare(b.label)) }))
    .sort((a, b) => order(a.key) - order(b.key) || a.label.localeCompare(b.label))
}

const RECENT_KEY = 'nvr:collection-select:recent'
const RECENT_MAX = 5

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX)
      : []
  } catch {
    return []
  }
}

function rememberRecent(collection: string): void {
  try {
    const next = [collection, ...readRecent().filter((c) => c !== collection)].slice(0, RECENT_MAX)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // private window / blocked storage: recents are a convenience only
  }
}

/**
 * How well an option matches the search: the exact key first, then a name or key that starts
 * with it, then a word inside the name, then anything containing it (folder included). 0 = out.
 */
const FOLDER_ONLY = 0.25

export function matchScore(o: CollectionOption, folderLabel: string, search: string): number {
  const q = search.trim().toLowerCase()
  if (!q) return 1
  const name = o.label.toLowerCase()
  const key = o.collection.toLowerCase()
  if (key === q || name === q) return 1
  if (name.startsWith(q) || key.startsWith(q)) return 0.9
  if (
    name.split(/[\s_-]+/).some((w) => w.startsWith(q)) ||
    key.split('_').some((w) => w.startsWith(q))
  )
    return 0.75
  if (name.includes(q) || key.includes(q)) return 0.5
  if (folderLabel.toLowerCase().includes(q)) return 0.25
  return 0
}

export function CollectionSelect({
  value,
  onChange,
  placeholder = 'Any collection',
  className,
  includeHidden: includeHiddenProp,
  includeSystem: includeSystemProp,
  clearable = true,
  id,
  'aria-label': ariaLabel = 'Collection'
}: {
  value: string
  onChange: (collection: string) => void
  placeholder?: string
  className?: string
  includeHidden?: boolean
  includeSystem?: boolean
  clearable?: boolean
  id?: string
  'aria-label'?: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [showAll, setShowAll] = useState(false)
  const includeHidden = includeHiddenProp || showAll
  const includeSystem = includeSystemProp || showAll

  const collectionsQuery = useQuery({
    queryKey: queryKeys.collections(),
    queryFn: () => api.get<{ data: CollectionRow[] }>('/collections').then((r) => r.data.data),
    staleTime: 60_000
  })
  const rows = collectionsQuery.data ?? []
  // The shared pins from the Collections page — same key and shape as the shared useSharedPins.
  const { data: pins = [] } = useQuery<string[]>({
    queryKey: ['collection-pins'],
    queryFn: () =>
      api
        .get<{ data?: { collections?: string[] } }>('/collection-pins')
        .then((r) => r.data?.data?.collections ?? []),
    staleTime: 30_000,
    retry: 1
  })
  const [recent, setRecent] = useState<string[]>(() => readRecent())
  useEffect(() => {
    if (open) setRecent(readRecent())
    else setSearch('')
  }, [open])

  const sections = useMemo(
    () => collectionSections(rows, { includeHidden, includeSystem }),
    [rows, includeHidden, includeSystem]
  )
  const byKey = useMemo(() => {
    const m = new Map<string, { option: CollectionOption; folder: string }>()
    for (const s of sections)
      for (const o of s.options) m.set(o.collection, { option: o, folder: s.label })
    return m
  }, [sections])

  // Pinned, then Recent (minus pins), then the folders. While searching, every group keeps only
  // its matches, best first; a pinned or recent collection is not repeated in its folder.
  const groups = useMemo(() => {
    const pick = (keys: string[]) =>
      keys
        .map((k) => byKey.get(k))
        .filter((x): x is { option: CollectionOption; folder: string } => !!x)
    const pinned = pick(pins)
    const recentRows = pick(recent.filter((k) => !pins.includes(k)))
    const lifted = new Set(search ? [] : [...pinned, ...recentRows].map((x) => x.option.collection))
    const out: Array<{
      key: string
      label: string
      color: string | null
      icon?: 'pin' | 'recent'
      options: Array<{ option: CollectionOption; folder: string; score: number }>
    }> = []
    const rank = (list: Array<{ option: CollectionOption; folder: string }>) =>
      list
        .map((x) => ({ ...x, score: matchScore(x.option, x.folder, search) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => (search ? b.score - a.score : 0))
    if (!search) {
      if (pinned.length)
        out.push({
          key: '__pinned',
          label: 'Pinned',
          color: null,
          icon: 'pin',
          options: rank(pinned)
        })
      if (recentRows.length)
        out.push({
          key: '__recent',
          label: 'Recent',
          color: null,
          icon: 'recent',
          options: rank(recentRows)
        })
    }
    // A match on the folder name alone is weaker than any name or key match: those rows go to
    // trailing "In folder: …" groups instead of mixing in with the real matches.
    const folderOnly: typeof out = []
    for (const s of sections) {
      const opts = rank(
        s.options
          .filter((o) => !lifted.has(o.collection))
          .map((o) => ({ option: o, folder: s.label }))
      )
      const named = search ? opts.filter((x) => x.score > FOLDER_ONLY) : opts
      const viaFolder = search ? opts.filter((x) => x.score <= FOLDER_ONLY) : []
      if (named.length)
        out.push({ key: s.key || '__other', label: s.label, color: s.color, options: named })
      if (viaFolder.length)
        folderOnly.push({
          key: `${s.key || '__other'}:folder`,
          label: `In folder: ${s.label}`,
          color: s.color,
          options: viaFolder
        })
    }
    if (search) out.sort((a, b) => (b.options[0]?.score ?? 0) - (a.options[0]?.score ?? 0))
    return [...out, ...folderOnly]
  }, [sections, byKey, pins, recent, search])

  const current = useMemo(() => {
    if (!value) return null
    const row = rows.find((c) => c.collection === value)
    return { label: row ? label(row) : value, key: value, known: !!row }
  }, [rows, value])

  const choose = (collection: string) => {
    const next = collection === value ? '' : collection
    if (next) rememberRecent(next)
    onChange(next)
    setOpen(false)
  }
  const matches = groups.reduce((n, g) => n + g.options.length, 0)
  const nameMatches = groups
    .filter((g) => !g.key.endsWith(':folder'))
    .reduce((n, g) => n + g.options.length, 0)

  return (
    <div className={cn('relative flex items-center', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type='button'
            variant='outline'
            role='combobox'
            aria-expanded={open}
            aria-label={ariaLabel}
            data-tip={current ? `${current.label} · ${current.key}` : undefined}
            className={cn(
              'h-8 w-full justify-between gap-2 px-2.5 text-[12px] font-normal',
              current && clearable && 'pr-7'
            )}
          >
            <span className='flex min-w-0 items-center gap-1.5'>
              <Database className='h-3.5 w-3.5 shrink-0 text-muted-foreground' aria-hidden />
              {current ? (
                <span
                  className={cn(
                    'truncate',
                    current.known ? 'text-foreground' : 'font-mono text-muted-foreground'
                  )}
                >
                  {current.label}
                </span>
              ) : (
                <span className='truncate text-muted-foreground'>{placeholder}</span>
              )}
            </span>
            {!(current && clearable) && (
              <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 text-muted-foreground' aria-hidden />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className='w-[400px] max-w-[calc(100vw-24px)] p-0' align='start'>
          <Command shouldFilter={false} loop>
            <CommandInput
              value={search}
              onValueChange={setSearch}
              placeholder='Search by name or key…'
              className='h-9 text-[12.5px]'
            />
            <CommandList className='max-h-[360px] [&_[cmdk-group-heading]]:sticky [&_[cmdk-group-heading]]:top-0 [&_[cmdk-group-heading]]:z-10 [&_[cmdk-group-heading]]:bg-popover'>
              {collectionsQuery.isError ? (
                <div className='px-3 py-6 text-center text-[12px] text-muted-foreground'>
                  Couldn’t load the collections.{' '}
                  <button
                    type='button'
                    className='font-medium text-foreground underline underline-offset-2'
                    onClick={() => void collectionsQuery.refetch()}
                  >
                    Try again
                  </button>
                </div>
              ) : collectionsQuery.isLoading ? (
                <div className='px-3 py-6 text-center text-[12px] text-muted-foreground'>
                  Loading collections…
                </div>
              ) : matches === 0 ? (
                <div className='px-3 py-6 text-center text-[12px] text-muted-foreground'>
                  No collection matches “{search.trim()}”
                  {!showAll && (
                    <button
                      type='button'
                      className='mt-1 block w-full font-medium text-foreground underline underline-offset-2'
                      onClick={() => setShowAll(true)}
                    >
                      Search hidden and system tables too
                    </button>
                  )}
                </div>
              ) : (
                groups.map((g) => (
                  <CommandGroup
                    key={g.key}
                    heading={
                      <span className='flex items-center gap-1.5'>
                        {g.icon === 'pin' && <Pin className='h-3 w-3' aria-hidden />}
                        {g.icon === 'recent' && <History className='h-3 w-3' aria-hidden />}
                        {g.color && (
                          <span
                            aria-hidden
                            className='h-2 w-2 rounded-full'
                            style={{ backgroundColor: g.color }}
                          />
                        )}
                        {g.label}
                        <span className='ml-auto tabular-nums font-normal'>{g.options.length}</span>
                      </span>
                    }
                  >
                    {g.options.map(({ option: o, folder }) => (
                      <CommandItem
                        key={`${g.key}:${o.collection}`}
                        value={`${g.key}:${o.collection}`}
                        onSelect={() => choose(o.collection)}
                        className='gap-2 text-[12.5px]'
                      >
                        <Check
                          className={cn(
                            'h-3.5 w-3.5 shrink-0',
                            o.collection === value ? 'opacity-100' : 'opacity-0'
                          )}
                          aria-hidden
                        />
                        <span className='min-w-[30%] flex-1 truncate'>{o.label}</span>
                        {g.icon && folder && (
                          <span className='hidden max-w-[28%] shrink truncate text-[10.5px] text-muted-foreground sm:inline'>
                            {folder}
                          </span>
                        )}
                        <code className='min-w-0 max-w-[42%] shrink truncate font-mono text-[10.5px] text-muted-foreground'>
                          {o.collection}
                        </code>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ))
              )}
            </CommandList>
            <div className='flex items-center justify-between gap-2 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground'>
              <span className='tabular-nums'>
                {search.trim()
                  ? `${nameMatches} matching${matches > nameMatches ? ` · ${matches - nameMatches} by folder` : ''}`
                  : `${matches} ${matches === 1 ? 'collection' : 'collections'}`}
              </span>
              {!(includeHiddenProp && includeSystemProp) && (
                <label className='flex cursor-pointer items-center gap-1.5'>
                  <input
                    type='checkbox'
                    checked={showAll}
                    onChange={(e) => setShowAll(e.target.checked)}
                    className='h-3 w-3 accent-nvr-cyan'
                  />
                  Hidden and system tables
                </label>
              )}
            </div>
          </Command>
        </PopoverContent>
      </Popover>
      {current && clearable && (
        <button
          type='button'
          aria-label='Clear collection'
          onClick={() => onChange('')}
          className='absolute right-1.5 flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
        >
          <X className='h-3 w-3' />
        </button>
      )}
    </div>
  )
}
