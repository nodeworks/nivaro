import { useQuery } from '@tanstack/react-query'
import { FileSearch } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'

/**
 * Revision value search (#98), collection-wide: "which records ever held this
 * value" — mined from revision deltas, newest first. Admin-only (deltas carry
 * fields roles may not read); bounded by a date window + 200-match cap.
 */

export default function RevisionSearch() {
  const [collection, setCollection] = useState('')
  const [q, setQ] = useState('')
  const [field, setField] = useState('')
  const [days, setDays] = useState(90)
  const [applied, setApplied] = useState<{
    collection: string
    q: string
    field: string
    days: number
  } | null>(null)

  const { data: collections = [] } = useQuery<Array<{ collection: string }>>({
    queryKey: ['collections'],
    queryFn: () => api.get('/collections').then((r) => r.data.data),
    staleTime: 60_000
  })

  const { data, isFetching } = useQuery<{
    matches: Array<{
      revision_id: number
      item: string
      timestamp: string | null
      user_name: string | null
      action: string | null
      fields: Array<{ field: string; value: string }>
    }>
    scanned: number
    truncated: boolean
  }>({
    queryKey: ['revision-search', applied],
    queryFn: () =>
      api
        .get('/revisions/value-search', {
          params: {
            collection: applied!.collection,
            q: applied!.q,
            days: applied!.days,
            ...(applied!.field ? { field: applied!.field } : {})
          }
        })
        .then((r) => r.data.data),
    enabled: !!applied
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <FileSearch className='h-5 w-5 text-muted-foreground' />
          <div>
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
              History Search
            </h1>
            <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Search recorded changes by VALUE — which records ever held it, who wrote it, when.
              Mined from revision history, newest first.
            </p>
          </div>
        </div>
        <form
          className='mt-3 flex flex-wrap items-end gap-2'
          onSubmit={(e) => {
            e.preventDefault()
            if (collection && q.trim().length >= 2)
              setApplied({ collection, q: q.trim(), field: field.trim(), days })
          }}
        >
          <Combobox
            value={collection}
            onChange={setCollection}
            options={collections
              .filter((c) => !c.collection.startsWith('nivaro_'))
              .map((c) => ({ value: c.collection, label: c.collection }))}
            placeholder='Collection…'
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder='Value to find (e.g. Zone 5, 42000)…'
            className='h-8 w-[260px] rounded-md border border-slate-200 bg-background px-2.5 text-[12.5px] dark:border-border'
          />
          <input
            value={field}
            onChange={(e) => setField(e.target.value)}
            placeholder='Field (optional)'
            className='h-8 w-[160px] rounded-md border border-slate-200 bg-background px-2.5 font-mono text-[12px] dark:border-border'
          />
          <label className='flex items-center gap-1.5 text-[12px] text-slate-500'>
            Last
            <input
              value={days}
              onChange={(e) => setDays(Math.min(730, Math.max(1, Number(e.target.value) || 90)))}
              inputMode='numeric'
              className='h-8 w-14 rounded-md border border-slate-200 bg-background px-2 text-right text-[12.5px] dark:border-border'
            />
            days
          </label>
          <button
            type='submit'
            disabled={!collection || q.trim().length < 2}
            className='h-8 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-semibold text-white disabled:opacity-50'
          >
            Search
          </button>
        </form>
      </header>

      <div className='flex-1 overflow-y-auto p-6'>
        {!applied ? (
          <p className='text-[13px] text-slate-400'>
            Pick a collection and a value. Scoped to changed fields (deltas) — a value a record
            was CREATED with and never changed appears under its create revision.
          </p>
        ) : isFetching ? (
          <p className='text-[13px] text-slate-400'>Scanning revision history…</p>
        ) : (data?.matches ?? []).length === 0 ? (
          <p className='text-[13px] text-slate-400'>
            “{applied.q}” doesn't appear in {applied.collection}'s recorded changes in the last{' '}
            {applied.days} days.
          </p>
        ) : (
          <div className='max-w-[880px] space-y-2'>
            <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              {data?.matches.length} match(es)
              {data?.truncated && ' — capped at the newest 200; narrow the window or add a field'}
            </p>
            {data?.matches.map((m) => (
              <div
                key={m.revision_id}
                className='rounded-lg border border-slate-200 bg-white px-4 py-2.5 dark:border-border dark:bg-card'
              >
                <p className='text-[13px]'>
                  <Link
                    to={`/collections/${applied.collection}/${m.item}`}
                    className='font-mono font-medium text-nvr-navy underline decoration-dotted hover:text-nvr-cyan dark:text-nvr-cyan'
                  >
                    {applied.collection}/{m.item}
                  </Link>{' '}
                  <span className='text-slate-600 dark:text-muted-foreground'>
                    {m.fields.map((f) => (
                      <span key={f.field} className='mr-2'>
                        <span className='font-mono text-[11.5px]'>{f.field}</span> → “
                        {f.value.length > 80 ? `${f.value.slice(0, 80)}…` : f.value}”
                      </span>
                    ))}
                  </span>
                </p>
                <p className='mt-0.5 text-[11px] text-slate-400'>
                  {m.user_name ?? 'System'} ·{' '}
                  {m.timestamp ? new Date(m.timestamp).toLocaleString() : ''} · {m.action}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}


// Local combobox — the admin has no shared one; this mirrors the per-page
// pattern (SyncJobs/FieldRulesSection) per the no-native-select convention.
function Combobox({
  value,
  onChange,
  options,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='h-8 w-[220px] justify-between px-2 font-mono text-[12px] font-normal'
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : (placeholder ?? 'Select…')}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[260px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No results
            </CommandEmpty>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem
                  key={opt.value}
                  value={opt.value}
                  keywords={[opt.label]}
                  onSelect={(current) => {
                    onChange(current === value ? '' : current)
                    setOpen(false)
                  }}
                  className='font-mono text-[12px]'
                >
                  {opt.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
