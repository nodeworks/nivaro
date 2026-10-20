import { useQuery } from '@tanstack/react-query'
import { Check, ChevronsUpDown } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../../lib/utils'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '../../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { useEditorApi } from './editor-api'

export function LayoutPicker({
  collection,
  value,
  onChange,
  layoutType
}: {
  collection?: string | null
  value: number | null
  onChange: (id: number | null, slug: string | null) => void
  layoutType?: 'grouped' | 'table'
}) {
  const api = useEditorApi()
  const [open, setOpen] = useState(false)
  const { data: allLayouts = [] } = useQuery({
    queryKey: ['collection-layouts-list', collection],
    queryFn: () =>
      api
        .get<{
          data: Array<{ id: number; name: string; slug: string | null; layout_type?: string }>
        }>(`/collection-layouts?collection=${collection}`)
        .then((r) => r.data.data ?? []),
    enabled: !!collection,
    staleTime: 60_000
  })
  const layouts = layoutType
    ? allLayouts.filter((l) => (l.layout_type ?? 'grouped') === layoutType)
    : allLayouts
  const selected = layouts.find((l) => l.id === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='flex h-7 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-2 text-[11px] text-slate-700 hover:bg-muted dark:border-border dark:bg-background dark:text-foreground'
        >
          <span className={selected ? '' : 'text-slate-400'}>
            {selected ? selected.name : 'Select layout…'}
          </span>
          <ChevronsUpDown className='h-3 w-3 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-52 p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search layouts…' className='h-7 text-[11px]' />
          <CommandList>
            <CommandEmpty className='py-2 text-center text-[11px] text-slate-400'>
              No layouts
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                value=''
                onSelect={() => {
                  onChange(null, null)
                  setOpen(false)
                }}
                className='text-[11px] text-slate-400'
              >
                None
              </CommandItem>
              {layouts.map((l) => (
                <CommandItem
                  key={l.id}
                  value={l.name}
                  onSelect={() => {
                    onChange(l.id, l.slug ?? null)
                    setOpen(false)
                  }}
                  className='text-[11px]'
                >
                  <Check
                    className={cn(
                      'mr-1.5 h-3 w-3 shrink-0',
                      value === l.id ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {l.name}
                  {l.slug && (
                    <span className='ml-1.5 font-mono text-[11px] text-slate-400'>{l.slug}</span>
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
