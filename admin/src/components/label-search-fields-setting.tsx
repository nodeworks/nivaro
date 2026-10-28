import { Check, Plus, X } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
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
import { cn, titleCase } from '@/lib/utils'

/**
 * Search item 23 — `browser_config.label_search_fields`.
 *
 * A labels-only search (`GET /global-search?labels=1`, a portal palette) finds a
 * record only by what its label shows. When the label is just a number
 * ("IR-10442"), nobody finds the request by its name or project. These extra
 * text fields are matched too. The server keeps only text columns of the table
 * and only fields the searching person may read (services/search-fields.ts).
 */

const NAMEISH = ['name', 'title', 'label', 'subject']

/** The columns a record's label shows — what a labels-only search matches today.
 *  Mirrors the global search plan: the display template's text fields, else the
 *  first name-like or *_id text column. */
export function labelColumnsFor(
  template: string | null | undefined,
  textFields: string[]
): string[] {
  const has = new Set(textFields)
  if (template?.trim()) {
    const out: string[] = []
    for (const m of template.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g))
      if (has.has(m[1]) && !out.includes(m[1])) out.push(m[1])
    return out
  }
  const first =
    NAMEISH.find((n) => has.has(n)) ?? textFields.find((f) => f.endsWith('_id') && f !== 'id')
  return first ? [first] : []
}

const nameList = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

export function LabelSearchFieldsSetting({
  fields,
  displayTemplate,
  value,
  onChange
}: {
  fields: Array<{ field: string; type: string }>
  displayTemplate: string | null | undefined
  value: string[] | undefined
  onChange: (next: string[] | undefined) => void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const textFields = useMemo(
    () => fields.filter((f) => f.type === 'string' || f.type === 'text'),
    [fields]
  )
  const labelCols = useMemo(
    () =>
      labelColumnsFor(
        displayTemplate,
        textFields.map((f) => f.field)
      ),
    [displayTemplate, textFields]
  )
  if (textFields.length === 0) return null
  const known = new Set(textFields.map((f) => f.field))
  // A stored name that is no longer a text field is ignored by the server too.
  const picked = (value ?? []).filter((f) => known.has(f))
  const choices = textFields.filter((f) => !labelCols.includes(f.field))
  const toggle = (field: string) => {
    const next = picked.includes(field) ? picked.filter((f) => f !== field) : [...picked, field]
    onChange(next.length ? next : undefined)
  }
  const label = (f: string) => titleCase(f)
  const labelPart = labelCols.length
    ? `${nameList(labelCols.map(label))} (shown in the label)`
    : null
  const extraPart = picked.length ? nameList(picked.map(label)) : null

  return (
    <div className='space-y-1.5' data-label-search-fields>
      <div>
        <p
          id={`lsf-title-${id}`}
          className='text-[12.5px] font-medium text-slate-700 dark:text-foreground'
        >
          Label search fields
        </p>
        <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          When a search is limited to labels (the portal’s search bar), a record is found only by
          what its label shows. Add the fields people also type to find one — a request’s name or
          project, say. Each person still only matches fields they are allowed to read.
        </p>
      </div>
      <fieldset
        className='m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0'
        aria-labelledby={`lsf-title-${id}`}
      >
        {picked.map((f) => (
          <span
            key={f}
            className='inline-flex h-6 items-center gap-1 rounded-md border border-slate-200 bg-slate-50 pl-2 pr-1 text-[12px] text-slate-700 dark:border-border dark:bg-muted/40 dark:text-foreground'
          >
            {label(f)}
            <span className='font-mono text-[10.5px] text-slate-500 dark:text-muted-foreground'>
              {f}
            </span>
            <button
              type='button'
              onClick={() => toggle(f)}
              aria-label={`Stop matching ${label(f)}`}
              data-tip={`Stop matching ${label(f)}`}
              className='ml-0.5 rounded p-0.5 text-slate-500 hover:bg-slate-200 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground'
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
              disabled={choices.length === 0}
            >
              <Plus className='h-3 w-3' />
              {picked.length ? 'Add field' : 'Choose fields'}
            </Button>
          </PopoverTrigger>
          <PopoverContent align='start' className='w-[280px] p-0'>
            <Command>
              <CommandInput placeholder='Find a text field…' className='h-8 text-[12.5px]' />
              <CommandList>
                <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
                  No text field matches
                </CommandEmpty>
                <CommandGroup>
                  {choices.map((f) => (
                    <CommandItem
                      key={f.field}
                      value={`${f.field} ${label(f.field)}`}
                      onSelect={() => toggle(f.field)}
                      className='text-[12.5px]'
                    >
                      <Check
                        className={cn(
                          'mr-1.5 h-3.5 w-3.5',
                          picked.includes(f.field) ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                      <span className='truncate'>{label(f.field)}</span>
                      <span className='ml-auto pl-2 font-mono text-[10.5px] text-slate-500 dark:text-muted-foreground'>
                        {f.type === 'text' ? 'long text' : f.field}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </fieldset>
      <p className='text-[11.5px] text-slate-600 dark:text-slate-300' aria-live='polite'>
        {labelPart || extraPart ? (
          <>
            A labels-only search matches{' '}
            {labelPart && (
              <span className='font-medium text-slate-800 dark:text-foreground'>{labelPart}</span>
            )}
            {labelPart && extraPart && ' and also '}
            {extraPart && (
              <span className='font-medium text-slate-800 dark:text-foreground'>{extraPart}</span>
            )}
            .
          </>
        ) : (
          'The label shows no text field, so a labels-only search finds nothing here until you add one.'
        )}
      </p>
    </div>
  )
}
