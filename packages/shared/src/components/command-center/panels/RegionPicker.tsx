import { Check, ChevronsUpDown, MapPin } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../../lib/utils'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { useCc } from '../state'
import { FOCUS } from '../theme'

/**
 * CC-7 — header region focus. "Everywhere" or one region the caller may read (from /config).
 * Picking one sets the board's region lens (every read narrows to it) and flies the map there.
 * Hidden when the instance has no regions.
 */
export function RegionPicker() {
  const cc = useCc()
  const [open, setOpen] = useState(false)
  const regions = cc.config?.regions ?? []
  if (regions.length === 0) return null
  const noun = cc.config?.region_label ?? 'Region'
  const current = cc.region ? regions.find((r) => r.id === cc.region) : null
  // A wallboard shows the region its link opens on, read-only, and offers no other choice.
  if (cc.kiosk) {
    if (!current) return null
    return (
      <span className='inline-flex items-center gap-1.5 rounded-full border border-nvr-cyan bg-nvr-cyan/15 px-2.5 py-0.5 text-[12px] font-medium text-[var(--cc-strong)]'>
        <MapPin className='h-3.5 w-3.5' aria-hidden='true' />
        <span className='sr-only'>{noun}: </span>
        {current.label}
      </span>
    )
  }
  const pick = (id: string | null) => {
    cc.setRegion(id)
    setOpen(false)
    const r = id ? regions.find((x) => x.id === id) : null
    if (r && r.lat != null && r.lng != null) cc.focusMap({ lat: r.lat, lng: r.lng, zoom: 8 })
    else if (!id) {
      const placed = regions.filter((x) => x.lat != null && x.lng != null)
      if (placed.length > 0) {
        const lat = placed.reduce((s, x) => s + (x.lat as number), 0) / placed.length
        const lng = placed.reduce((s, x) => s + (x.lng as number), 0) / placed.length
        cc.focusMap({ lat, lng, zoom: 4 })
      }
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-cc-region-picker=''
          aria-label={`${noun} focus: ${current ? current.label : 'everywhere'}`}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px]',
            FOCUS,
            current
              ? 'border-nvr-cyan bg-nvr-cyan/15 font-medium text-[var(--cc-strong)]'
              : 'border-[var(--cc-border)] text-[var(--cc-text)] hover:bg-[var(--cc-chip)]'
          )}
        >
          <MapPin className='h-3.5 w-3.5' aria-hidden='true' />
          {current ? current.label : 'Everywhere'}
          <ChevronsUpDown className='h-3 w-3 opacity-60' aria-hidden='true' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[240px] p-0' align='start'>
        <Command>
          <CommandInput placeholder={`Find a ${noun.toLowerCase()}…`} className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No {noun.toLowerCase()} matches
            </CommandEmpty>
            <CommandItem value='everywhere all' onSelect={() => pick(null)} className='text-[12px]'>
              <Check className={cn('mr-2 h-3 w-3', !cc.region ? 'opacity-100' : 'opacity-0')} />
              Everywhere
            </CommandItem>
            {regions.map((r) => (
              <CommandItem
                key={r.id}
                value={`${r.label} ${r.id}`}
                onSelect={() => pick(r.id)}
                className='text-[12px]'
              >
                <Check
                  className={cn('mr-2 h-3 w-3', cc.region === r.id ? 'opacity-100' : 'opacity-0')}
                />
                <span className='flex-1 truncate'>{r.label}</span>
                {r.lat == null && (
                  <span className='text-[10.5px] text-muted-foreground'>not on map</span>
                )}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
