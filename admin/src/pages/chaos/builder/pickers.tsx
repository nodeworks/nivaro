import { useQuery } from '@tanstack/react-query'
import { Check, ChevronsUpDown } from 'lucide-react'
import { type ReactNode, useState } from 'react'
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
import { builderKeys, fetchRouteChoices, fetchTableChoices } from './api'
import { routePattern } from './model'

/**
 * Pickers for the builder (#2844): one searchable Combobox (Popover + Command — never a native
 * select) and the route / table / replica / sampler choices built on it. `allowCustom` lets a
 * typed value stand when nothing in the list fits (a route pattern nobody has called yet).
 */

export interface Choice {
  value: string
  label: string
  hint?: string
  mono?: boolean
}

export function ChoiceCombobox({
  value,
  onChange,
  choices,
  placeholder = 'Choose…',
  searchPlaceholder = 'Search…',
  emptyText = 'Nothing matches',
  allowCustom,
  loading,
  ariaLabel,
  className,
  renderValue
}: {
  value: string
  onChange: (v: string) => void
  choices: Choice[]
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  /** Offer "Use <typed>" for a value outside the list; the function validates it. */
  allowCustom?: (typed: string) => boolean
  loading?: boolean
  ariaLabel: string
  className?: string
  renderValue?: (c: Choice | null, value: string) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const selected = choices.find((c) => c.value === value) ?? null
  const custom = typed.trim()
  const offerCustom =
    !!allowCustom &&
    custom !== '' &&
    !choices.some((c) => c.value === custom) &&
    allowCustom(custom)
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setTyped('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='outline'
          role='combobox'
          aria-expanded={open}
          aria-label={ariaLabel}
          className={cn(
            'h-8 w-full justify-between gap-2 px-2.5 text-[12.5px] font-normal',
            selected?.mono && 'font-mono text-[12px]',
            className
          )}
        >
          <span className={cn('min-w-0 truncate', !value && 'text-muted-foreground')}>
            {renderValue
              ? renderValue(selected, value)
              : (selected?.label ?? (value || placeholder))}
          </span>
          <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 opacity-50' aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[min(420px,calc(100vw-32px))] p-0' align='start'>
        <Command>
          <CommandInput
            placeholder={searchPlaceholder}
            value={typed}
            onValueChange={setTyped}
            className='h-8 text-[12.5px]'
          />
          <CommandList className='max-h-[300px]'>
            <CommandEmpty className='px-3 py-3 text-[12px] text-muted-foreground'>
              {loading ? 'Loading…' : offerCustom ? null : emptyText}
            </CommandEmpty>
            {offerCustom && (
              <CommandGroup>
                <CommandItem
                  value={`__custom__${custom}`}
                  onSelect={() => {
                    onChange(custom)
                    setOpen(false)
                  }}
                  className='text-[12.5px]'
                >
                  Use <span className='ml-1 font-mono text-[12px]'>{custom}</span>
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup>
              {choices.map((c) => (
                <CommandItem
                  key={c.value}
                  value={`${c.label} ${c.value}`}
                  onSelect={() => {
                    onChange(c.value)
                    setOpen(false)
                  }}
                  className='gap-2 text-[12.5px]'
                >
                  <Check
                    className={cn(
                      'h-3.5 w-3.5 shrink-0',
                      value === c.value ? 'opacity-100' : 'opacity-0'
                    )}
                    aria-hidden
                  />
                  <span
                    className={cn('min-w-0 flex-1 truncate', c.mono && 'font-mono text-[12px]')}
                  >
                    {c.label}
                  </span>
                  {c.hint && (
                    <span className='shrink-0 text-[11px] tabular-nums text-muted-foreground'>
                      {c.hint}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

const ROUTE_RE = /^\/[\w./*:-]{0,200}$/

/** Route patterns from the Traffic Map's last 15 minutes, or a typed pattern. */
export function RouteCombobox({
  value,
  onChange
}: {
  value: string
  onChange: (v: string) => void
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: builderKeys.routes,
    queryFn: fetchRouteChoices,
    staleTime: 60_000,
    retry: false
  })
  const byPattern = new Map<string, number>()
  for (const r of data ?? []) {
    const p = routePattern(r.template)
    byPattern.set(p, (byPattern.get(p) ?? 0) + r.n)
  }
  const choices: Choice[] = [...byPattern.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => ({ value: p, label: p, hint: `${n} calls`, mono: true }))
  return (
    <ChoiceCombobox
      ariaLabel='Route pattern'
      value={value}
      onChange={onChange}
      choices={choices}
      loading={isLoading}
      placeholder='Pick a route or type a pattern'
      searchPlaceholder='/api/items/* …'
      emptyText={
        isError
          ? 'The Traffic Map did not answer. Type a pattern like /api/items/*'
          : 'No traffic seen in the last 15 minutes. Type a pattern like /api/items/*'
      }
      allowCustom={(t) => ROUTE_RE.test(t)}
      renderValue={(_c, v) => (v ? <span className='font-mono text-[12px]'>{v}</span> : null)}
    />
  )
}

export function TableCombobox({
  value,
  onChange
}: {
  value: string
  onChange: (v: string) => void
}) {
  const { data, isLoading } = useQuery({
    queryKey: builderKeys.tables,
    queryFn: fetchTableChoices,
    staleTime: 5 * 60_000
  })
  const choices: Choice[] = (data ?? [])
    .slice()
    .sort((a, b) => a.localeCompare(b))
    .map((t) => ({ value: t, label: t, mono: true }))
  return (
    <ChoiceCombobox
      ariaLabel='Table'
      value={value}
      onChange={onChange}
      choices={choices}
      loading={isLoading}
      placeholder='Pick a table'
      searchPlaceholder='Search tables…'
      allowCustom={(t) => /^[\w.]{1,128}$/.test(t)}
      renderValue={(_c, v) => (v ? <span className='font-mono text-[12px]'>{v}</span> : null)}
    />
  )
}
