import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Check,
  ChevronDown,
  ChevronRight,
  X
} from 'lucide-react'
import { type ReactNode, useEffect, useId, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn, titleCase } from '../../lib/utils'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { type QuickFilterDef, quickFilterProblems, slugKey, uniqueKey } from './config'
import { type FacetMeta, guessLabelField, pathLabel, useFacetMeta } from './facets'
import { type PickedFacet, QuickFilterFieldPicker, usedPathLabels } from './QuickFilterFieldPicker'

export const qfInputCls =
  'h-7 w-full rounded-md border border-slate-200 bg-white px-2 text-[12px] text-slate-800 placeholder:text-slate-400 focus:border-nvr-cyan/60 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/25 selection:bg-nvr-cyan/30 selection:text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:selection:text-white'
const labelCls = 'mb-1 block text-[11px] font-medium text-slate-600 dark:text-slate-300'
const hintCls = 'mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400'

/**
 * Turn a picked relation into the filter's options source: where the options
 * load from and the column they are shown by (the target's display template,
 * else a usual name column). Shared by "Add quick filter" and "Change".
 */
export async function facetDefaults(
  qc: ReturnType<typeof useQueryClient>,
  client: ReturnType<typeof useNivaroClient>,
  picked: PickedFacet
): Promise<Pick<QuickFilterDef, 'collection' | 'label_field' | 'value_field'>> {
  const meta = await qc
    .fetchQuery<FacetMeta>({
      queryKey: ['cbv-collection-meta', picked.target],
      queryFn: () =>
        client
          .request<{ data: FacetMeta }>(get(`/collections/${picked.target}`))
          .then((r) => r.data),
      staleTime: 10 * 60_000
    })
    .catch(() => null)
  return { collection: picked.target, label_field: guessLabelField(meta), value_field: 'id' }
}

