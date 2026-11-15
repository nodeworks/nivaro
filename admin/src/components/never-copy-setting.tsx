import { useQuery } from '@tanstack/react-query'
import { Check, Plus, X } from 'lucide-react'
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
import { cn, titleCase } from '@/lib/utils'

/**
 * `browser_config.never_copy` (Rob 2026-11-14) — fields a copy of a record never
 * carries, on top of the automatic rule (api services/copy-rules.ts): the
 * pipeline's state field, generated ids, read-only, hidden and "do not
 * duplicate" fields. Used by Clone, More → Duplicate and Save as template.
 */
const REASON_WORDS: Record<string, string> = {
  'pipeline-state': 'workflow step',
  generated: 'generated id',
  calculated: 'calculated',
  rollup: 'total from lines',
  'read-only': 'read-only',
  'do-not-duplicate': 'marked do not duplicate',
  hidden: 'hidden'
}

const LIST_TYPES = new Set(['alias', 'o2m', 'm2m', 'm2a', 'files'])

export function NeverCopySetting({
  collection,
  fields,
  value,
  onChange
}: {
  collection: string
  fields: Array<{ field: string; type: string }>
  value: string[] | null | undefined
  onChange: (next: string[] | undefined) => void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const picked = (value ?? []).filter((f) => fields.some((x) => x.field === f))
  // What the server leaves out on its own (field → reason), shown so nobody adds them twice.
  const rules = useQuery({
    queryKey: ['copy-rules', collection],
    queryFn: () =>
      api
        .get<{ data: { skip: Record<string, string> } }>(`/copy-rules/${collection}`)
        .then((r) => r.data.data.skip ?? {}),
    staleTime: 0
  })
  const automatic = Object.entries(rules.data ?? {}).filter(
    ([f, why]) => REASON_WORDS[why] && fields.some((x) => x.field === f)
  )
  const autoSet = new Set(automatic.map(([f]) => f))
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
          Never copied when duplicating
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
            {titleCase(f)}
            <button
              type='button'
              onClick={() => toggle(f)}
              aria-label={`Copy ${titleCase(f)} again`}
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
                      value={`${titleCase(f.field)} ${f.field}`}
                      onSelect={() => toggle(f.field)}
                      className='text-[12.5px]'
                    >
                      <Check
                        className={cn(
                          'mr-1.5 h-3.5 w-3.5',
                          picked.includes(f.field) ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                      {titleCase(f.field)}
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
      {automatic.length > 0 && (
        <p
          className='text-[11.5px] leading-relaxed text-slate-500 dark:text-muted-foreground'
          data-never-copy-automatic
        >
          Always left out:{' '}
          {automatic.map(([f, why], i) => (
            <span key={f}>
              {i > 0 && ', '}
              <span className='text-slate-700 dark:text-foreground'>{titleCase(f)}</span> (
              {REASON_WORDS[why]})
            </span>
          ))}
        </p>
      )}
    </div>
  )
}
