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
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn, titleCase } from '@/lib/utils'

/**
 * `browser_config.duplicate_check` (Rob 2026-11-13) — "Warn about duplicates on: name".
 * Auto (unset) checks small reference lists whose label is one text field; On checks the
 * chosen fields on any table; Off never. "Block exact copies" makes the server refuse a
 * create whose value equals an existing record's (api services/duplicate-check.ts).
 */
export interface DuplicateCheckValue {
  mode?: 'on' | 'off'
  fields?: string[]
  block_exact?: boolean
}

const MODES: Array<{ value: 'auto' | 'on' | 'off'; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' }
]

export function DuplicateCheckSetting({
  collection,
  fields,
  value,
  onChange
}: {
  collection: string
  fields: Array<{ field: string; type: string }>
  value: DuplicateCheckValue | null | undefined
  onChange: (next: DuplicateCheckValue | undefined) => void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const mode = value?.mode ?? 'auto'
  const textFields = fields.filter((f) => f.type === 'string' || f.type === 'text')
  const picked = (value?.fields ?? []).filter((f) => textFields.some((t) => t.field === f))
  // What the server makes of it (fields compared, or why auto is off).
  const resolved = useQuery({
    queryKey: ['duplicate-check-config', collection, JSON.stringify(value ?? null)],
    queryFn: () =>
      api
        .get<{
          data: { enabled: boolean; fields: string[]; reason?: string | null; source?: string }
        }>(`/duplicates/${collection}`)
        .then((r) => r.data.data),
    staleTime: 0
  })
  const commit = (next: DuplicateCheckValue) => {
    const clean: DuplicateCheckValue = {}
    if (next.mode) clean.mode = next.mode
    if (next.fields?.length) clean.fields = next.fields
    if (next.block_exact) clean.block_exact = true
    onChange(Object.keys(clean).length ? clean : undefined)
  }
  const setMode = (m: 'auto' | 'on' | 'off') =>
    commit({ ...value, mode: m === 'auto' ? undefined : m })
  const toggle = (f: string) =>
    commit({
      ...value,
      fields: picked.includes(f) ? picked.filter((x) => x !== f) : [...picked, f]
    })
  const r = resolved.data
  const status = !r
    ? null
    : r.enabled
      ? `Checking ${r.fields.map(titleCase).join(', ')}${r.source === 'auto' ? ' (automatic)' : ''}`
      : r.reason || 'Not checking'

  return (
    <div className='space-y-1.5' data-duplicate-check-setting={mode}>
      <div className='flex items-start justify-between gap-4'>
        <div className='min-w-0'>
          <p
            id={`dup-title-${id}`}
            className='text-[12.5px] font-medium text-slate-700 dark:text-foreground'
          >
            Warn about duplicates
          </p>
          <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            While someone creates a record, show existing records with the same name under the
            field. Auto covers small lists whose label is one text field.
          </p>
          {status && (
            <p
              className={cn(
                'mt-0.5 text-[11.5px]',
                r?.enabled
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : 'text-slate-500 dark:text-muted-foreground'
              )}
              data-duplicate-check-status
            >
              {status}
            </p>
          )}
        </div>
        <fieldset className='inline-flex shrink-0 rounded-md border border-slate-200 bg-slate-50 p-0.5 dark:border-border dark:bg-muted/40'>
          <legend className='sr-only'>Warn about duplicates</legend>
          {MODES.map((m) => (
            <button
              key={m.value}
              type='button'
              aria-pressed={mode === m.value}
              onClick={() => mode !== m.value && setMode(m.value)}
              className={cn(
                'rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60',
                mode === m.value
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-card dark:text-foreground'
                  : 'text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
              )}
            >
              {m.label}
            </button>
          ))}
        </fieldset>
      </div>
      {mode === 'on' && textFields.length > 0 && (
        <fieldset
          className='m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0'
          aria-labelledby={`dup-title-${id}`}
        >
          <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>On:</span>
          {picked.length === 0 && (
            <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              the fields in the label
            </span>
          )}
          {picked.map((f) => (
            <span
              key={f}
              className='inline-flex h-6 items-center gap-1 rounded-md border border-slate-200 bg-slate-50 pl-2 pr-1 text-[12px] text-slate-700 dark:border-border dark:bg-muted/40 dark:text-foreground'
            >
              {titleCase(f)}
              <button
                type='button'
                onClick={() => toggle(f)}
                aria-label={`Stop comparing ${titleCase(f)}`}
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
            <PopoverContent align='start' className='w-[260px] p-0'>
              <Command>
                <CommandInput placeholder='Find a text field…' className='h-8 text-[12.5px]' />
                <CommandList>
                  <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
                    No text field matches
                  </CommandEmpty>
                  <CommandGroup>
                    {textFields.map((f) => (
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
      )}
      {mode !== 'off' && (
        <div className='flex items-center justify-between gap-4 pl-3'>
          <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            Block exact copies — saving a record with the same name as an existing one is refused
          </p>
          <Switch
            checked={value?.block_exact === true}
            onCheckedChange={(v) => commit({ ...value, block_exact: v })}
            aria-label='Block exact copies'
          />
        </div>
      )}
    </div>
  )
}
