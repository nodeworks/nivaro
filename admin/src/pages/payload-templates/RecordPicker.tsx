import { Check, ChevronsUpDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
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
import { errorMessage, type RecordOption, useDebounced, useRecordSearch } from './api'

/**
 * Which real record the preview renders. Opens on the newest record of the
 * template's collection (picked once, when nothing is chosen yet); typing
 * searches the collection's display field on the server.
 */
export function RecordPicker({
  templateKey,
  collection,
  value,
  onChange
}: {
  templateKey: string
  collection: string
  value: string | null
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const dq = useDebounced(q.trim(), 250)
  const newest = useRecordSearch(templateKey, '')
  const search = useRecordSearch(templateKey, dq)
  const results = dq ? search : newest
  // Labels of records seen so far, so the trigger can name the chosen one after a search.
  const [labels, setLabels] = useState<Record<string, string>>({})

  useEffect(() => {
    const rows = [...(newest.data ?? []), ...(search.data ?? [])]
    if (!rows.length) return
    setLabels((prev) => {
      let changed = false
      const next = { ...prev }
      for (const r of rows) {
        if (r.label && next[r.id] !== r.label) {
          next[r.id] = r.label
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [newest.data, search.data])

  // Default to the newest record — once per template, never over a person's pick.
  const autoPickedFor = useRef<string | null>(null)
  const first = newest.data?.[0]?.id ?? null
  useEffect(() => {
    if (value || !first || autoPickedFor.current === templateKey) return
    autoPickedFor.current = templateKey
    onChange(first)
  }, [value, first, templateKey, onChange])

  const options: RecordOption[] = results.data ?? []
  const label = value ? labels[value] : null
  const noRecords = !newest.isLoading && !newest.isError && (newest.data ?? []).length === 0

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setQ('')
      }}
    >
      <PopoverTrigger asChild>
        <button
          type='button'
          role='combobox'
          aria-expanded={open}
          aria-label={`Preview record (${collection})`}
          disabled={noRecords}
          className='flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 text-left text-[12.5px] hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:opacity-60 dark:border-border dark:bg-background dark:hover:bg-muted'
          data-payload-record-picker
        >
          {value ? (
            <>
              <span className='min-w-0 truncate text-slate-800 dark:text-foreground'>
                {label || `Record ${value}`}
              </span>
              {label && (
                <span className='shrink-0 font-mono text-[11px] text-slate-400'>#{value}</span>
              )}
            </>
          ) : (
            <span className='truncate text-slate-400'>
              {newest.isLoading
                ? 'Finding the newest record…'
                : noRecords
                  ? `No ${collection} records yet`
                  : 'Pick a record'}
            </span>
          )}
          <span className='flex-1' />
          <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[320px] p-0' align='start'>
        <Command shouldFilter={false}>
          <CommandInput
            value={q}
            onValueChange={setQ}
            placeholder={`Search ${collection}…`}
            className='h-8 text-[12px]'
          />
          <CommandList>
            {results.isError ? (
              <p className='px-3 py-3 text-[12px] text-red-600 dark:text-red-400'>
                {errorMessage(results.error, 'Could not search records')}
              </p>
            ) : results.isLoading || (dq && search.isFetching && !search.data) ? (
              <div className='space-y-1.5 p-2' aria-hidden>
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className='h-6 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]'
                  />
                ))}
              </div>
            ) : (
              <>
                <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
                  {dq ? `No ${collection} record matches “${dq}”` : 'No records'}
                </CommandEmpty>
                <CommandGroup heading={dq ? undefined : 'Newest'}>
                  {options.map((o) => (
                    <CommandItem
                      key={o.id}
                      value={o.id}
                      onSelect={() => {
                        onChange(o.id)
                        setOpen(false)
                        setQ('')
                      }}
                      className='gap-2 text-[12.5px]'
                    >
                      <Check
                        className={cn(
                          'h-3 w-3 shrink-0',
                          o.id === value ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                      <span className='min-w-0 flex-1 truncate'>{o.label || `Record ${o.id}`}</span>
                      <span className='shrink-0 font-mono text-[11px] text-slate-400'>#{o.id}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
