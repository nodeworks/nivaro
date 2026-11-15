import { fieldTitle, groupNeverCopied } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronDown, Plus, X } from 'lucide-react'
import { useId, useState } from 'react'
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
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * `browser_config.never_copy` (Rob 2026-11-14) — fields a copy of a record never
 * carries, on top of the automatic rule (api services/copy-rules.ts): the
 * pipeline's state field, generated ids, read-only, hidden and "do not
 * duplicate" fields. Used by Clone, More → Duplicate and Save as template.
 */
const LIST_TYPES = new Set(['alias', 'o2m', 'm2m', 'm2a', 'files'])

export function NeverCopySetting({
  collection,
  fields,
  value,
  onChange
}: {
  collection: string
  fields: Array<{ field: string; type: string; label?: string | null }>
  value: string[] | null | undefined
  onChange: (next: string[] | undefined) => void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [showAuto, setShowAuto] = useState(false)
  const picked = (value ?? []).filter((f) => fields.some((x) => x.field === f))
  const labelOf = (name: string) =>
    fields.find((f) => f.field === name)?.label?.trim() || fieldTitle(name)
  // What the server leaves out on its own (field → reason), shown so nobody adds them twice.
  const rules = useQuery({
    queryKey: ['copy-rules', collection],
    queryFn: () =>
      api
        .get<{ data: { skip: Record<string, string> } }>(`/copy-rules/${collection}`)
        .then((r) => r.data.data.skip ?? {}),
    staleTime: 0
  })
  // Grouped by reason; the collection's own list is the chips above, never repeated here.
  const automatic = groupNeverCopied(rules.data, fields).filter((g) => g.reason !== 'never-copy')
  const autoCount = automatic.reduce((n, g) => n + g.fields.length, 0)
  const autoSet = new Set(automatic.flatMap((g) => g.fields.map((f) => f.field)))
  const choosable = fields.filter(
    (f) => !LIST_TYPES.has(f.type) && f.field !== 'id' && !autoSet.has(f.field)
  )
  const toggle = (f: string) => {
    const next = picked.includes(f) ? picked.filter((x) => x !== f) : [...picked, f]
    onChange(next.length ? next : undefined)
  }

  return (
    <div className='space-y-1.5' data-never-copy-setting>
      <div className='min-w-0'>
        <p
          id={`nc-title-${id}`}
          className='text-[12.5px] font-medium text-slate-700 dark:text-foreground'
        >
          Never copied (Clone, Duplicate, Save as template)
        </p>
        <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          A copy is a new record: it starts at the first workflow step and leaves these fields
          empty. Add partner numbers, statuses and anything that belongs to the original only.
        </p>
      </div>
      <fieldset
        className='m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0'
        aria-labelledby={`nc-title-${id}`}
      >
        {picked.map((f) => (
          <span
            key={f}
            className='inline-flex h-6 items-center gap-1 rounded-md border border-slate-200 bg-slate-50 pl-2 pr-1 text-[12px] text-slate-700 dark:border-border dark:bg-muted/40 dark:text-foreground'
          >
            {labelOf(f)}
            <button
              type='button'
              onClick={() => toggle(f)}
              aria-label={`Copy ${labelOf(f)} again`}
              className='ml-0.5 rounded p-0.5 text-slate-500 hover:bg-slate-200 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground'
            >
              <X className='h-3 w-3' />
            </button>
          </span>
        ))}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type='button'
              variant='outline'
              size='sm'
              role='combobox'
              aria-expanded={open}
              className='h-6 gap-1 px-2 text-[12px] font-normal'
            >
              <Plus className='h-3 w-3' />
              {picked.length ? 'Add field' : 'Choose fields'}
            </Button>
          </PopoverTrigger>
          <PopoverContent align='start' className='w-[280px] p-0'>
            <Command>
              <CommandInput placeholder='Find a field…' className='h-8 text-[12.5px]' />
              <CommandList>
                <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
                  No field matches
                </CommandEmpty>
                <CommandGroup>
                  {choosable.map((f) => (
                    <CommandItem
                      key={f.field}
                      value={`${labelOf(f.field)} ${f.field}`}
                      onSelect={() => toggle(f.field)}
                      className='text-[12.5px]'
                    >
                      <Check
                        className={cn(
                          'mr-1.5 h-3.5 w-3.5',
                          picked.includes(f.field) ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                      {labelOf(f.field)}
                      <span className='ml-auto font-mono text-[10.5px] text-muted-foreground'>
                        {f.field}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </fieldset>
      {autoCount > 0 && (
        <div data-never-copy-automatic>
          <button
            type='button'
            aria-expanded={showAuto}
            onClick={() => setShowAuto((v) => !v)}
            className='inline-flex items-center gap-1 rounded text-[11.5px] text-slate-500 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-muted-foreground dark:hover:text-foreground'
            data-never-copy-automatic-toggle
          >
            {autoCount === 1 ? '1 field is' : `${autoCount} fields are`} always left out
            <ChevronDown className={cn('h-3 w-3 transition-transform', showAuto && 'rotate-180')} />
          </button>
          {showAuto && (
            <dl className='mt-1.5 space-y-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] dark:border-border dark:bg-muted/40'>
              {automatic.map((g) => (
                <div key={g.label} className='flex gap-2'>
                  <dt className='w-40 shrink-0 text-slate-500 dark:text-muted-foreground'>
                    {g.label}
                  </dt>
                  <dd className='min-w-0 text-slate-700 dark:text-foreground'>
                    {g.fields.map((f) => f.label).join(', ')}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </div>
  )
}