/** Searchable single pick (Popover + Command) — collections and columns can run long. */
function SearchPick({
  value,
  onChange,
  options,
  blank,
  ariaLabel,
  loaded = true,
  missingHint
}: {
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
  /** Label of the "nothing chosen" choice; absent = no blank choice. */
  blank?: string
  ariaLabel: string
  /** The options have arrived (a stored value is only "missing" after that). */
  loaded?: boolean
  /** Shown under the field when the stored value is not among the options. */
  missingHint?: string
}) {
  const [open, setOpen] = useState(false)
  const all = [
    ...(blank !== undefined ? [{ value: '', label: blank }] : []),
    ...options,
    // A stored value the source no longer has stays visible rather than blank;
    // what is wrong with it is said under the field, not cut off in here.
    ...(value && !options.some((o) => o.value === value)
      ? [{ value, label: titleCase(value) }]
      : [])
  ]
  const missing = loaded && !!value && !options.some((o) => o.value === value)
  const selected = all.find((o) => o.value === value)
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            role='combobox'
            aria-expanded={open}
            aria-label={ariaLabel}
            className='flex h-7 w-full min-w-0 items-center justify-between gap-1 rounded-md border border-slate-200 bg-white px-2 text-left text-[12px] text-slate-800 hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:border-slate-600'
          >
            <span className={cn('truncate', !value && 'text-slate-500 dark:text-slate-400')}>
              {selected?.label ?? blank ?? 'Choose…'}
            </span>
            <ChevronDown aria-hidden className='h-3.5 w-3.5 shrink-0 text-slate-400' />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align='start'
          sideOffset={4}
          className='w-[min(16rem,calc(100vw-2rem))] rounded-lg border-slate-200 p-0 dark:border-slate-700 dark:bg-slate-900'
        >
          <Command>
            <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
            <CommandList className='max-h-60'>
              <CommandEmpty className='py-3 text-center text-[12px] text-slate-500'>
                Nothing matches
              </CommandEmpty>
              <CommandGroup>
                {all.map((o) => (
                  <CommandItem
                    key={o.value || '__blank__'}
                    value={`${o.label} ${o.value}`}
                    onSelect={() => {
                      onChange(o.value)
                      setOpen(false)
                    }}
                    className='text-[12px]'
                  >
                    <Check
                      aria-hidden
                      className={cn(
                        'mr-1.5 h-3 w-3',
                        o.value === value ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    {o.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {missing && missingHint && (
        <p className='mt-1 text-[11px] leading-snug text-amber-800 dark:text-amber-300'>
          {missingHint}
        </p>
      )}
    </>
  )
}

function ColumnPick({
  collection,
  ...rest
}: {
  collection: string
  value: string
  onChange: (v: string) => void
  blank?: string
  ariaLabel: string
}) {
  const meta = useFacetMeta(collection || null)
  const options = (meta.data?.fields ?? [])
    .filter((f) => !f.field.startsWith('__'))
    .map((f) => ({ value: f.field, label: f.field === 'id' ? 'ID' : titleCase(f.field) }))
  return (
    <SearchPick
      {...rest}
      options={options}
      // An unknown source has no fields: its own hint says so, not every column's.
      loaded={options.length > 0}
      missingHint='Not a column of the options source.'
    />
  )
}

function CollectionPick({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const client = useNivaroClient()
  const { data = [], isSuccess } = useQuery({
    queryKey: ['nvr-collections-registry'],
    queryFn: () =>
      client
        .request<{ data: Array<{ collection: string; display_name?: string | null }> }>(
          get('/collections')
        )
        .then((r) => (r.data ?? []).filter((c) => !c.collection.startsWith('nivaro_'))),
    staleTime: 5 * 60_000
  })
  return (
    <SearchPick
      value={value}
      onChange={onChange}
      ariaLabel='Options from'
      blank={value ? undefined : 'Choose…'}
      loaded={isSuccess}
      missingHint='This collection isn’t registered — its options may not load.'
      options={data.map((c) => ({
        value: c.collection,
        label: c.display_name?.trim() || titleCase(c.collection)
      }))}
    />
  )
}

/**
 * One quick filter's settings — the same form in the list's in-place editor
 * and in Data model → Settings, so the two can never offer different options.
 */
export function QuickFilterForm({
  collection,
  value,
  all,
  onChange,
  isNew = false,
  onPickingChange,
  footer,
  className
}: {
  /** The list's collection — where every path starts. */
  collection: string
  value: QuickFilterDef
  /** Every filter on the bar (duplicate-key check, "on the bar" marks). */
  all: QuickFilterDef[]
  onChange: (partial: Partial<QuickFilterDef>) => void
  /** A filter added in this edit: its key follows the name. A saved filter's
   *  key never moves on its own — people's picks and default filters follow it. */
  isNew?: boolean
  /** Tells the host when the field list replaces the form (it hides its own footer). */
  onPickingChange?: (picking: boolean) => void
  footer?: ReactNode
  className?: string
}) {
  const qc = useQueryClient()
  const client = useNivaroClient()
  const ids = useId()
  // 'path' = picking the main field; a number = picking "or" path n.
  const [picking, setPicking] = useState<'path' | number | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the host's setter
  useEffect(() => onPickingChange?.(picking !== null), [picking])
  const problems = quickFilterProblems(value, all)
  const paths = value.or_paths?.length ? value.or_paths : value.path?.length ? [value.path] : []

  const pick = async (p: PickedFacet) => {
    const slot = picking
    setPicking(null)
    if (slot === 'path' || slot === 0) {
      const sameSource = p.target === value.collection
      const defaults = sameSource ? {} : await facetDefaults(qc, client, p)
      if (value.or_paths?.length) {
        onChange({ or_paths: [p.path, ...value.or_paths.slice(1)], path: p.path, ...defaults })
      } else onChange({ path: p.path, ...defaults })
      return
    }
    if (typeof slot === 'number') {
      const next = [...paths]
      next[slot] = p.path
      onChange({ or_paths: next })
    }
  }

  const removePath = (i: number) => {
    const next = paths.filter((_, idx) => idx !== i)
    if (next.length <= 1) onChange({ or_paths: undefined, path: next[0] ?? [] })
    else onChange({ or_paths: next, path: next[0] })
  }

  if (picking !== null) {
    const changing = typeof picking === 'number' ? paths[picking] : paths[0]
    return (
      <div className={cn(className, 'p-0')}>
        <QuickFilterFieldPicker
          rootCollection={collection}
          initialPath={changing}
          currentPath={changing}
          used={usedPathLabels(all.filter((o) => o !== value))}
          onPick={(p) => void pick(p)}
          onCancel={() => setPicking(null)}
        />
      </div>
    )
  }

  const desc = (value.sort ?? '').startsWith('-')
  const sortField = (value.sort ?? '').replace(/^-/, '')

  return (
    <div className={cn('space-y-3', className)}>
      {problems.length > 0 && (
        <p
          role='status'
          className='rounded-md bg-amber-50 px-2 py-1.5 text-[11.5px] leading-snug text-amber-800 dark:bg-amber-500/10 dark:text-amber-200'
        >
          This filter {problems.join(', ')} before it can be saved.
        </p>
      )}
      <div>
        <label htmlFor={`${ids}-name`} className={labelCls}>
          Name on the bar
        </label>
        <input
          id={`${ids}-name`}
          data-qf-name=''
          value={value.label ?? ''}
          placeholder='Funding Year'
          onChange={(e) => {
            const label = e.target.value
            onChange(
              isNew
                ? {
                    label,
                    key: uniqueKey(
                      slugKey(label),
                      all.filter((o) => o !== value)
                    )
                  }
                : { label }
            )
          }}
          className={qfInputCls}
        />
      </div>

      <div>
        <span className={labelCls}>Filters by</span>
        {paths.length === 0 ? (
          <button
            type='button'
            onClick={() => setPicking('path')}
            className='flex h-7 w-full items-center justify-between rounded-md border border-dashed border-slate-300 px-2 text-[12px] text-slate-500 hover:border-nvr-cyan/60 hover:text-slate-800 dark:border-slate-600 dark:text-slate-400 dark:hover:text-slate-100'
          >
            Pick a field
            <ChevronRight aria-hidden className='h-3.5 w-3.5' />
          </button>
        ) : (
          <ul className='space-y-1'>
            {paths.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the same path may sit in two slots while being edited
              <li key={`${i}-${p.join('.')}`} className='flex items-center gap-1'>
                {i > 0 && (
                  <span className='w-5 shrink-0 text-center text-[11px] text-slate-500 dark:text-slate-400'>
                    or
                  </span>
                )}
                <button
                  type='button'
                  onClick={() => setPicking(i === 0 ? 'path' : i)}
                  aria-label={`Change field ${pathLabel(p)}`}
                  className='flex h-7 min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-2 text-left text-[12px] text-slate-800 hover:border-nvr-cyan/60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100'
                >
                  <span className='truncate'>{pathLabel(p)}</span>
                  <span className='shrink-0 text-[11px] text-slate-500 dark:text-slate-400'>
                    Change
                  </span>
                </button>
                {paths.length > 1 && (
                  <button
                    type='button'
                    onClick={() => removePath(i)}
                    aria-label={`Stop matching ${pathLabel(p)}`}
                    className='flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-800 dark:hover:text-red-400'
                  >
                    <X className='h-3.5 w-3.5' />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className='grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2'>
        <div>
          <span className={labelCls}>Options show</span>
          <ColumnPick
            collection={value.collection ?? ''}
            value={value.label_field ?? ''}
            onChange={(v) => onChange({ label_field: v })}
            ariaLabel='Column the options show'
          />
        </div>
        <div>
          <span className={labelCls}>Order</span>
          <div className='flex gap-1'>
            <div className='min-w-0 flex-1'>
              <ColumnPick
                collection={value.collection ?? ''}
                value={sortField}
                onChange={(v) => onChange({ sort: v ? (desc ? `-${v}` : v) : undefined })}
                blank='As stored'
                ariaLabel='Option order'
              />
            </div>
            <button
              type='button'
              disabled={!sortField}
              onClick={() => onChange({ sort: desc ? sortField : `-${sortField}` })}
              aria-label={
                desc ? 'Descending — switch to ascending' : 'Ascending — switch to descending'
              }
              data-tip={sortField ? (desc ? 'Descending' : 'Ascending') : undefined}
              className='flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
            >
              {desc ? (
                <ArrowDownWideNarrow className='h-3.5 w-3.5' />
              ) : (
                <ArrowUpNarrowWide className='h-3.5 w-3.5' />
              )}
            </button>
          </div>
        </div>
      </div>

      <details className='group'>
        <summary className='inline-flex cursor-pointer list-none items-center gap-1 rounded text-[11.5px] font-medium text-slate-600 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-slate-300 dark:hover:text-white [&::-webkit-details-marker]:hidden'>
          <ChevronRight aria-hidden className='h-3 w-3 transition-transform group-open:rotate-90' />
          More options
        </summary>
        <div className='mt-2 space-y-3'>
          <div className='grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2'>
            <div>
              <span className={labelCls}>Options from</span>
              <CollectionPick
                value={value.collection ?? ''}
                onChange={(v) => onChange({ collection: v })}
              />
            </div>
            <div>
              <span className={labelCls}>Value column</span>
              <ColumnPick
                collection={value.collection ?? ''}
                value={value.value_field && value.value_field !== 'id' ? value.value_field : ''}
                onChange={(v) => onChange({ value_field: v || undefined })}
                blank='ID (default)'
                ariaLabel='Value column'
              />
            </div>
          </div>
          <div>
            <label htmlFor={`${ids}-key`} className={labelCls}>
              Key
            </label>
            <input
              id={`${ids}-key`}
              value={value.key ?? ''}
              placeholder='fy'
              onChange={(e) => onChange({ key: slugKey(e.target.value) })}
              className={cn(qfInputCls, 'font-mono')}
            />
            <p className={hintCls}>
              {isNew
                ? 'Follows the name until you change it.'
                : 'People’s picks and default filters follow the key — changing it clears them.'}
            </p>
          </div>
          {paths.length > 0 && (
            <div>
              <button
                type='button'
                onClick={() => setPicking(paths.length)}
                className='text-[11.5px] font-medium text-[#0284a8] hover:underline dark:text-nvr-cyan'
              >
                Also match another field
              </button>
              <p className={hintCls}>
                For a value records reach two ways — the filter matches either one.
              </p>
            </div>
          )}
        </div>
      </details>
      {footer}
    </div>
  )
}
