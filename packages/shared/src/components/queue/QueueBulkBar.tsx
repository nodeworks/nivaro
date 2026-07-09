import { ArrowRight, X } from 'lucide-react'
import { useState } from 'react'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

export function QueueBulkBar({
  count,
  states,
  busy,
  claimsEnabled = true,
  onClaim,
  onRelease,
  onTransition,
  onClear
}: {
  count: number
  states: Array<{ value: string; label: string }>
  busy: boolean
  claimsEnabled?: boolean
  onClaim: () => void
  onRelease: () => void
  onTransition: (state: string) => void
  onClear: () => void
}) {
  const [transitionOpen, setTransitionOpen] = useState(false)

  if (count === 0) return null

  return (
    <div className='fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-full border border-slate-200 bg-white px-4 py-2 shadow-lg dark:border-border dark:bg-card'>
      <span className='mr-2 text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
        {count} selected
      </span>
      {claimsEnabled && (
        <>
          <button
            type='button'
            disabled={busy}
            onClick={onClaim}
            className='rounded-md px-2.5 py-1 text-[12px] font-medium text-nvr-navy hover:bg-nvr-cyan/10 disabled:opacity-50 dark:text-nvr-cyan'
          >
            Claim
          </button>
          <button
            type='button'
            disabled={busy}
            onClick={onRelease}
            className='rounded-md px-2.5 py-1 text-[12px] font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-muted'
          >
            Release
          </button>
        </>
      )}
      <Popover open={transitionOpen} onOpenChange={setTransitionOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            disabled={busy || states.length === 0}
            className='flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-muted'
          >
            Transition <ArrowRight className='h-3 w-3' />
          </button>
        </PopoverTrigger>
        <PopoverContent className='w-[200px] p-0' align='center' side='top'>
          <Command>
            <CommandInput placeholder='Target state…' className='h-8 text-[12px]' />
            <CommandList>
              <CommandEmpty>No state found.</CommandEmpty>
              {states.map((s) => (
                <CommandItem
                  key={s.value}
                  value={s.label}
                  onSelect={() => {
                    setTransitionOpen(false)
                    onTransition(s.value)
                  }}
                >
                  {s.label}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <button
        type='button'
        onClick={onClear}
        className='ml-1 rounded-full p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'
        aria-label='Clear selection'
      >
        <X className='h-3.5 w-3.5' />
      </button>
    </div>
  )
}
