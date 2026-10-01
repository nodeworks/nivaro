import { Check, ChevronsUpDown, UserRound } from 'lucide-react'
import { useMemo, useState } from 'react'
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
import { useTrafficMap } from '../context'
import { callerLabel, fmtCount } from '../EventTicker'
import type { InspectorData } from '../Inspector'
import { inspectorActions } from '../registry/inspectorActions'
import { register } from '../registry/registry'
import type { Selection } from '../types'
import { inPage } from './b1-shared'

/**
 * #1095 — break an entity down by caller: a picker in the inspector header narrows the entity's
 * figures, sparkline and recent events to one caller (exact per entity × caller counts from the
 * entity-callers tap). The page's own caller filter narrows it too when nothing is picked here.
 */
const BTN =
  'inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-[var(--tm-line)] bg-[var(--tm-card)] px-2 text-[12px] font-medium text-[var(--tm-fg-2)] transition-colors duration-150 ease-out hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'

function CallerFocus({ sel, d }: { sel: Selection; d: InspectorData }) {
  const { model, catalog, win, tick, setSelection, filters } = useTrafficMap()
  const [open, setOpen] = useState(false)
  const id = sel.id
  const picked = sel.kind === 'entity' ? sel.caller : undefined
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick forces a re-read of the mutable model
  const callers = useMemo(() => model.entityCallerKeys(id, win), [model, id, win, tick])
  const focus = d.focusCaller
  const fromPage = !!focus && !picked
  if (!model.exactCallers) return null
  const choose = (caller: string | undefined) => {
    setOpen(false)
    setSelection({ kind: 'entity', id, ...(caller ? { caller } : {}) })
  }
  return (
    <div className='flex min-w-0 items-center gap-1.5' data-tm-caller-focus={focus ?? ''}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            id='tm-caller-focus'
            className={cn(BTN, focus && 'text-[var(--tm-accent-ink)]')}
            aria-label='Narrow to one caller'
          >
            <UserRound className='h-3.5 w-3.5 shrink-0' aria-hidden='true' />
            <span className='truncate'>
              {focus ? `${callerLabel(catalog, focus)} only` : 'All callers'}
            </span>
            <ChevronsUpDown className='h-3 w-3 shrink-0 opacity-60' aria-hidden='true' />
          </button>
        </PopoverTrigger>
        <PopoverContent className='w-[260px] p-0' align='start'>
          <Command>
            <CommandInput placeholder='Find a caller…' className='h-8 text-[12px]' />
            <CommandList>
              <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
                No caller in this window.
              </CommandEmpty>
              <CommandGroup>
                <CommandItem
                  value='__all__ every caller'
                  onSelect={() => choose(undefined)}
                  className='text-[12px]'
                >
                  <Check
                    className={cn('mr-1.5 h-3.5 w-3.5', picked ? 'opacity-0' : 'opacity-100')}
                  />
                  All callers
                </CommandItem>
                {callers.map((c) => (
                  <CommandItem
                    key={c.key}
                    value={`${c.key} ${callerLabel(catalog, c.key)}`}
                    onSelect={() => choose(c.key)}
                    className='text-[12px]'
                    data-tm-caller-option={c.key}
                  >
                    <Check
                      className={cn(
                        'mr-1.5 h-3.5 w-3.5',
                        picked === c.key ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    <span className='min-w-0 flex-1 truncate'>
                      {c.key === '__other__' ? 'Other callers' : callerLabel(catalog, c.key)}
                    </span>
                    <span className='ml-2 tabular-nums text-muted-foreground'>{fmtCount(c.n)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {fromPage && filters.caller ? (
        <span className='truncate text-[11.5px] text-[var(--tm-muted)]'>
          from the page's caller filter
        </span>
      ) : null}
    </div>
  )
}

register(inspectorActions, {
  id: 'entity-caller-focus',
  order: 10,
  applies: (sel) => sel.kind === 'entity' && !sel.id.endsWith('/__background__'),
  Component: inPage(CallerFocus)
})
